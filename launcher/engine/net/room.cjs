'use strict';
/**
 * engine/net/room.cjs — 模块二：一键联机大厅（基于真实 EasyTier P2P VPN）
 *
 * 设计原则（不糊弄）：
 *  - 邀请码 = 房间参数（网络名/密钥/共享节点/虚拟网段）的可校验编码，绝不含「已连接」假状态
 *  - 虚拟 IP 只在 easytier-core 真实运行、且 easytier-cli -o json 回报后才给出
 *  - 所有子进程、CLI、文件 IO 可注入，离线单测不依赖真实网络
 *  - 公共共享节点地址可配置；未配置时依赖 EasyTier 局域网内建发现，跨网需用户填节点
 *
 * EasyTier CLI 参数已对 v2.6.4 真实二进制核验：
 *   core: --network-name / --network-secret / -i,--ipv4 / -d,--dhcp /
 *         -p,--peers / --hostname / -m,--instance-name / -r,--rpc-portal / -l,--listeners
 *   cli : -p,--rpc-portal / -o,--output json / node / peer / route / connector
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const cp = require('child_process');

const INVITE_PREFIX = 'MCET1';
const DEFAULT_SUBNET = '10.144.144';
const DEFAULT_RPC = '127.0.0.1:15888';
// EasyTier 官方社区公共节点（可在设置中替换为自己的公网节点或官方最新公告地址）
const DEFAULT_SHARED_NODES = ['tcp://public.easytier.cn:11010'];
const ROOMS_FILE = 'rooms.json';

// ---------------------------------------------------------------- 邀请码

/** 8 位校验和，防止手抄邀请码漏字符 */
function checksum(buf) {
  const h = crypto.createHash('sha256').update(buf).digest();
  return h.subarray(0, 4).toString('hex');
}

