'use strict';
/**
 * engine/preflight.cjs — 启动前环境体检（0.7.0 模块二）
 *
 * 三类拦截，全部纯逻辑 + 可注入 IO，可离线单元测试：
 *   1) Java 环境：按 MC 版本映射所需主版本，探测本机 Java；版本不符时自动接管挑选，
 *      本机确实缺失则拦截并给出「去哪修」的人类可读提示。
 *   2) 内存防崩：-Xmx 超过物理内存、低于 1024MB、或 Xms > Xmx 时直接拦截。
 *   3) Natives 路径：在含中文与空格的目标目录做真实读写探针，失败给出修复提示。
 *
 * 设计约束（纯重构版本）：不新增 UI、不新增 IPC channel。
 * 结果通过既有 `game:launch` 返回值（{ok:false,error}）与 game:log 呈现，
 * 前端 HomePage 原本就展示「启动失败: <error>」。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const javaMgr = require('./java/manager.cjs');

const MIN_ALLOWED_MB = 1024;   // 用户红线：低于 1024MB 直接拦截
const SAFE_RATIO = 0.85;       // 超过物理内存 85% 给出预警
const SCAN_TTL_MS = 30000;     // 扫描缓存：避免每次启动全盘遍历 JDK 目录（提速）

function issue(level, code, message, fix) {
  return { level, code, message, fix };
}

function fmtMb(mb) {
  if (mb == null) return '未知';
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)}G` : `${Math.round(mb)}M`;
}

/**
 * 解析内存值：'4G' / '4096M' / '1.5G' / 4096 → MB。
 * 无后缀按 MB 计（与 buildJvmArgs 的 -Xmx 字符串语义一致）；无法识别返回 null。
 */
function parseMemoryMb(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*([KMG])?B?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || 'M').toUpperCase();
  const mul = unit === 'G' ? 1024 : unit === 'K' ? 1 / 1024 : 1;
  const mb = n * mul;
  return Number.isFinite(mb) && mb > 0 ? mb : null;
}

/** 内存防崩校验 */
function checkMemory(opts = {}) {
  const {
    minMemory, maxMemory,
    totalMemBytes = os.totalmem(),
    minAllowedMb = MIN_ALLOWED_MB,
    safeRatio = SAFE_RATIO
  } = opts;
  const totalMb = Math.floor(totalMemBytes / (1024 * 1024));
  const maxMb = parseMemoryMb(maxMemory);
  const minMb = parseMemoryMb(minMemory);
  const issues = [];

  if (maxMb == null) {
    issues.push(issue('block', 'MEM_INVALID',
      `无法识别最大内存设置「${maxMemory}」`,
      '在设置页填写形如 4G 或 4096M 的内存值'));
  } else if (maxMb < minAllowedMb) {
    issues.push(issue('block', 'MEM_TOO_LOW',
      `-Xmx 仅 ${fmtMb(maxMb)}，低于 ${minAllowedMb}MB 最低安全线，游戏会频繁 GC 卡顿甚至崩溃`,
      `把最大内存调到至少 ${minAllowedMb}MB（建议 2G 以上）`));
  } else if (maxMb > totalMb) {
    issues.push(issue('block', 'MEM_EXCEED_PHYSICAL',
      `-Xmx ${fmtMb(maxMb)} 超过物理内存 ${fmtMb(totalMb)}，JVM 会启动失败或被系统 OOM Killer 杀掉`,
      `把最大内存降到 ${fmtMb(Math.floor(totalMb * safeRatio))} 以内（物理内存的 85%）`));
  } else if (maxMb > totalMb * safeRatio) {
    issues.push(issue('warn', 'MEM_TIGHT',
      `-Xmx ${fmtMb(maxMb)} 占物理内存 ${Math.round(maxMb / totalMb * 100)}%，留给系统与启动器的余量偏小`,
      '建议下调 Xmx 或关闭其它占内存程序'));
  }

  if (minMb != null && maxMb != null && minMb > maxMb) {
    issues.push(issue('block', 'MIN_GT_MAX',
      `-Xms ${fmtMb(minMb)} 大于 -Xmx ${fmtMb(maxMb)}，JVM 拒绝启动`,
      '把初始内存调到不超过最大内存'));
  }

  return {
    ok: !issues.some(i => i.level === 'block'),
    totalMb, maxMb, minMb, issues
  };
}

