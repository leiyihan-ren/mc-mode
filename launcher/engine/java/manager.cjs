'use strict';
/**
 * engine/java/manager.cjs — 模块一：Java 运行环境智能管家
 *
 * 职责：
 *  1) 扫描本机已安装的 JDK/JRE（环境变量、PATH、系统常见目录、sdkman、Adoptium 等）
 *  2) 按 MC 版本映射所需 Java 主版本，并从扫描结果中挑选最合适的 java 可执行文件
 *  3) 缺失时从 Adoptium 官方 API 查询真实产物 + SHA-256，走清华镜像/官方镜像下载、校验、解压、登记
 *
 * 所有 IO（目录列举、文件读取、进程执行、网络）均可注入，便于离线单元测试；
 * 不伪造任何版本号、下载结果或校验值。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const crypto = require('crypto');
const { fetchJson, downloadFile, fetchWithTimeout } = require('../http.js');

const ADOPTIUM_API = 'https://api.adoptium.net/v3/assets/feature_releases';
const TUNA_BASE = 'https://mirrors.tuna.tsinghua.edu.cn/Adoptium';
const GH_MIRROR = 'https://gh-proxy.com/';
const MANAGED_FILE = 'runtimes.json';

// ---------------------------------------------------------------- 版本映射

/**
 * MC 版本 → Java 主版本。依据 Mojang 官方 version.json 的 javaVersion.majorVersion
 * 与长期社区兼容结论：
 *  - 1.0   ~ 1.16.5 : Java 8  （含 Forge 1.7.10 ~ 1.16.5 全生态）
 *  - 1.17  ~ 1.17.1 : Java 16
 *  - 1.18  ~ 1.20.4 : Java 17
 *  - 1.20.5 及以后   : Java 21（1.21 / 1.21.x / 快照 / 26.x 等）
 */
const JAVA_RULES = [
  { max: '1.16.5', java: 8, label: 'Java 8', reason: '1.16.5 及更早版本（含 Forge 1.7.10~1.16.5 生态）需要 Java 8' },
  { max: '1.17.1', java: 16, label: 'Java 16', reason: '1.17 / 1.17.1 使用 Java 16' },
  { max: '1.20.4', java: 17, label: 'Java 17', reason: '1.18 ~ 1.20.4 官方 version.json 要求 Java 17' },
  { max: '999.999.999', java: 21, label: 'Java 21', reason: '1.20.5+ / 1.21+ / 快照版官方要求 Java 21' }
];

/** 解析 MC 版本字符串；快照（24w14a）与未来编号（26.1）都归入最新版规则 */
function parseMcVersion(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  if (/^\d{2}w\d{2}[a-z]$/i.test(s)) {
    return { major: 99, minor: 0, patch: 0, raw: s, snapshot: true };
  }
  const m = s.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return {
    major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] || 0),
    raw: s, snapshot: /pre|rc|snapshot|w\d{2}[a-z]/i.test(s)
  };
}

/** 三元组字典序比较：a<b → -1 */
function compareMc(a, b) {
  const x = typeof a === 'string' ? parseMcVersion(a) : a;
  const y = typeof b === 'string' ? parseMcVersion(b) : b;
  if (!x || !y) return NaN;
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  return 0;
}

function requiredJava(mcVersion) {
  const v = parseMcVersion(mcVersion);
  if (!v) return { java: null, label: '未知', error: `无法识别 MC 版本：${mcVersion}` };
  for (const r of JAVA_RULES) {
    if (compareMc(v, r.max) <= 0) {
      return { java: r.java, label: r.label, reason: r.reason, mcVersion: v.raw, snapshot: v.snapshot };
    }
  }
  const last = JAVA_RULES[JAVA_RULES.length - 1];
  return { java: last.java, label: last.label, reason: last.reason, mcVersion: v.raw, snapshot: v.snapshot };
}

// ---------------------------------------------------------------- 本机扫描

