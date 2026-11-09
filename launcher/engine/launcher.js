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
const { spawnOptions, killTree } = require('./crash/reaper.cjs');

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

    // 0.7.0 模块四：detached=true 让 JVM 成为独立进程组 leader，
    // 退出/异常时 killTree 可用 process.kill(-pid) 一次回收 Java 及其所有子进程。
    const child = spawn(javaPath, args, spawnOptions({
      cwd: o.gameDir,
      env: { ...process.env, ...(o.envVars || {}) },
      stdio: ['pipe', 'pipe', 'pipe']
    }));
    this.process = child;
    this.running = true;
    this.startTime = Date.now();

    // 携带 stream 来源：崩溃守护器对 stderr 的致命特征更敏感（JVM 错误全在 stderr）。
    const onData = (stream) => (buf) => {
      const text = buf.toString('utf8');
      this._pushRaw(text);
      // 按行分发
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        if (line.length === 0) continue;
        this.emit('log', { level: classifyLine(line), text: stripAnsi(line), stream });
      }
    };
    child.stdout.on('data', onData('stdout'));
    child.stderr.on('data', onData('stderr'));

    // 只发一次退出：spawn 失败(ENOENT) 时 Node 只发 error + close，不发 exit；
    // 正常退出时 exit 与 close 都会到。用 finished 去重，保证 UI 必然离开「启动中」。
    let finished = false;
    const finishOnce = (code, signal, extra = {}) => {
      if (finished) return;
      finished = true;
      this.running = false;
      const dur = ((Date.now() - this.startTime) / 1000).toFixed(1);
      this.emit('log', { level: 'info', text: `[MC-Next] 进程退出 code=${code} signal=${signal} 运行 ${dur}s`, stream: 'stdout' });
      this.emit('exit', { code, signal, duration: dur, ...extra });
    };

    child.on('error', (err) => {
      this.emit('log', { level: 'error', text: `[MC-Next] 进程错误: ${err.message}`, stream: 'stderr' });
      // 关键修复：补发 exit，否则 spawn 失败时前端永远停在「启动中」。
      finishOnce(-1, null, { error: err.message, spawnFailed: true });
      if (this.listenerCount('error') > 0) this.emit('error', err);
    });
    child.on('exit', (code, signal) => finishOnce(code, signal));
    child.on('close', (code, signal) => finishOnce(code, signal));

    // stdin 支持（服务端命令注入）
    if (child.stdin) child.stdin.on('error', () => {});
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

  /** 终止整棵进程树（先 TERM，超时 SIGKILL 强杀整组，避免残留 Java 子进程） */
  async kill(graceMs = 8000) {
    if (!this.process || !this.running) return;
    const child = this.process;
    this.intentionalStop = true; // 用户主动停止 → 守护器不产生崩溃弹窗
    const exited = new Promise(resolve => child.once('exit', resolve));
    killTree({ child, pid: child.pid, signal: 'SIGTERM' });
    const timer = setTimeout(() => {
      try { killTree({ child, pid: child.pid, signal: 'SIGKILL', force: true }); } catch {}
    }, graceMs);
    if (timer.unref) timer.unref();
    await exited;
    this.running = false;
  }

  getLogs() { return this._logBuffer.join(''); }
}

module.exports = { GameLauncher, stripAnsi, classifyLine };
