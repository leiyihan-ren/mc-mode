/**
 * console.cjs — 硬核服务端终端日志控制台
 *
 * 真实能力：
 *  - 解析 log4j 服务端日志：[HH:mm:ss] [Thread/LEVEL] [logger/]: message
 *  - ANSI SGR 彩色码还原为 HTML（带 XSS 转义），终端彩色高亮
 *  - 子进程 stdout/stderr 双流采集、环形缓冲、结构化日志事件
 *  - 后台指令下发（/stop、/op、/whitelist...）并回显到控制台
 *  - 日志过滤、导出纯文本 / 彩色 HTML、优雅停止与强制 kill
 */
'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const ANSI_RE = /\x1b\[([0-9;]*)m/g;
const LOG4J_RE = /^\[(\d{1,2}:\d{2}:\d{2})\]\s*\[([^\]/]+)\/([A-Z]+)\](?:\s*\[([^\]]+)\])?\s*:\s?(.*)$/;
const SGR_COLORS = {
  30: '#4f5459', 31: '#e06c75', 32: '#98c379', 33: '#d19a66', 34: '#61afef',
  35: '#c678dd', 36: '#56b6c2', 37: '#abb2bf', 90: '#5c6370', 91: '#ff7b86',
  92: '#b5e890', 93: '#e5c07b', 94: '#7cbcff', 95: '#d98fe8', 96: '#7fe3ea', 97: '#ffffff'
};

function stripAnsi(s) { return String(s).replace(ANSI_RE, ''); }
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** ANSI SGR → 安全 HTML（颜色 + 粗体 + 下划线） */
function ansiToHtml(raw) {
  let out = '', open = 0, last = 0, m;
  ANSI_RE.lastIndex = 0;
  while ((m = ANSI_RE.exec(raw)) !== null) {
    out += escapeHtml(raw.slice(last, m.index));
    last = ANSI_RE.lastIndex;
    for (const code of m[1].split(';').filter(Boolean).map(Number)) {
      if (code === 0) { while (open > 0) { out += '</span>'; open--; } }
      else if (SGR_COLORS[code]) { out += `<span style="color:${SGR_COLORS[code]}">`; open++; }
      else if (code === 1) { out += '<span style="font-weight:700">'; open++; }
      else if (code === 4) { out += '<span style="text-decoration:underline">'; open++; }
    }
  }
  out += escapeHtml(raw.slice(last));
  while (open > 0) { out += '</span>'; open--; }
  return out;
}

/** 解析一行真实 MC 服务端日志 */
function parseLogLine(raw) {
  const line = String(raw).replace(/\r$/, '');
  const text = stripAnsi(line);
  const m = LOG4J_RE.exec(text);
  return {
    raw: line, text,
    time: m ? m[1] : null,
    thread: m ? m[2] : null,
    level: m ? m[3].toLowerCase() : 'info',
    logger: m ? (m[4] || null) : null,
    message: m ? m[5] : text,
    ansi: line !== text
  };
}