/** 房间参数 → 可分享邀请码（含网络密钥，请勿公开张贴） */
function encodeInvite(room) {
  const payload = {
    v: 1,
    n: room.networkName,
    s: room.networkSecret,
    p: room.sharedNodes || [],
    h: room.hostVirtualIp || null,
    m: room.mcVersion || null,
    t: room.createdAt || new Date().toISOString()
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  return `${INVITE_PREFIX}.${body.toString('base64url')}.${checksum(body)}`;
}

/** 邀请码 → 房间参数；校验失败/字段缺失一律抛错，不静默降级 */
function decodeInvite(code) {
  const s = String(code || '').trim().replace(/\s+/g, '');
  const parts = s.split('.');
  if (parts.length !== 3 || parts[0] !== INVITE_PREFIX) {
    throw new Error(`邀请码格式无效（应形如 ${INVITE_PREFIX}.xxxx.yyyy）`);
  }
  let body, payload;
  try {
    body = Buffer.from(parts[1], 'base64url');
    payload = JSON.parse(body.toString('utf8'));
  } catch (e) { throw new Error(`邀请码内容损坏：${e.message}`); }
  if (checksum(body) !== parts[2]) throw new Error('邀请码校验和不匹配（可能复制不完整）');
  if (payload.v !== 1) throw new Error(`不支持的邀请码版本：${payload.v}`);
  if (!payload.n || !payload.s) throw new Error('邀请码缺少网络名或网络密钥');
  return {
    networkName: String(payload.n),
    networkSecret: String(payload.s),
    sharedNodes: Array.isArray(payload.p) ? payload.p.filter(x => typeof x === 'string') : [],
    hostVirtualIp: payload.h || null,
    mcVersion: payload.m || null,
    createdAt: payload.t || null
  };
}

// ---------------------------------------------------------------- 房间模型

function randomToken(bytes = 12) { return crypto.randomBytes(bytes).toString('base64url'); }

/** 创建房间：生成真实随机的网络名/密钥，房主固定虚拟 IP .1 */
function createRoom(opts = {}) {
  const room = {
    id: opts.id || crypto.randomUUID(),
    role: 'host',
    networkName: opts.networkName || `mcnext-${crypto.randomBytes(4).toString('hex')}`,
    networkSecret: opts.networkSecret || randomToken(12),
    sharedNodes: opts.sharedNodes === undefined ? [...DEFAULT_SHARED_NODES] : [...opts.sharedNodes],
    subnet: opts.subnet || DEFAULT_SUBNET,
    hostVirtualIp: opts.hostVirtualIp || `${opts.subnet || DEFAULT_SUBNET}.1`,
    virtualIp: opts.hostVirtualIp || `${opts.subnet || DEFAULT_SUBNET}.1`,
    mcVersion: opts.mcVersion || null,
    createdBy: opts.createdBy || null,
    createdAt: new Date().toISOString(),
    rpcPortal: opts.rpcPortal || DEFAULT_RPC,
    instanceName: opts.instanceName || null
  };
  return { room, inviteCode: encodeInvite(room) };
}

/** 加入房间：从邀请码还原参数，本机 IP 交给 EasyTier DHCP 分配（不伪造） */
function joinRoom(inviteCode, opts = {}) {
  const cfg = decodeInvite(inviteCode);
  const room = {
    ...cfg,
    id: opts.id || crypto.randomUUID(),
    role: 'guest',
    virtualIp: null,
    subnet: cfg.hostVirtualIp ? cfg.hostVirtualIp.split('.').slice(0, 3).join('.') : DEFAULT_SUBNET,
    joinedAt: new Date().toISOString(),
    rpcPortal: opts.rpcPortal || DEFAULT_RPC,
    instanceName: opts.instanceName || null
  };
  return { room, inviteCode: String(inviteCode).trim() };
}

/**
 * 生成 easytier-core 真实命令行参数。
 * 房主用 -i 固定虚拟 IP；加入者用 -d（DHCP）由网络自动分配。
 */
function buildCoreArgs(room, opts = {}) {
  const args = ['--network-name', room.networkName, '--network-secret', room.networkSecret];
  if (room.role === 'host' && room.virtualIp) {
    args.push('-i', `${room.virtualIp}/24`);
  } else {
    args.push('-d');
  }
  for (const p of room.sharedNodes || []) args.push('-p', p);
  for (const p of opts.extraPeers || []) args.push('-p', p);
  const hostname = opts.hostname || (room.role === 'host' ? 'mcnext-host' : `mcnext-${randomToken(4).replace(/[^a-zA-Z0-9]/g, '')}`);
  args.push('--hostname', hostname);
  if (room.instanceName) args.push('-m', room.instanceName);
  if (room.rpcPortal) args.push('-r', room.rpcPortal);
  for (const l of opts.listeners || []) args.push('-l', l);
  if (opts.noTun) args.push('--no-tun');
  if (opts.logLevel) args.push('--console-log-level', opts.logLevel);
  return args;
}

// ---------------------------------------------------------------- CLI 输出解析

/** easytier-cli -o json 可能返回对象或数组；做容错但绝不编造字段 */
function parseCliJson(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* 某些版本输出 NDJSON */ }
  const lines = s.split(/\r?\n/).filter(Boolean);
  const objs = [];
  for (const l of lines) { try { objs.push(JSON.parse(l)); } catch { /* 忽略非 JSON 日志行 */ } }
  return objs.length ? (objs.length === 1 ? objs[0] : objs) : null;
}

function flattenRows(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return [];
  for (const k of ['peers', 'nodes', 'list', 'rows', 'data', 'result', 'items']) {
    if (Array.isArray(parsed[k])) return parsed[k];
  }
  // 形如 { "123456": {...} } 的 map
  const vals = Object.values(parsed).filter(v => v && typeof v === 'object' && !Array.isArray(v));
  if (vals.length && vals.every(v => 'hostname' in v || 'ipv4' in v || 'peer_id' in v)) return vals;
  return [parsed];
}

/** 从 `node` 子命令结果提取本机虚拟 IP；找不到就返回 null
 *  已对 EasyTier v2.6.4 真实输出核验：node 返回 { ipv4_addr: "10.144.144.1/24", ... }，
 *  peer 返回 [{ ipv4: "10.144.144.1", cidr: "10.144.144.1/24", ... }]。
 */
