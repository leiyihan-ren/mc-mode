'use strict';
/**
 * engine/appearance.cjs — 【0.5.0 模块一】UI 视觉革命的可测逻辑层
 *
 * 全部为纯函数（无 IO、无网络、无 DOM），便于在沙盒里做确定性单测：
 *  - 动态背景引擎：三种模式（dark 极简 / particles 粒子 / image 本地图片）配置归一化与校验
 *  - 本地背景图片：PNG / JPEG / WebP / GIF 真实签名校验 + 尺寸读取 + 体积上限 + dataUrl
 *  - 极客 JVM 面板：参数文本解析（支持引号/注释）、危险字符拦截、内存参数托管去重、
 *    真实可用的 G1GC 推荐预设（Aikar's flags 家族）、mergeLaunchJvm 合成最终启动参数
 *
 * 设计原则：绝不编造参数、绝不把「未配置」伪装成「已优化」；所有降级都显式返回。
 */
const crypto = require('crypto');

// ---------------------------------------------------------------- 动态背景引擎

const MODES = ['dark', 'particles', 'image'];

const DEFAULT_APPEARANCE = Object.freeze({
  mode: 'dark',          // dark 极简 / particles 动态粒子 / image 本地图片
  particleCount: 72,     // 粒子数量
  particleSpeed: 0.6,    // 粒子速度倍率
  particleColor: '#5b9dff',
  blur: 14,              // 背景图片高斯模糊 px
  overlayOpacity: 0.55,  // 毛玻璃遮罩不透明度 0..1
  imageDataUrl: null     // mode=image 时的 data:image/...;base64
});

/** 数值夹取：非法/NaN 回退默认值 */
function clampNumber(v, min, max, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/**
 * 归一化背景配置，返回 { ok, config, issues }。
 * 非法 mode 回退 dark；image 模式必须有合法 dataUrl，否则降级为 dark 并给出明确原因。
 */
function validateAppearance(input) {
  const cfg = { ...DEFAULT_APPEARANCE, ...(input && typeof input === 'object' ? input : {}) };
  const issues = [];
  if (!MODES.includes(cfg.mode)) {
    issues.push({ severity: 'warning', type: 'bad-mode', message: `未知背景模式「${cfg.mode}」，已回退深色极简` });
    cfg.mode = 'dark';
  }
  cfg.particleCount = Math.round(clampNumber(cfg.particleCount, 12, 240, DEFAULT_APPEARANCE.particleCount));
  cfg.particleSpeed = clampNumber(cfg.particleSpeed, 0.1, 3, DEFAULT_APPEARANCE.particleSpeed);
  cfg.blur = Math.round(clampNumber(cfg.blur, 0, 48, DEFAULT_APPEARANCE.blur));
  cfg.overlayOpacity = clampNumber(cfg.overlayOpacity, 0.1, 0.9, DEFAULT_APPEARANCE.overlayOpacity);
  if (!/^#[0-9a-fA-F]{6}$/.test(String(cfg.particleColor))) {
    cfg.particleColor = DEFAULT_APPEARANCE.particleColor;
  }
  if (cfg.mode === 'image') {
    const r = validateImageDataUrl(cfg.imageDataUrl);
    if (!r.ok) {
      issues.push({ severity: 'error', type: 'image-invalid', message: `本地图片无效：${r.error}，已回退深色极简` });
      cfg.mode = 'dark';
      cfg.imageDataUrl = null;
    }
  } else {
    cfg.imageDataUrl = null;
  }
  return { ok: !issues.some(i => i.severity === 'error'), config: cfg, issues };
}

// ---------------------------------------------------------------- 本地背景图片

const MAX_IMAGE_BYTES = 12 * 1024 * 1024; // 12MB 上限，避免 base64 撑爆 localStorage / IPC

const DATA_URL_RE = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/;

/** 校验 dataUrl 是否合法（不读磁盘，纯字符串/字节校验） */
function validateImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl) return { ok: false, error: '图片数据为空' };
  const m = DATA_URL_RE.exec(dataUrl);
  if (!m) return { ok: false, error: '不是受支持的 data:image（仅 PNG/JPEG/WebP/GIF）' };
  let buf;
  try { buf = Buffer.from(m[2], 'base64'); } catch (e) { return { ok: false, error: 'base64 解码失败' }; }
  if (!buf.length) return { ok: false, error: '图片内容为空' };
  if (buf.length > MAX_IMAGE_BYTES) {
    return { ok: false, error: `图片超过 ${Math.round(MAX_IMAGE_BYTES / 1048576)}MB 上限` };
  }
  return inspectBackgroundImage(buf, m[1]);
}

