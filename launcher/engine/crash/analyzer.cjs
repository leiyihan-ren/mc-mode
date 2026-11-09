/**
 * analyzer.cjs — Minecraft 崩溃自动诊断
 *
 * 真实识别（对齐 HMCL / PCL2 的崩溃分析器）：
 *  - OOM 堆溢出 / 系统内存不足 / OOM Killer (exit 137)
 *  - Java 版本不匹配：UnsupportedClassVersionError + class file version → Java 主版本
 *  - 缺少依赖库：ClassNotFoundException / NoClassDefFoundError / NoSuchMethodError
 *  - 渲染与 OpenGL：GLFW / LWJGL / EXCEPTION_ACCESS_VIOLATION / 显卡驱动
 *  - Mod 冲突与 Mixin 注入失败
 *  - JVM 启动失败：找不到主类 / 非法 -Xmx / 无法识别的 VM 参数
 *  - 退出码语义：1 / 134(SIGABRT) / 137(SIGKILL/OOM) / 139(SIGSEGV) / 0xC0000005
 */
'use strict';

/**
 * @typedef {Object} CrashFinding 单条诊断结论
 * @property {string} code 规则码（OOM / JAVA_VERSION / MISSING_LIB / …）
 * @property {string} title 人类可读标题
 * @property {'fatal'|'error'|'warn'|'info'} severity 严重级别
 * @property {string[]} matches 命中的原始日志行（最多 4 条，超长截断）
 * @property {string[]} suggestions 可执行的排查建议
 */

/**
 * @typedef {Object} CrashAnalysis analyzeCrash 的结构化输出（AI 可读）
 * @property {boolean} ok 是否未发现 fatal/error 级问题
 * @property {CrashFinding|null} primary 排序后的首要诊断
 * @property {CrashFinding[]} findings 全部诊断结论（按严重级别排序）
 * @property {number|null} javaRequired 从 class file version 推断的所需 Java 主版本
 * @property {number|null} javaCurrent 当前 Java 主版本
 * @property {string[]} modSuspects 从堆栈帧提取的可疑第三方包名
 * @property {string[]} causedBy Caused by 链（最多 8 条）
 * @property {string|null} description Minecraft 崩溃报告的 Description 字段
 * @property {string|null} gameVersion 游戏版本
 * @property {number|null} exitCode 进程退出码
 * @property {string|null} signal 终止信号
 * @property {number} totalLines 参与分析的日志行数
 * @property {string} summary 一句话人话摘要
 */

/** class file major version → Java 主版本（真实 JVM 规范） */
const JAVA_CLASS_VERSION = {
  45: 1, 46: 2, 47: 3, 48: 4, 49: 5, 50: 6, 51: 7, 52: 8,
  53: 9, 54: 10, 55: 11, 56: 12, 57: 13, 58: 14, 59: 15, 60: 16,
  61: 17, 62: 18, 63: 19, 64: 20, 65: 21, 66: 22, 67: 23, 68: 24, 69: 25
};

const EXIT_CODES = {
  0: { code: 'NORMAL', title: '正常退出', severity: 'info', suggestion: [] },
  1: { code: 'GENERIC_ERROR', title: '进程以错误码 1 退出', severity: 'warn', suggestion: ['结合下方日志中的异常堆栈定位具体原因'] },
  134: { code: 'SIGABRT', title: 'JVM 主动中止（SIGABRT / 断言失败）', severity: 'fatal', suggestion: ['检查 hs_err_pid*.log', '尝试关闭 -XX:+Use* 激进参数'] },
  137: { code: 'OOM_KILLED', title: '进程被系统杀掉（SIGKILL，通常内存不足）', severity: 'fatal', suggestion: ['降低 -Xmx 分配内存', '关闭其它占内存程序', '检查系统 dmesg / OOM Killer 记录'] },
  139: { code: 'SIGSEGV', title: '原生层段错误（SIGSEGV）', severity: 'fatal', suggestion: ['更新显卡驱动', '更换 LWJGL / natives 版本', '关闭可疑的原生模组'] },
  '-1073741819': { code: 'ACCESS_VIOLATION', title: 'Windows 访问冲突 (0xC0000005)', severity: 'fatal', suggestion: ['更新显卡驱动', '关闭 OpenGL 相关优化模组'] }
};