function extractVirtualIp(nodeParsed) {
  const rows = flattenRows(nodeParsed);
  for (const r of rows) {
    for (const k of ['ipv4_addr', 'ipv4', 'virtual_ipv4', 'virtual_ip', 'cidr', 'ip', 'my_ip', 'peer_ipv4']) {
      if (typeof r[k] === 'string') {
        const m = r[k].match(/\b(\d{1,3}(?:\.\d{1,3}){3})(?:\/\d+)?\b/);
        if (m) return m[1];
      }
    }
    if (r.addr || r.address) {
      const m = String(r.addr || r.address).match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
      if (m) return m[1];
    }
  }
  return null;
}

/** 从 `peer` 子命令结果提取已连接成员 */
function extractPeers(peerParsed) {
  const rows = flattenRows(peerParsed);
  return rows.map(r => ({
    id: r.peer_id ?? r.id ?? null,
    hostname: r.hostname || r.name || null,
    ipv4: (() => {
      const v = r.ipv4 || r.virtual_ipv4 || r.ip || null;
      if (typeof v === 'string') { const m = v.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/); return m ? m[1] : null; }
      return null;
    })(),
    cost: r.cost ?? r.latency ?? null,
    connected: r.connected ?? r.is_connected ?? null,
    raw: r
  })).filter(p => p.id != null || p.hostname || p.ipv4);
}

// ---------------------------------------------------------------- 二进制与房间持久化

function defaultBinaries() {
  const roots = [
    path.join(__dirname, '..', '..', 'runtime', 'easytier', 'easytier-linux-x86_64'),
    path.join(os.homedir(), '.mc-next', 'net', 'bin')
  ];
  for (const dir of roots) {
    const core = path.join(dir, 'easytier-core');
    const cli = path.join(dir, 'easytier-cli');
    if (fs.existsSync(core) && fs.existsSync(cli)) return { core, cli, dir };
  }
  return { core: null, cli: null, dir: null };
}

function loadRooms(root) {
  const p = path.join(root, ROOMS_FILE);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return { rooms: [] }; }
}
function saveRooms(root, data) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, ROOMS_FILE), JSON.stringify(data, null, 2));
}

/** 真实执行 `easytier-core --version` 校验二进制可用 */
async function verifyBinary(corePath, opts = {}) {
  if (!corePath || !fs.existsSync(corePath)) return { ok: false, error: '未找到 easytier-core 二进制' };
  const execFile = opts.execFile || ((bin, args, o, cb) => cp.execFile(bin, args, o, cb));
  return new Promise(resolve => {
    execFile(corePath, ['--version'], { timeout: 8000, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: err.message });
      resolve({ ok: true, version: String(stdout || stderr || '').trim() });
    });
  });
}

// ---------------------------------------------------------------- 房间管理器

class RoomManager {
  /**
   * opts: { root, corePath, cliPath, spawn, execFile, now }
   * 全部可注入，单测无需真实进程。
   */
  constructor(opts = {}) {
    const bins = defaultBinaries();
    this.root = opts.root || path.join(os.homedir(), '.mc-next', 'net');
    this.corePath = opts.corePath !== undefined ? opts.corePath : bins.core;
    this.cliPath = opts.cliPath !== undefined ? opts.cliPath : bins.cli;
    this.spawn = opts.spawn || cp.spawn;
    this.execFile = opts.execFile || ((bin, args, o, cb) => cp.execFile(bin, args, o, cb));
    this.proc = null;
    this.room = null;
    this.args = null;
    this.logs = [];
    this.startedAt = null;
  }

  onLog(line) { this.logs.push({ t: Date.now(), line }); if (this.logs.length > 500) this.logs.shift(); }