/** 从魔数识别图片类型 */
function detectImageMime(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf.subarray(0, 3).toString('ascii') === 'GIF' && ['87a', '89a'].includes(buf.subarray(3, 6).toString('ascii'))) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

/** 读 PNG IHDR 宽高（其它格式尽力而为，失败返回 null，不编造） */
function imageDimensions(buf, mime) {
  try {
    if (mime === 'image/png' && buf.length >= 24) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mime === 'image/gif' && buf.length >= 10) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
  } catch { /* 尺寸非必需 */ }
  return null;
}

/**
 * 校验本地图片字节：真实魔数 + 体积上限 + 尺寸 + 生成 dataUrl + sha256。
 * @returns {{ok:boolean, mime?, width?, height?, size?, sha256?, dataUrl?, error?}}
 */
function inspectBackgroundImage(buf, declaredMime) {
  if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, error: '无有效图片字节' };
  if (buf.length > MAX_IMAGE_BYTES) {
    return { ok: false, error: `图片超过 ${Math.round(MAX_IMAGE_BYTES / 1048576)}MB 上限` };
  }
  const mime = detectImageMime(buf);
  if (!mime) return { ok: false, error: '无法识别的图片格式（仅支持 PNG/JPEG/WebP/GIF）' };
  if (declaredMime && declaredMime !== mime) {
    return { ok: false, error: `声明类型 ${declaredMime} 与实际 ${mime} 不符` };
  }
  const dim = imageDimensions(buf, mime);
  return {
    ok: true, mime, size: buf.length,
    ...(dim || {}),
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    dataUrl: `data:${mime};base64,${buf.toString('base64')}`
  };
}

// ---------------------------------------------------------------- 极客 JVM 面板

/**
 * 真实可用的 G1GC 推荐预设（Aikar's flags 家族，社区广泛用于 MC 服务端/客户端）。
 * 不含 -Xmx/-Xms —— 内存由界面单独控制，避免参数冲突。
 */
const G1_BASE = [
  '-XX:+UseG1GC',
  '-XX:+ParallelRefProcEnabled',
  '-XX:MaxGCPauseMillis=200',
  '-XX:+UnlockExperimentalVMOptions',
  '-XX:+DisableExplicitGC',
  '-XX:+AlwaysPreTouch',
  '-XX:G1NewSizePercent=30',
  '-XX:G1MaxNewSizePercent=40',
  '-XX:G1HeapRegionSize=8M',
  '-XX:G1ReservePercent=20',
  '-XX:G1HeapWastePercent=5',
  '-XX:G1MixedGCCountTarget=4',
  '-XX:InitiatingHeapOccupancyPercent=15',
  '-XX:G1MixedGCLiveThresholdPercent=90',
  '-XX:G1RSetUpdatingPauseTimePercent=5',
  '-XX:SurvivorRatio=32',
  '-XX:+PerfDisableSharedMem',
  '-XX:MaxTenuringThreshold=1'
];

const JVM_PROFILES = Object.freeze([
  {
    id: 'g1', name: 'G1GC 均衡（推荐）',
    desc: 'Aikar 系 G1GC 低延迟参数，适合 4–8G 内存的主流整合包',
    minMemory: '1G', maxMemory: '4G', args: G1_BASE.slice()
  },
  {
    id: 'large', name: '大内存 / 大型整合包',
    desc: '8–12G 内存、上百模组，放宽新生代与 GC 目标',
    minMemory: '2G', maxMemory: '8G',
    args: G1_BASE.map(a => a === '-XX:MaxGCPauseMillis=200' ? '-XX:MaxGCPauseMillis=250' : a)
      .concat(['-XX:G1HeapRegionSize=16M'])
  },
  {
    id: 'lowspec', name: '低配省资源',
    desc: '2–4G 内存的老机器，精简 GC 参数降低开销',
    minMemory: '512M', maxMemory: '2G',
    args: ['-XX:+UseG1GC', '-XX:MaxGCPauseMillis=250', '-XX:+DisableExplicitGC', '-XX:+PerfDisableSharedMem']
  },
  {
    id: 'none', name: '不附加（仅内存）',
    desc: '完全交给 JVM 默认 GC，仅使用界面设置的 -Xms / -Xmx',
    minMemory: '1G', maxMemory: '4G', args: []
  }
]);