/** 本地 Java 扫描结果缓存（真实提速：一次扫描，多次启动复用） */
let _scanCache = null;
function cachedLocalJava(ttlMs = SCAN_TTL_MS, scanFn = null) {
  const now = Date.now();
  if (_scanCache && now - _scanCache.at < ttlMs) return _scanCache.list;
  let list = [];
  try {
    const r = (scanFn || javaMgr.scanLocalJava)({ extraRoots: [] });
    list = (r && r.list) || [];
  } catch { list = []; }
  _scanCache = { at: now, list };
  return list;
}
function resetScanCache() { _scanCache = null; }

/** 真实执行 `java -version` 探测主版本；失败返回 null（不猜） */
function detectJavaMajor(bin, spawnSync) {
  if (!bin || typeof spawnSync !== 'function') return null;
  try {
    const r = spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 8000 });
    const parsed = javaMgr.parseVersionOutput(`${(r && r.stdout) || ''}\n${(r && r.stderr) || ''}`);
    return Number.isInteger(parsed.major) ? parsed.major : null;
  } catch {
    return null;
  }
}

/**
 * Java 环境校验 + 自动接管。
 * 返回 resolvedPath：体检认为应当使用的 java 可执行文件（可能为 null 表示维持默认）。
 */
function checkJava(opts = {}) {
  const {
    mcVersion,
    javaPath = null,
    list = null,
    scan = cachedLocalJava,
    requiredJavaFn = javaMgr.requiredJava,
    selectJavaFn = javaMgr.selectJava,
    spawnSync = (bin, args, o) => cp.spawnSync(bin, args, o),
    exists = fs.existsSync
  } = opts;

  const required = requiredJavaFn(mcVersion);
  if (!required.java) {
    return {
      ok: false, required, resolvedPath: null,
      issues: [issue('block', 'MC_VERSION_UNKNOWN',
        `无法识别 MC 版本「${mcVersion}」所需的 Java`, '检查版本 ID 是否正确')]
    };
  }

  const issues = [];
  let resolvedPath = null;
  const candidates = () => (list != null ? list : (() => { try { return scan(); } catch { return []; } })());

  if (javaPath && javaPath !== 'java') {
    if (!exists(javaPath)) {
      issues.push(issue('block', 'JAVA_MISSING',
        `指定的 Java 不存在：${javaPath}`,
        `在设置页重新选择 Java，或前往「Java 管家」安装 ${required.label}`));
    } else {
      const major = detectJavaMajor(javaPath, spawnSync);
      if (major == null) {
        resolvedPath = javaPath;
        issues.push(issue('warn', 'JAVA_UNRECOGNIZED',
          `无法读取 ${javaPath} 的版本号，按原路径启动（若启动失败请核对 Java 版本）`,
          `确认该路径是 ${required.label} 的可执行文件`));
      } else if (major < required.java) {
        const sel = selectJavaFn(candidates(), mcVersion, { allowNewer: false });
        if (sel.ok && sel.java.path !== javaPath) {
          resolvedPath = sel.java.path;
          issues.push(issue('warn', 'JAVA_AUTOFIX',
            `指定的 Java ${major} 过低（${mcVersion} 需要 Java ${required.java}），已自动切换到 ${sel.java.path}`,
            '如需固定 Java，请在设置页更新路径'));
        } else {
          issues.push(issue('block', 'JAVA_TOO_OLD',
            `指定的 Java ${major} 过低，${mcVersion} 需要 Java ${required.java}，且本机未找到可用版本`,
            `前往「Java 管家」一键安装 ${required.label}，或在设置页指定 Java ${required.java} 的路径`));
        }
      } else if (major > required.java) {
        resolvedPath = javaPath;
        issues.push(issue('warn', 'JAVA_NEWER',
          `当前 Java ${major} 高于 ${required.label}；原版通常可运行，但旧版 Forge / 部分 Mod 的 ASM 会崩溃`,
          `建议在「Java 管家」安装 ${required.label} 并分别指定`));
      } else {
        resolvedPath = javaPath;
      }
    }
  } else {
    const sel = selectJavaFn(candidates(), mcVersion);
    if (sel.ok) {
      resolvedPath = sel.java.path;
      if (sel.warning) {
        issues.push(issue('warn', 'JAVA_NEWER', sel.warning,
          `建议在「Java 管家」安装 ${required.label}`));
      }
    } else {
      const avail = (sel.available || []).filter(Boolean);
      issues.push(issue('block', 'JAVA_MISSING',
        `本机缺少 ${required.label}（${mcVersion} 需要 Java ${required.java}）${avail.length ? `，已检测到 Java ${avail.join(' / ')}` : ''}`,
        `前往「Java 管家」一键安装 ${required.label}，或在设置页手动指定 Java 路径`));
    }
  }

  return {
    ok: !issues.some(i => i.level === 'block'),
    required, resolvedPath, issues
  };
}