function defaultIo() {
  return {
    readDir: p => fs.readdirSync(p, { withFileTypes: true }),
    isFile: p => { try { return fs.statSync(p).isFile(); } catch { return false; } },
    isDir: p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
    readText: p => fs.readFileSync(p, 'utf8'),
    realpath: p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } },
    spawnSync: (bin, args) => cp.spawnSync(bin, args, { encoding: 'utf8', timeout: 8000 })
  };
}

/** 根据 Java 版本字符串解析主版本：1.8.0_301 → 8；17.0.21 → 17；20.0.1 → 20 */
function majorOf(version) {
  const m = String(version || '').match(/(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return Number(m[1]) === 1 ? Number(m[2] || 8) : Number(m[1]);
}

/** JDK 根目录下的 release 文件（不执行进程即可拿到准确版本/厂商） */
function parseReleaseFile(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)="?(.*?)"?$/);
    if (m) out[m[1]] = m[2];
  }
  const version = out.JAVA_VERSION || out.OPENJDK_VERSION || null;
  return {
    version,
    major: majorOf(version),
    vendor: out.IMPLEMENTOR || out.JAVA_VENDOR || null,
    arch: out.OS_ARCH || null,
    runtimeName: out.JAVA_RUNTIME_NAME || null
  };
}

/** java -version 输出解析（release 文件缺失时的兜底） */
function parseVersionOutput(text) {
  const m = String(text || '').match(/(?:openjdk|java) version "([^"]+)"/i);
  if (!m) return { version: null, major: null, vendor: null };
  const vendorM = String(text).match(/(?:Runtime Environment|Client VM)\s+\(([^)]+)\)/);
  return { version: m[1], major: majorOf(m[1]), vendor: vendorM ? vendorM[1].split(' ')[0] : null };
}

/** 单个 JDK 根目录 → 描述对象；无法识别返回 null */
function inspectJavaHome(home, source, io, platform = process.platform) {
  const exe = platform === 'win32' ? 'java.exe' : 'java';
  const bin = path.join(home, 'bin', exe);
  if (!io.isFile(bin)) return null;
  let info = { version: null, major: null, vendor: null, arch: null, runtimeName: null };
  const releasePath = path.join(home, 'release');
  if (io.isFile(releasePath)) {
    try { info = { ...info, ...parseReleaseFile(io.readText(releasePath)) }; } catch { /* 落到 -version */ }
  }
  if (info.major == null) {
    try {
      const r = io.spawnSync(bin, ['-version']);
      const parsed = parseVersionOutput(`${r.stdout || ''}\n${r.stderr || ''}`);
      info = { ...info, ...parsed };
    } catch { /* 明确返回未识别 */ }
  }
  return {
    home, path: bin, source,
    major: info.major, version: info.version, vendor: info.vendor,
    arch: info.arch, runtimeName: info.runtimeName,
    recognized: Number.isInteger(info.major)
  };
}

/** 常见 JDK 安装位置（可作为容器目录，其下一级子目录才是 JDK 根） */
function commonRoots(platform, home, env) {
  const roots = [];
  const add = (p, source, container = false) => { if (p) roots.push({ p, source, container }); };
  add(env.JAVA_HOME, 'JAVA_HOME');
  add(env.JDK_HOME, 'JDK_HOME');
  for (const seg of String(env.PATH || '').split(path.delimiter)) {
    if (!/(java|jdk|jvm|sdkman)/i.test(seg)) continue;
    if (path.basename(seg).toLowerCase() === 'bin') add(path.dirname(seg), 'PATH');
  }
  if (platform === 'win32') {
    for (const base of ['C:\\Program Files\\Java', 'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Microsoft', 'C:\\Program Files\\Zulu',
      'C:\\Program Files\\BellSoft', path.join(home, '.jdks')]) add(base, 'system', true);
  } else if (platform === 'darwin') {
    add('/Library/Java/JavaVirtualMachines', 'system', true);
    add('/opt/homebrew/opt', 'system', true);
    add(path.join(home, 'Library/Java/JavaVirtualMachines'), 'user', true);
    add(path.join(home, '.sdkman/candidates/java'), 'sdkman', true);
  } else {
    for (const base of ['/usr/lib/jvm', '/usr/java', '/opt/java', '/opt/jdk', '/opt',
      path.join(home, '.sdkman/candidates/java'), path.join(home, '.jdks')]) add(base, 'system', true);
  }
  return roots;
}