  /** 启动 easytier-core；返回真实 pid，不返回「已连接」假状态 */
  start(room, opts = {}) {
    if (!this.corePath) {
      return { ok: false, error: '缺少 EasyTier 运行时：请在设置中指定 easytier-core 路径，或放置到 runtime/easytier/' };
    }
    if (this.proc && !this.proc.killed) return { ok: false, error: '已有联机进程在运行，请先停止' };
    this.args = buildCoreArgs(room, opts);
    this.room = room;
    this.startedAt = Date.now();
    try {
      this.proc = this.spawn(this.corePath, this.args, { stdio: ['ignore', 'pipe', 'pipe'], env: opts.env || process.env });
    } catch (e) { return { ok: false, error: `easytier-core 启动失败：${e.message}` }; }
    const p = this.proc;
    if (p.stdout) p.stdout.on('data', d => this.onLog(String(d).trim()));
    if (p.stderr) p.stderr.on('data', d => this.onLog(String(d).trim()));
    p.on('error', e => this.onLog(`[error] ${e.message}`));
    p.on('exit', (code, signal) => this.onLog(`[exit] code=${code} signal=${signal}`));
    this._persist(room);
    return { ok: true, pid: p.pid || null, args: this.args, binary: this.corePath, note: '进程已启动；虚拟 IP 需由 CLI 状态确认' };
  }

  stop() {
    if (!this.proc) return { ok: false, error: '当前没有运行中的联机进程' };
    try { this.proc.kill('SIGTERM'); } catch { /* noop */ }
    const pid = this.proc.pid;
    this.proc = null;
    return { ok: true, pid };
  }

  _cli(sub, rpcPortal) {
    const args = ['-p', rpcPortal || DEFAULT_RPC, '-o', 'json', ...sub.split(' ').filter(Boolean)];
    return new Promise(resolve => {
      this.execFile(this.cliPath, args, { timeout: 8000, encoding: 'utf8', maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, error: err.message, raw: String(stdout || stderr || '') });
        resolve({ ok: true, raw: String(stdout || ''), parsed: parseCliJson(stdout) });
      });
    });
  }

  /**
   * 查询真实组网状态。未启动 / 无 CLI / 命令失败都如实返回 connected:false。
   * 虚拟 IP 与成员列表一律来自 easytier-cli 的真实输出。
   */
  async status(opts = {}) {
    if (!this.proc || this.proc.killed) {
      return { connected: false, running: false, virtualIp: null, peers: [], reason: '联机进程未启动' };
    }
    if (!this.cliPath || !fs.existsSync(this.cliPath)) {
      return { connected: false, running: true, virtualIp: null, peers: [], reason: '未找到 easytier-cli，无法读取状态' };
    }
    const portal = opts.rpcPortal || (this.room && this.room.rpcPortal) || DEFAULT_RPC;
    const [nodeRes, peerRes] = await Promise.all([this._cli('node', portal), this._cli('peer', portal)]);
    if (!nodeRes.ok && !peerRes.ok) {
      return { connected: false, running: true, virtualIp: null, peers: [], reason: `CLI 查询失败：${nodeRes.error}` };
    }
    const virtualIp = nodeRes.ok ? extractVirtualIp(nodeRes.parsed) : null;
    const peers = peerRes.ok ? extractPeers(peerRes.parsed) : [];
    return {
      connected: !!virtualIp || peers.length > 0,
      running: true,
      virtualIp, peers,
      hostname: this.room && (this.room.hostname || null),
      rpcPortal: portal,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : null,
      rawNode: nodeRes.raw || null, rawPeer: peerRes.raw || null,
      logs: this.logs.slice(-30)
    };
  }

  _persist(room) {
    const db = loadRooms(this.root);
    db.rooms = [room, ...(db.rooms || []).filter(r => r.id !== room.id)].slice(0, 20);
    // 邀请码含密钥，仅本地保存，不外传
    saveRooms(this.root, db);
  }

  listRooms() { return loadRooms(this.root).rooms || []; }
}

module.exports = {
  INVITE_PREFIX, DEFAULT_SUBNET, DEFAULT_RPC, DEFAULT_SHARED_NODES,
  checksum, encodeInvite, decodeInvite, createRoom, joinRoom, buildCoreArgs,
  parseCliJson, flattenRows, extractVirtualIp, extractPeers,
  defaultBinaries, loadRooms, saveRooms, verifyBinary, RoomManager
};