const RULES = [
  {
    code: 'OOM', severity: 'fatal', title: 'Java 堆内存溢出 (OutOfMemoryError)',
    patterns: [/java\.lang\.OutOfMemoryError/, /Could not reserve enough space for \d+KB object heap/, /There is insufficient memory for the Java Runtime Environment/, /Native memory allocation \(mmap\) failed/, /Java heap space/],
    suggestions: ['把 -Xmx 调低到物理内存的 1/2 以内（例如 -Xmx4G）', '关闭浏览器等占内存程序', '确认使用 64 位 Java（32 位 JVM 最大约 1.5G）', '减少大型整合包模组数量或增加内存']
  },
  {
    code: 'JAVA_VERSION', severity: 'fatal', title: 'Java 版本过低 / 不匹配',
    patterns: [/UnsupportedClassVersionError/, /has been compiled by a more recent version of the Java Runtime/, /class file version\s+\d+/, /requires Java \d+/i, /java\.lang\.IllegalAccessError: .*module .* does not (?:export|open)/],
    suggestions: ['1.16.5 及以下使用 Java 8', '1.17 ~ 1.20.4 使用 Java 17', '1.20.5 / 1.21+ 使用 Java 21', '在启动器设置里为不同版本分别指定 Java']
  },
  {
    code: 'MISSING_LIB', severity: 'fatal', title: '缺少依赖库 / 类版本冲突',
    patterns: [/ClassNotFoundException/, /NoClassDefFoundError/, /NoSuchMethodError/, /NoSuchFieldError/, /IncompatibleClassChangeError/],
    suggestions: ['删除该版本的 libraries 目录后重新补齐依赖', '检查是否有重复或版本冲突的模组', 'Fabric 需确保 asm / sponge-mixin 在 classpath 中']
  },
  {
    code: 'GL_RENDER', severity: 'error', title: 'OpenGL / 渲染初始化失败',
    patterns: [/GLFW error/, /Could not create (?:GL|OpenGL) context/, /org\.lwjgl\.LWJGLException/, /Pixel format not accelerated/, /EXCEPTION_ACCESS_VIOLATION/, /OpenGL is not supported/, /no opengl/i],
    suggestions: ['更新或重装显卡驱动', '关闭显卡overlay与录屏软件', '删除 options.txt 后重试', '尝试改用兼容渲染后端']
  },
  {
    code: 'MOD_CONFLICT', severity: 'error', title: '模组冲突 / 加载失败',
    patterns: [/Duplicate mod id/i, /ModLoadingException/, /ModResolutionException/, /ForgeModLoadingException/, /Found duplicate mods/i, /Mixin apply failed/i, /mixin\.invalidate/i],
    suggestions: ['检查 mods 目录中重复的模组', '查看报错中列出的冲突模组并二选一', '核对模组对应的 MC 版本与加载器版本']
  },
  {
    code: 'JVM_BOOT', severity: 'fatal', title: 'JVM 启动失败',
    patterns: [/Could not find or load main class/, /Invalid maximum heap size/, /Unrecognized option/, /Error occurred during initialization of VM/, /Could not create the Java Virtual Machine/, /A fatal exception has occurred/],
    suggestions: ['检查 Java 路径是否有效', '核对 -Xmx/-Xms 写法（如 4G 而非 4096）', '移除当前 Java 版本不支持的 -XX 参数']
  },
  {
    code: 'WORLD_CORRUPT', severity: 'warn', title: '存档 / 数据读取异常',
    patterns: [/Corrupted chunk/i, /java\.io\.IOException: .*level\.dat/, /Failed to load chunk/i, /Invalid NBT/i],
    suggestions: ['用 MCA Selector 或备份修复存档', '删除损坏的 region 文件让游戏重新生成']
  },
  {
    code: 'CRASH_REPORT', severity: 'info', title: '检测到 Minecraft 崩溃报告',
    patterns: [/---- Minecraft Crash Report ----/, /Description: [A-Za-z]/, /A detailed walkthrough of the error/],
    suggestions: ['下方“日志净化”已提取关键堆栈，可据此定位具体模组']
  }
];

function classFileVersionToJava(v) {
  const major = Math.floor(Number(v));
  return JAVA_CLASS_VERSION[major] || null;
}

/** 从日志推断所需 Java 主版本 */
function detectJavaRequirement(log) {
  const a = /class file version\s+(\d+(?:\.\d+)?)/i.exec(log);
  if (a) return { java: classFileVersionToJava(a[1]), source: a[0] };
  const b = /requires Java (\d+)/i.exec(log);
  if (b) return { java: Number(b[1]), source: b[0] };
  const c = /class file version\s+(\d+)/i.exec(log);
  return c ? { java: classFileVersionToJava(c[1]), source: c[0] } : null;
}