/**
 * 真实文件系统探针：在目标目录创建「含中文与空格」文件名的临时文件，写入→读回→删除。
 * Node fs 原生支持 UTF-8 路径，这里做真正确认而不是假定；
 * 权限 / 只读 / 编码异常时明确报错并给出可执行的修复建议。
 */
function probeNativesDir(nativesDir, io = {}) {
  const mkdirSync = io.mkdirSync || fs.mkdirSync;
  const writeFileSync = io.writeFileSync || fs.writeFileSync;
  const readFileSync = io.readFileSync || fs.readFileSync;
  const unlinkSync = io.unlinkSync || fs.unlinkSync;
  const marker = path.join(nativesDir, '.mcnext 路径 probe 中文.tmp');
  const payload = 'mcnext-native-path-ok';
  try {
    mkdirSync(nativesDir, { recursive: true });
    writeFileSync(marker, payload, 'utf8');
    if (readFileSync(marker, 'utf8') !== payload) throw new Error('写入后读回内容不一致');
    unlinkSync(marker);
    return { ok: true, probed: true };
  } catch (e) {
    try { unlinkSync(marker); } catch { /* 清理失败不覆盖原始错误 */ }
    return { ok: false, probed: true, error: e && e.message ? e.message : String(e) };
  }
}

function checkNatives(opts = {}) {
  const { nativesDir, probe = probeNativesDir, io = {} } = opts;
  if (!nativesDir) return { ok: true, issues: [], skipped: true };
  const r = probe(nativesDir, io);
  const issues = r.ok ? [] : [issue('block', 'NATIVES_PATH',
    `natives 目录不可写（中文 / 空格路径探针失败）：${r.error}`,
    '把游戏目录改到纯英文、无空格且当前用户可写的路径，或检查磁盘空间与权限')];
  return { ok: issues.length === 0, issues, probed: r.probed };
}

/** 汇总体检。skipJava/skipMemory/skipNatives 供单测与特殊场景裁剪。 */
function runPreflight(opts = {}) {
  const java = opts.skipJava ? null : checkJava(opts);
  const memory = opts.skipMemory ? null : checkMemory(opts);
  const natives = opts.skipNatives ? null : checkNatives(opts);
  const issues = [
    ...((java && java.issues) || []),
    ...((memory && memory.issues) || []),
    ...((natives && natives.issues) || [])
  ];
  const blocking = issues.filter(i => i.level === 'block');
  const warnings = issues.filter(i => i.level === 'warn');
  return {
    ok: blocking.length === 0,
    blocking, warnings, issues,
    java, memory, natives,
    resolvedJavaPath: java ? java.resolvedPath : null,
    summary: blocking.length
      ? `启动前检查未通过：${blocking.map(i => i.message).join('；')}`
      : warnings.length
        ? `启动前检查通过（${warnings.length} 条提示）：${warnings.map(i => i.message).join('；')}`
        : '启动前检查通过'
  };
}

module.exports = {
  MIN_ALLOWED_MB, SAFE_RATIO,
  issue, fmtMb, parseMemoryMb, checkMemory,
  cachedLocalJava, resetScanCache, detectJavaMajor, checkJava,
  probeNativesDir, checkNatives, runPreflight
};