/**
 * 扫描本机 Java。返回 { list, scanned, elapsedMs }
 * opts: { platform, home, env, extraRoots: string[], io, includeManaged: boolean }
 */
function scanLocalJava(opts = {}) {
  const started = Date.now();
  const platform = opts.platform || process.platform;
  const home = opts.home || os.homedir();
  const env = opts.env || process.env;
  const io = { ...defaultIo(), ...(opts.io || {}) };
  const roots = commonRoots(platform, home, env);
  // 用户传入的额外目录既可能是 JDK 根，也可能是容纳多个 JDK 的容器目录：
  // 默认按容器处理（先探测自身，再遍历一级子目录），两种情形都覆盖。
  for (const r of opts.extraRoots || []) {
    if (typeof r === 'string') roots.push({ p: r, source: 'custom', container: true });
    else roots.push({ p: r.path || r.p, source: r.source || 'custom', container: r.container !== false });
  }

  const seen = new Set();
  const list = [];
  const scanned = [];
  const consider = (homePath, source) => {
    const rec = inspectJavaHome(homePath, source, io, platform);
    if (!rec) return;
    const key = io.realpath(rec.path);
    if (seen.has(key)) return;
    seen.add(key);
    list.push(rec);
  };

  for (const r of roots) {
    if (!io.isDir(r.p)) continue;
    scanned.push(r.p);
    consider(r.p, r.source);
    if (!r.container) continue;
    let entries = [];
    try { entries = io.readDir(r.p); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      consider(path.join(r.p, e.name), r.source);
    }
  }
  list.sort((a, b) => (a.major || 0) - (b.major || 0));
  return { list, scanned, elapsedMs: Date.now() - started };
}

/**
 * 从候选列表中挑选最合适的 Java。
 * 优先级：精确匹配 > 满足要求的最低更高版本（附带 Forge 兼容性警告）> 缺失。
 * 注意：高版本 Java 并不能向下兼容旧 Forge（ASM 会炸），因此 preferExact 默认开启。
 */
function selectJava(list, mcVersion, opts = {}) {
  const req = requiredJava(mcVersion);
  if (!req.java) return { ok: false, error: req.error, required: req };
  const usable = (list || []).filter(j => j.recognized && Number.isInteger(j.major));
  const exact = usable.filter(j => j.major === req.java)
    .sort((a, b) => (b.version || '').localeCompare(a.version || ''))[0];
  if (exact) return { ok: true, java: exact, match: 'exact', required: req, warning: null };
  const newer = usable.filter(j => j.major > req.java).sort((a, b) => a.major - b.major)[0];
  if (newer && opts.allowNewer !== false) {
    return {
      ok: true, java: newer, match: 'newer', required: req,
      warning: `使用 Java ${newer.major} 启动 ${mcVersion}（需要 ${req.label}）。原版通常可运行，但旧版 Forge / 部分 Mod 的 ASM 在高版本 JVM 上会崩溃，建议安装 ${req.label}。`
    };
  }
  const older = usable.filter(j => j.major < req.java).sort((a, b) => b.major - a.major)[0];
  return {
    ok: false, java: null, required: req, match: 'missing',
    error: `本机缺少 ${req.label}（${mcVersion} 需要 Java ${req.java}）${older ? `，当前最高仅 Java ${older.major}` : ''}`,
    available: usable.map(j => j.major)
  };
}

// ---------------------------------------------------------------- 下载安装

function osArchSlugs(platform, arch) {
  const osSlug = { linux: 'linux', win32: 'windows', darwin: 'mac' }[platform] || 'linux';
  const archSlug = { x64: 'x64', arm64: 'aarch64', ia32: 'x86', arm: 'arm' }[arch] || 'x64';
  return { os: osSlug, arch: archSlug };
}

