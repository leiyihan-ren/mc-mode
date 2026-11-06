/**
 * launcher.js — 一键启动：Java 子进程管理 + 实时日志捕获
 * 事件: log(line) / raw(data) / exit({code, signal}) / error(err)
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');
const { buildJvmArgs, extractNatives } = require('./jvmArgs');
const { defaultEnv } = require('./library');

/** ANSI 颜色剥离（日志存储/搜索用） */
function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

/** 按 MC 日志级别给行着色（供 UI 使用） */
function classifyLine(line) {
  const l = stripAnsi(line);
  if (/\bERROR\b|\bSEVERE\b|Exception|Caused by|\bat\s+\w+\./.test(l)) return 'error';
  if (/\bWARN\b|\bWARNING\b/.test(l)) return 'warn';
  if (/\bINFO\b/.test(l)) return 'info';
  if (/\[STDOUT\]|\[Thread-|Done \(|Preparing spawn|Loaded \d+ recipes/.test(l)) return 'success';
  return 'normal';
}

class GameLauncher extends EventEmitter {
  /**
   * @param {object} opts { versionJson, gameJarPath, classpath, gameDir, assetsDir, assetIndexId,
   *                         javaPath, minMemory, maxMemory, playerName, uuid, versionId, nativesDir }
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.process = null;
    this.running = false;
    this._logBuffer = [];
    this._maxBuffer = 5000;
  }

  /** 启动前准备：解压 natives */
  prepare() {
    const { versionJson, nativesDir } = this.opts;
    const env = this.opts.env || defaultEnv();
    if (versionJson && nativesDir) {
      const r = extractNatives(versionJson, nativesDir, env);
      this.emit('log', { level: 'info', text: `[MC-Next] natives 解压完成: ${r.extracted} 个文件` });
    }
    fs.mkdirSync(this.opts.gameDir, { recursive: true });
  }

  launch() {
    if (this.running) throw new Error('游戏已在运行');
    this.prepare();
    const o = this.opts;
    const { jvmArgs, gameArgs } = buildJvmArgs(o.versionJson, {
      classpath: o.classpath,
      nativesDir: o.nativesDir,
      gameDir: o.gameDir,
      assetsDir: o.assetsDir,
      assetIndexId: o.assetIndexId,
      playerName: o.playerName,
      uuid: o.uuid,
      versionId: o.versionId,
      versionType: o.versionType,
      minMemory: o.minMemory,
      maxMemory: o.maxMemory,
      extraJvmArgs: o.extraJvmArgs,
      quickPlayPath: o.quickPlayPath,
      env: o.env
    });

    const javaPath = o.javaPath || 'java';
    const args = [...jvmArgs, o.versionJson.mainClass, ...gameArgs];
    this.emit('log', { level: 'info', text: `[MC-Next] 启动: ${javaPath} ${args.slice(0, 6).join(' ')} ...` });

    const child = spawn(javaPath, args, {
      cwd: o.gameDir,
      env: { ...process.env, ...(o.envVars || {}) },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.process = child;
    this.running = true;
    this.startTime = Date.now();

    const onData = (stream) => (buf) => {
      const text = buf.toString('utf8');
      this._pushRaw(text);
      // 按行分发
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        if (line.length === 0) continue;
        this.emit('log', { level: classifyLine(line), text: stripAnsi(line) });
      }
    };
    child.stdout.on('data', onData('stdout'));
    child.stderr.on('data', onData('stderr'));

    child.on('error', (err) => {
      this.running = false;
      this.emit('error', err);
      this.emit('log', { level: 'error', text: `[MC-Next] 进程错误: ${err.message}` });
    });

    child.on('exit', (code, signal) => {
      this.running = false;
      const dur = ((Date.now() - this.startTime) / 1000).toFixed(1);
      this.emit('log', { level: 'info', text: `[MC-Next] 进程退出 code=${code} signal=${signal} 运行 ${dur}s` });
      this.emit('exit', { code, signal, duration: dur });
    });

    // stdin 支持（服务端命令注入）
    child.stdin.on('error', () => {});
    return child;
  }

  _pushRaw(text) {
    this._logBuffer.push(text);
    if (this._logBuffer.length > this._maxBuffer) {
      this._logBuffer.splice(0, this._logBuffer.length - this._maxBuffer);
    }
  }

  /** 向进程 stdin 写入命令（服务端用） */
  sendCommand(cmd) {
    if (this.process && this.process.stdin && this.running) {
      this.process.stdin.write(cmd + '\n');
      return true;
    }
    return false;
  }

  /** 终止进程（先温和 TERM，超时强杀） */
  async kill(graceMs = 8000) {
    if (!this.process || !this.running) return;
    const child = this.process;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, graceMs);
    if (timer.unref) timer.unref();
    await exited;
    this.running = false;
  }

  getLogs() { return this._logBuffer.join(''); }
}

module.exports = { GameLauncher, stripAnsi, classifyLine };