/** 从堆栈帧中提取可疑模组包名（真实 MC 日志常见形态） */
function extractModSuspects(log) {
  const found = new Set();
  const frames = log.matchAll(/^\s+at\s+([\w.$]+)\./gm);
  for (const m of frames) {
    const pkg = m[1];
    if (/^(net\.minecraft|java\.|sun\.|jdk\.|com\.mojang|net\.minecraftforge|net\.fabricmc|org\.spongepowered|cpw\.mods|org\.lwjgl)/.test(pkg)) continue;
    const parts = pkg.split('.');
    if (parts.length >= 3) found.add(parts.slice(0, 3).join('.'));
  }
  const ids = log.matchAll(/(?:mod|modid|modId)[^\w]{1,4}([a-z0-9_]{2,40})/gi);
  for (const m of ids) found.add(m[1]);
  return [...found].slice(0, 10);
}

/**
 * 分析崩溃：把原始日志归因为结构化、AI 可读的诊断结论。
 *
 * 规则源为模块内 RULES（单一数据源，guardian.cjs 复用），退出码/信号另按 EXIT_CODES 判定；
 * 未命中任何特征时如实返回 ok:true / primary:null，绝不臆造结论。
 *
 * @param {string|{log?:string, exitCode?:number, signal?:string, gameVersion?:string, javaVersion?:number}} input
 *   日志文本，或携带上下文的对象。
 * @returns {CrashAnalysis} 结构化诊断结果
 */
function analyzeCrash(input) {
  const o = typeof input === 'string' ? { log: input } : (input || {});
  const log = String(o.log || '');
  const lines = log.split(/\r?\n/).filter(Boolean);
  const findings = [];
  const severityRank = { fatal: 0, error: 1, warn: 2, info: 3 };

  for (const rule of RULES) {
    const matches = [];
    for (const line of lines) {
      if (rule.patterns.some(re => re.test(line))) {
        matches.push(line.length > 220 ? line.slice(0, 220) + '…' : line);
        if (matches.length >= 4) break;
      }
    }
    if (matches.length) {
      findings.push({
        code: rule.code, title: rule.title, severity: rule.severity,
        matches, suggestions: rule.suggestions
      });
    }
  }

  // 退出码 / 信号
  const ec = o.exitCode === undefined ? null : Number(o.exitCode);
  if (ec !== null && ec !== 0 && EXIT_CODES[ec]) {
    const e = EXIT_CODES[ec];
    findings.push({ code: e.code, title: e.title, severity: e.severity, matches: [`exitCode=${ec}`], suggestions: e.suggestion });
  }
  if (o.signal && /SIGKILL/i.test(String(o.signal))) {
    findings.push({ code: 'OOM_KILLED', title: '进程被 SIGKILL 终止（通常内存不足）', severity: 'fatal', matches: [`signal=${o.signal}`], suggestions: ['降低 -Xmx', '检查系统内存'] });
  }
  if (ec === 0 && !findings.length) {
    findings.push({ code: 'NORMAL', title: '正常退出，未发现崩溃特征', severity: 'info', matches: [], suggestions: [] });
  }

  findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
  const primary = findings[0] || null;
  const javaReq = detectJavaRequirement(log);
  if (javaReq && javaReq.java && o.javaVersion && Number(o.javaVersion) < javaReq.java) {
    primary && primary.suggestions.unshift(`当前 Java ${o.javaVersion}，该版本需要 Java ${javaReq.java} 及以上`);
  }
  const causedBy = [...log.matchAll(/Caused by:\s*([^\n]+)/g)].map(m => m[1].trim());
  const description = (/Description:\s*([^\n]+)/.exec(log) || [])[1] || null;

  return {
    ok: !findings.some(f => f.severity === 'fatal' || f.severity === 'error'),
    severity: primary ? primary.severity : 'info',
    primary, findings,
    javaRequired: javaReq ? javaReq.java : null,
    javaCurrent: o.javaVersion || null,
    modSuspects: extractModSuspects(log),
    causedBy: causedBy.slice(0, 8), description,
    gameVersion: o.gameVersion || null,
    exitCode: ec, signal: o.signal || null,
    totalLines: lines.length,
    summary: primary
      ? `${primary.title}${javaReq && javaReq.java ? `；需 Java ${javaReq.java}+` : ''}${description ? `；崩溃描述：${description}` : ''}`
      : '未识别到已知崩溃特征'
  };
}

module.exports = {
  JAVA_CLASS_VERSION, EXIT_CODES, RULES, classFileVersionToJava,
  detectJavaRequirement, extractModSuspects, analyzeCrash
};