/** 查询 Adoptium 官方 API 获取真实下载直链 + SHA-256 */
async function adoptiumAsset(major, opts = {}) {
  const { os: osSlug, arch: archSlug } = osArchSlugs(opts.platform || process.platform, opts.arch || process.arch);
  const q = new URLSearchParams({
    architecture: archSlug, heap_size: 'normal', image_type: 'jdk', jvm_impl: 'hotspot',
    os: osSlug, project: 'jdk', vendor: 'eclipse', page_size: '1', sort_order: 'DESC'
  });
  const url = `${ADOPTIUM_API}/${major}/ga?${q}`;
  const data = await fetchJson(url, { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs || 20000 });
  const first = Array.isArray(data) ? data[0] : null;
  const bin = first && first.binaries && first.binaries[0];
  if (!bin || !bin.package || !bin.package.link) throw new Error(`Adoptium 未返回 Java ${major} 的可用产物`);
  const pkg = bin.package;
  return {
    major, name: pkg.name, link: pkg.link, checksum: pkg.checksum || null,
    size: pkg.size || null, version: (first.version_data || {}).semver || null,
    os: osSlug, arch: archSlug, source: 'Adoptium API', queryUrl: url
  };
}

/** 列出清华 Adoptium 镜像里真实存在的同版本安装包（HTML 目录解析，不猜文件名） */
async function tunaCandidates(major, opts = {}) {
  const { os: osSlug, arch: archSlug } = osArchSlugs(opts.platform || process.platform, opts.arch || process.arch);
  const dirUrl = `${TUNA_BASE}/${major}/jdk/${archSlug}/${osSlug}/`;
  try {
    const resp = await fetchWithTimeout(dirUrl, opts.timeoutMs || 15000, opts.fetchImpl);
    if (!resp.ok) return { dirUrl, urls: [] };
    const html = await resp.text();
    const names = [...String(html).matchAll(/href="([^"?]+\.(?:tar\.gz|zip))"/gi)].map(m => m[1]);
    const unique = [...new Set(names)];
    // 只保留最新一个（文件名带版本号，倒序即最新）
    unique.sort().reverse();
    return { dirUrl, urls: unique.slice(0, 2).map(n => dirUrl + n), names: unique };
  } catch {
    return { dirUrl, urls: [] };
  }
}

function sha256File(p) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

/** 找解压目录里真正的 JDK 根（含 bin/java） */
function findJavaHomeIn(extractDir, platform = process.platform) {
  const exe = platform === 'win32' ? 'java.exe' : 'java';
  const direct = path.join(extractDir, 'bin', exe);
  if (fs.existsSync(direct)) return extractDir;
  for (const e of fs.readdirSync(extractDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = path.join(extractDir, e.name);
    if (fs.existsSync(path.join(p, 'bin', exe))) return p;
    // mac JDK 把 Contents/Home 再套一层
    const mac = path.join(p, 'Contents', 'Home');
    if (fs.existsSync(path.join(mac, 'bin', exe))) return mac;
  }
  return null;
}

function loadManaged(root) {
  const p = path.join(root, MANAGED_FILE);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return { runtimes: [] }; }
}
function saveManaged(root, data) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, MANAGED_FILE), JSON.stringify(data, null, 2));
}

/**
 * 下载、校验、解压并登记一个受管 Java。
 * 真实网络失败会抛出，不返回假路径。
 * opts: { root, platform, arch, fetchImpl, downloadImpl, extractImpl, onProgress, asset }
 */