/** 提取行首着色 SGR 码（MC 常见做法：整行包裹颜色，末尾 reset） */
function leadingColorCode(raw) {
  const m = /\x1b\[([0-9;]*)m/.exec(raw);
  if (!m) return '';
  const codes = m[1].split(';').filter(Boolean).map(Number).filter(n => n !== 0);
  return codes.length ? `\x1b[${codes.join(';')}m` : '';
}

/** 一行日志 → 彩色 HTML 片段（带 XSS 转义） */
function highlight(raw) {
  const p = parseLogLine(raw);
  const head = [
    p.time ? `<span class="mc-log-time">[${escapeHtml(p.time)}]</span>` : '',
    p.thread ? `<span class="mc-log-thread">[${escapeHtml(p.thread)}/${escapeHtml(p.level.toUpperCase())}]</span>` : '',
    p.logger ? `<span class="mc-log-logger">[${escapeHtml(p.logger)}]</span>` : ''
  ].filter(Boolean).join(' ');
  const color = leadingColorCode(raw);
  const body = ansiToHtml(color + p.message + (color ? '\x1b[0m' : ''));
  return `<div class="mc-log-line mc-log-${p.level}">${head}${head ? ' ' : ''}${body}</div>`;
}

function hhmmss() { return new Date().toTimeString().slice(0, 8); }

class ServerConsole extends EventEmitter {
  /**
   * @param {object} opts {workDir, command, args, javaPath, jvmArgs, jar, maxLines, env}
   */
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.workDir = opts.workDir || process.cwd();
    this.command = opts.command || opts.javaPath || 'java';
    this.args = opts.args || [
      ...(opts.jvmArgs || ['-Xms1G', '-Xmx4G']),
      '-Dfile.encoding=UTF-8',
      '-jar', opts.jar || 'server.jar', 'nogui'
    ];
    this.maxLines = opts.maxLines || 4000;
    this.lines = [];
    this.child = null;
    this.running = false;
    this.startedAt = null;
    this.exitInfo = null;
  }

  _push(entry) {
    entry.seq = this._seq = (this._seq || 0) + 1;
    this.lines.push(entry);
    if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines);
    this.emit('log', entry);
    return entry;
  }

  _attach(stream, source) {
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (raw) => {
      const e = parseLogLine(raw);
      e.source = source;
      this._push(e);
    });
    return rl;
  }

  start() {
    if (this.child) throw new Error('服务端已在运行');
    fs.mkdirSync(this.workDir, { recursive: true });
    const child = spawn(this.command, this.args, {
      cwd: this.workDir,
      env: { ...process.env, ...(this.opts.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child = child;
    this.running = true;
    this.startedAt = Date.now();
    this._attach(child.stdout, 'stdout');
    this._attach(child.stderr, 'stderr');
    child.on('error', (err) => {
      this._push({ ...parseLogLine(`[${hhmmss()}] [Launcher/ERROR]: 进程启动失败: ${err.message}`), source: 'launcher' });
      this.emit('error', err);
    });
    child.on('exit', (code, signal) => {
      this.running = false;
      this.exitInfo = { code, signal, at: Date.now() };
      this._push({ ...parseLogLine(`[${hhmmss()}] [Launcher/INFO]: 服务端已退出 (code=${code}, signal=${signal || 'none'})`), source: 'launcher' });
      this.emit('exit', this.exitInfo);
    });
    return this;
  }

  /** 发送后台指令，返回是否写入成功 */
  sendCommand(command) {
    const clean = String(command || '').trim().replace(/^\//, '');
    if (!clean) return false;
    if (!this.child || !this.child.stdin || !this.child.stdin.writable) return false;
    this.child.stdin.write(clean + '\n');
    this._push({
      ...parseLogLine(`[${hhmmss()}] [Console/COMMAND]: /${clean}`),
      source: 'stdin', command: true
    });
    return true;
  }

  /** 优雅停止：/stop → 超时后 SIGTERM → 再超时 SIGKILL */
  stop(graceMs = 5000) {
    if (!this.running) return Promise.resolve(this.exitInfo);
    const ok = this.sendCommand('stop');
    return new Promise((resolve) => {
      const done = (info) => { clearTimeout(t1); clearTimeout(t2); resolve(info); };
      const t1 = setTimeout(() => {
        if (this.running && this.child) { this.child.kill('SIGTERM'); this.emit('forceStop', 'SIGTERM'); }
      }, ok ? graceMs : 0);
      const t2 = setTimeout(() => {
        if (this.running && this.child) { this.child.kill('SIGKILL'); this.emit('forceStop', 'SIGKILL'); }
      }, (ok ? graceMs : 0) + 3000);
      this.once('exit', done);
    });
  }

  kill(signal = 'SIGTERM') {
    if (this.child && this.running) { this.child.kill(signal); return true; }
    return false;
  }

  status() {
    return {
      running: this.running, pid: this.child ? this.child.pid : null,
      startedAt: this.startedAt, uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      lines: this.lines.length, exitInfo: this.exitInfo,
      command: this.command, args: this.args
    };
  }

  /** 结构化过滤 */
  logs(opts = {}) {
    const { level, query, since, limit } = opts;
    let out = this.lines;
    if (level) out = out.filter(l => l.level === String(level).toLowerCase());
    if (query) {
      const q = String(query).toLowerCase();
      out = out.filter(l => l.text.toLowerCase().includes(q));
    }
    if (since) out = out.filter(l => l.seq > since);
    if (limit) out = out.slice(-limit);
    return out;
  }

  exportText(dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, this.lines.map(l => l.raw).join('\n') + '\n');
    return dest;
  }

  exportHtml(dest, title = 'MC-Next 服务端日志') {
    const body = this.lines.map(l => highlight(l.raw)).join('\n');
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{background:#12151a;color:#d6dae0;font:13px/1.55 ui-monospace,Menlo,Consolas,monospace;padding:16px}
.mc-log-line{white-space:pre-wrap;word-break:break-all}.mc-log-time{color:#6b7280}.mc-log-thread{color:#61afef}
.mc-log-logger{color:#8b949e}.mc-log-warn .mc-log-thread{color:#d19a66}.mc-log-error .mc-log-thread,.mc-log-fatal .mc-log-thread{color:#e06c75}
.mc-log-command .mc-log-thread{color:#c678dd}.mc-log-error{background:rgba(224,108,117,.08)}</style></head><body>
<h3>${escapeHtml(title)}</h3>${body}</body></html>`;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, html);
    return dest;
  }
}

module.exports = {
  ANSI_RE, LOG4J_RE, stripAnsi, escapeHtml, ansiToHtml, parseLogLine, highlight, ServerConsole
};