function recommendedProfiles() {
  return JVM_PROFILES.map(p => ({ ...p, args: p.args.slice() }));
}

/**
 * 解析 JVM 参数文本：支持空格 / 换行 / 引号包裹 / # 整行注释。
 * 纯字符串处理，不执行任何命令。
 * @returns {string[]}
 */
function parseJvmArgs(text) {
  if (Array.isArray(text)) return text.map(String).filter(Boolean);
  const out = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    // 一个 token = 连续若干「无空白段」或「引号段」，从而支持 -Dkey="value with space"
    const tokens = line.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    for (let tok of tokens) {
      tok = tok.replace(/["']/g, ''); // 剥掉包裹引号，保留值内空格为单个 argv
      if (!tok) continue;
      if (tok.startsWith('#')) break; // 行内注释到行尾
      out.push(tok);
    }
  }
  return out;
}

/** 危险字符：防止把 shell 元字符混进 JVM 参数（会被 spawn 当作 argv，但仍显式拦截） */
const UNSAFE_ARG_RE = /[;&|`$<>\n\r]/;

/**
 * 校验 JVM 参数数组：
 *  - 拦截含 shell 元字符 / 不以 - 开头的非法项（error）
 *  - -Xmx / -Xms 由界面「内存」统一托管，剥离并给出 warning（避免重复冲突）
 *  - 去重
 * @returns {{ok:boolean, args:string[], issues:object[]}}
 */
function validateJvmArgs(args) {
  const list = Array.isArray(args) ? args.map(String) : [];
  const issues = [];
  const kept = [];
  for (const a of list) {
    if (UNSAFE_ARG_RE.test(a)) {
      issues.push({ severity: 'error', type: 'unsafe-char', arg: a, message: `参数含不安全的 shell 字符，已拦截：${a}` });
      continue;
    }
    if (!a.startsWith('-')) {
      issues.push({ severity: 'error', type: 'not-a-flag', arg: a, message: `不是合法的 JVM 参数（须以 - 开头）：${a}` });
      continue;
    }
    if (/^-Xmx/i.test(a) || /^-Xms/i.test(a)) {
      issues.push({ severity: 'warning', type: 'memory-managed', arg: a, message: `${a} 由界面「内存设置」统一控制，已忽略以避免冲突` });
      continue;
    }
    kept.push(a);
  }
  return {
    ok: !issues.some(i => i.severity === 'error'),
    args: [...new Set(kept)],
    issues
  };
}

/**
 * 合成最终启动参数：推荐预设 + 用户自定义文本 → 去重/校验/剥离内存项。
 * 内存单独返回（供 -Xms/-Xmx），不会被自定义参数覆盖。
 * @param {object} o { profileId, extraJvmArgsText | extraJvmArgs, minMemory, maxMemory }
 * @returns {{ok:boolean, jvmArgs:string[], minMemory:string, maxMemory:string, issues:object[], profileId:string|null}}
 */
function mergeLaunchJvm(o = {}) {
  const profile = JVM_PROFILES.find(p => p.id === o.profileId) || null;
  const customText = o.extraJvmArgsText !== undefined
    ? o.extraJvmArgsText
    : (Array.isArray(o.extraJvmArgs) ? o.extraJvmArgs.join(' ') : '');
  const merged = validateJvmArgs([...(profile ? profile.args : []), ...parseJvmArgs(customText)]);
  const memRe = /^\d+(?:\.\d+)?[KMGkmg]$/;
  const minMemory = memRe.test(String(o.minMemory || '')) ? o.minMemory : (profile ? profile.minMemory : '1G');
  const maxMemory = memRe.test(String(o.maxMemory || '')) ? o.maxMemory : (profile ? profile.maxMemory : '4G');
  return {
    ok: merged.ok,
    jvmArgs: merged.args,
    minMemory, maxMemory,
    issues: merged.issues,
    profileId: profile ? profile.id : null
  };
}

module.exports = {
  MODES, DEFAULT_APPEARANCE, MAX_IMAGE_BYTES, G1_BASE, JVM_PROFILES,
  validateAppearance, clampNumber,
  validateImageDataUrl, detectImageMime, imageDimensions, inspectBackgroundImage,
  recommendedProfiles, parseJvmArgs, validateJvmArgs, mergeLaunchJvm
};