async function installJava(major, opts = {}) {
  const root = opts.root || path.join(os.homedir(), '.mc-next', 'java');
  const platform = opts.platform || process.platform;
  const arch = opts.arch || process.arch;
  fs.mkdirSync(root, { recursive: true });

  const asset = opts.asset || await adoptiumAsset(major, opts);
  const tuna = await tunaCandidates(major, opts);
  const urls = [...new Set([asset.link, ...tuna.urls, `${GH_MIRROR}${asset.link}`])];
  if (opts.onProgress) opts.onProgress({ stage: 'metadata', major, asset, candidates: urls });

  const archive = path.join(root, asset.name || `jdk-${major}.tar.gz`);
  const dl = opts.downloadImpl || downloadFile;
  let lastErr = null;
  for (const u of urls) {
    try {
      await dl(u, archive, {
        fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs || 120000,
        onProgress: p => opts.onProgress && opts.onProgress({ stage: 'download', url: u, ...p })
      });
      lastErr = null;
      break;
    } catch (e) { lastErr = e; }
  }
  if (lastErr) throw new Error(`Java ${major} 下载失败（已尝试 ${urls.length} 个源）: ${lastErr.message}`);

  // 真实 SHA-256 校验（Adoptium 提供的是 SHA-256）
  const actual = sha256File(archive);
  if (asset.checksum && actual.toLowerCase() !== asset.checksum.toLowerCase()) {
    fs.unlinkSync(archive);
    throw new Error(`SHA-256 校验失败：期望 ${asset.checksum}，实际 ${actual}`);
  }
  if (opts.onProgress) opts.onProgress({ stage: 'verified', sha256: actual, size: fs.statSync(archive).size });

  const target = path.join(root, `jdk-${major}-${(asset.version || 'ga').replace(/[^\w.+_-]/g, '_')}`);
  fs.mkdirSync(target, { recursive: true });
  const extract = opts.extractImpl || ((src, dest) => {
    if (/\.zip$/i.test(src)) {
      const AdmZip = require('adm-zip');
      new AdmZip(src).extractAllTo(dest, true);
    } else {
      const r = cp.spawnSync('tar', ['-xzf', src, '-C', dest], { encoding: 'utf8', timeout: 600000 });
      if (r.status !== 0) throw new Error(`tar 解压失败: ${r.stderr || r.status}`);
    }
  });
  await extract(archive, target);
  const javaHome = findJavaHomeIn(target, platform);
  if (!javaHome) throw new Error(`解压完成但未找到 JDK 根目录（bin/java）：${target}`);

  const exe = platform === 'win32' ? 'java.exe' : 'java';
  const javaPath = path.join(javaHome, 'bin', exe);
  const io = defaultIo();
  const rec = inspectJavaHome(javaHome, 'managed', io, platform) || { major, version: asset.version };
  const record = {
    ...rec, major: rec.major || major, version: rec.version || asset.version,
    home: javaHome, path: javaPath, source: 'managed',
    installedAt: new Date().toISOString(), sha256: actual,
    asset: { name: asset.name, link: asset.link, size: asset.size, version: asset.version },
    recognized: true
  };
  const db = loadManaged(root);
  db.runtimes = [...(db.runtimes || []).filter(r => r.major !== major), record];
  saveManaged(root, db);
  if (opts.onProgress) opts.onProgress({ stage: 'installed', java: record });
  return record;
}

/**
 * 一站式入口：扫描 → 匹配 → （可选）自动下载 → 返回可用的 java 路径。
 * 返回 { ok, java, source: 'local'|'managed'|'downloaded', required, warning, ... }
 */
async function ensureJava(mcVersion, opts = {}) {
  const root = opts.root || path.join(os.homedir(), '.mc-next', 'java');
  const local = opts.local || scanLocalJava(opts);
  const managed = (opts.managedRuntimes || loadManaged(root).runtimes || [])
    .filter(r => r && r.path && (!opts.io || true));
  const all = [...local.list, ...managed];
  const picked = selectJava(all, mcVersion, opts);
  if (picked.ok) return { ...picked, source: picked.java.source === 'managed' ? 'managed' : 'local' };
  if (opts.autoInstall === false) return { ...picked, source: null };
  const installed = await installJava(picked.required.java, { ...opts, root });
  return {
    ok: true, java: installed, match: 'downloaded', source: 'downloaded',
    required: picked.required, warning: null, installed: true
  };
}

module.exports = {
  JAVA_RULES, ADOPTIUM_API, TUNA_BASE, GH_MIRROR,
  parseMcVersion, compareMc, requiredJava,
  majorOf, parseReleaseFile, parseVersionOutput, inspectJavaHome, commonRoots,
  scanLocalJava, selectJava,
  osArchSlugs, adoptiumAsset, tunaCandidates, sha256File, findJavaHomeIn,
  loadManaged, saveManaged, installJava, ensureJava
};
