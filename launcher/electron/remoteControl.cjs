/**
 * electron/remoteControl.cjs — 局域网远程控制服务（手机遥控器被控端）
 *
 * 手机端 MC-Next APK（同一 WiFi）通过 HTTP 调用本服务：
 *   GET  /api/status   → { running, serverRunning, version }
 *   GET  /api/clients  → { clients: [版本...], loaders: {版本: [加载器文件...] } }
 *   GET  /api/logs     → { logs: [{t,level,text}...] }
 *   POST /api/launch   body { versionId, loader?, playerName? }
 *   POST /api/stop
 *   POST /api/command  body { text }  （向游戏/服务端 stdin 写命令）
 *   POST /api/server-command
 *
 * 安全边界：仅监听局域网（0.0.0.0:25300），无鉴权——同网段内可控制。
 */
'use strict';

const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises; // 0.9.0 模块二A：HTTP handler 内同步 IO 全部异步化，不阻塞主进程事件循环
const { state, launchGameCore, logBuf, dispatchChannel, hasChannel } = require('./ipc.cjs');
const { INVOKE_CHANNELS } = require('../engine/bridge/contract.cjs');

const APP_VERSION = (() => {
  try { return require('../package.json').version; } catch { return '0.0.0'; }
})();

const PORT = 25300;
const REPO_CLIENT = '/workspace/MC正式版客户端';

/** 枚举本机局域网 IPv4（供 UI 展示配对地址） */
function localIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', d => { data += d; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') { json(res, 204, {}); return; }
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/api/status') {
      json(res, 200, {
        ok: true,
        app: 'MC-Next',
        version: APP_VERSION,
        running: !!(state.game && state.game.running),
        serverRunning: !!(state.server && !state.server.killed),
        ips: localIPs()
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/clients') {
      const clients = (await fsp.readdir(REPO_CLIENT)).filter(f => f.endsWith('.jar')).map(f => f.replace(/\.jar$/, '')).sort().reverse();
      json(res, 200, { ok: true, clients });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/logs') {
      json(res, 200, { ok: true, logs: logBuf });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/launch') {
      const body = await readBody(req);
      if (!body.versionId) { json(res, 400, { ok: false, error: '缺少 versionId' }); return; }
      const versionJsonPath = path.join(os.homedir(), '.mc-next', 'versions', `${body.versionId}.json`);
      let versionJson = null;
      try {
        versionJson = JSON.parse(await fsp.readFile(versionJsonPath, 'utf8'));
      } catch {
        // 缓存缺失或损坏 → 走网络重新拉取（异步 read 替代 existsSync，语义更健壮）
        const { fetchJson } = require('../engine/http');
        versionJson = await fetchJson(`https://bmclapi2.bangbang93.com/version/${body.versionId}/json`, { timeoutMs: 30000 });
        await fsp.mkdir(path.dirname(versionJsonPath), { recursive: true });
        await fsp.writeFile(versionJsonPath, JSON.stringify(versionJson));
      }
      let extraJars = [];
      if (body.loader) {
        const p = path.join('/workspace/模组加载器', body.versionId, body.loader);
        try { await fsp.access(p); extraJars = [p]; } catch { /* 加载器不存在则忽略 */ }
      }
      const r = await launchGameCore({
        versionId: body.versionId,
        versionJson,
        javaPath: body.javaPath || 'java',
        minMemory: body.minMemory || '1G',
        maxMemory: body.maxMemory || '4G',
        playerName: body.playerName || 'Player',
        extraJars
      });
      json(res, 200, r);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/stop') {
      if (state.game) { await state.game.kill(); state.game = null; json(res, 200, { ok: true }); }
      else json(res, 200, { ok: false, error: '无运行中的游戏' });
      return;
    }

    if (req.method === 'POST' && (url.pathname === '/api/command' || url.pathname === '/api/server-command')) {
      const body = await readBody(req);
      const target = url.pathname === '/api/command' ? state.game : state.server;
      if (target && target.stdin && target.stdin.writable) {
        target.stdin.write((body.text || '') + '\n');
        json(res, 200, { ok: true });
      } else {
        json(res, 200, { ok: false, error: '进程未运行' });
      }
      return;
    }

    /**
     * 0.6.0 模块一：通用远程 RPC。
     * Android 大一统 UI 里所有「remote」落点的指令（76 条）都走这里，
     * 复用桌面 registerIpc 注册的**同一个真实 handler**，结果与桌面 IPC 完全一致。
     * 白名单来自 preload.cjs 自动生成的契约，拒绝任意未声明 channel。
     * 返回 result 为 JSON 字符串（与 Capacitor 插件返回格式统一）。
     */
    if (req.method === 'POST' && url.pathname === '/api/rpc') {
      const body = await readBody(req);
      const channel = String(body.channel || '');
      const args = Array.isArray(body.args) ? body.args : [];
      if (!channel) { json(res, 400, { ok: false, error: '缺少 channel' }); return; }
      if (!INVOKE_CHANNELS.includes(channel)) {
        json(res, 403, { ok: false, error: `非法 channel: ${channel}` }); return;
      }
      if (!hasChannel(channel)) {
        json(res, 503, { ok: false, error: `桌面端 IPC 尚未注册 ${channel}（主进程未就绪）` }); return;
      }
      const data = await dispatchChannel(channel, ...args);
      json(res, 200, { ok: true, result: JSON.stringify(data === undefined ? null : data) });
      return;
    }

    json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    json(res, 500, { ok: false, error: e.message });
  }
}

function startRemoteControl() {
  const server = http.createServer(handle);
  // 0.7.0 模块一：清掉散落的 console.log，错误走 stderr、状态走 stdout（可被宿主日志系统接管）
  server.on('error', (e) => {
    process.stderr.write(`[RemoteControl] 启动失败: ${e.message}\n`);
  });
  server.listen(PORT, '0.0.0.0', () => {
    const ips = localIPs().map(ip => `${ip}:${PORT}`).join(', ');
    process.stdout.write(`[RemoteControl] 手机遥控已就绪 → ${ips || `localhost:${PORT}`}\n`);
  });
  return server;
}

module.exports = { startRemoteControl, localIPs, PORT, handle };
