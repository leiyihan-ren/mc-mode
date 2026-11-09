/**
 * guardian.cjs — 0.7.0 模块四：JVM 崩溃「实时」拦截 + 人类可读诊断
 *
 * 与 analyzer.cjs 分工（规则不重复维护）：
 *   analyzer.cjs = 事后全量分析（用户在崩溃页手动提交日志），规则源为 analyzer.RULES
 *   guardian.cjs = 进程运行中逐行流式拦截 stderr/stdout，命中致命错误立即上报
 * 本模块复用 analyzer.RULES 作为唯一规则源，仅补充 JVM 原生层（hs_err / JNI）特征。
 *
 * 纯逻辑 + EventEmitter：不持有进程句柄、不直接 kill。
 * 命中致命错误 → emit('fatal', report)，由 IPC 层主动接管进程 + 弹窗，绝不卡在「启动中」。
 *
 * 防误杀设计（真实日志里 ClassNotFoundException 常作为被 catch 的 WARN 出现）：
 *   - STRONG 规则（OOM / JVM 启动失败 / 原生崩溃）：出现即上报
 *   - CONTEXTUAL 规则（ClassNotFound / GL / Mod 冲突）：需崩溃锚点或相邻上下文确认
 */
'use strict';

const { EventEmitter } = require('events');
const analyzer = require('./analyzer.cjs');

/** 只拦截 fatal/error 级规则；warn/info（存档损坏、崩溃报告头）不打断游戏、不弹窗 */
const FATAL_RULES = analyzer.RULES.filter(r => r.severity === 'fatal' || r.severity === 'error');

/** analyzer.RULES 未逐条覆盖的 JVM 原生层崩溃 / JNI / 栈溢出 */
const NATIVE_FATAL = [
  {
    code: 'NATIVE_CRASH', severity: 'fatal', title: 'JVM 原生层崩溃（Segfault / Native Crash）',
    patterns: [/# A fatal error has been detected by the Java Runtime Environment/, /SIGSEGV \(0xb\)/,
      /EXCEPTION_ACCESS_VIOLATION/, /Problematic frame:/, /hs_err_pid\d+\.log/, /Native frames:/,
      /SIGBUS|SIGFPE|SIGILL/, /fatal error in thread/i],
    suggestions: ['检查显卡驱动与 OpenGL 相关原生模组', '删除 natives 目录让启动器重新解压原生库',
      '尝试切换渲染后端（GL4ES / VirGL / Zink）', '把 hs_err_pid 崩溃日志发给对应模组作者']
  },
  {
    code: 'STACK_OVERFLOW', severity: 'fatal', title: '栈溢出 (StackOverflowError)',
    patterns: [/java\.lang\.StackOverflowError/],
    suggestions: ['检查是否有模组递归调用或循环依赖', '移除最近新增的可疑模组']
  },
  {
    code: 'UNSATISFIED_LINK', severity: 'fatal', title: '原生库加载失败 (UnsatisfiedLinkError)',
    patterns: [/java\.lang\.UnsatisfiedLinkError/, /no lwjgl.*in java\.library\.path/i,
      /Can't load (?:IA 32-bit )?library/i, /Can't find dependent libraries/i],
    suggestions: ['确认 natives 目录已正确解压（中文 / 空格路径亦受支持）',
      '检查系统是否缺少 VC++ / OpenGL 运行库', '核对 LWJGL 版本与操作系统架构']
  }
];

const ALL_RULES = [...FATAL_RULES, ...NATIVE_FATAL];

/**
 * 出现即接管，不等上下文（这类特征一旦出现进程已无法继续）。
 * JAVA_VERSION 刻意不在此列：其规则含 /requires Java \d+/i，正常模组日志也会出现，
 * 若直接接管会误杀；改由「崩溃锚点确认」或进程异常退出后的 finish() 兜底覆盖。
 */
const STRONG = new Set(['OOM', 'JVM_BOOT', 'STACK_OVERFLOW', 'NATIVE_CRASH', 'UNSATISFIED_LINK']);

/** 崩溃锚点：出现这些说明确实进入了异常/崩溃流程，可确认上下文型规则 */
const ANCHORS = [
  /Exception in thread/, /Caused by:/, /---- Minecraft Crash Report ----/, /\bFATAL\b/,
  /Game crashed!/, /Encountered an unexpected exception/, /Description: [A-Za-z]/,
  /Mixin apply failed/, /ModLoadingException|ModResolutionException/, /# A fatal error/,
  /Problematic frame:/, /Failed to (?:create|initialize|load)/
];

const CONTEXT_WINDOW = 3; // 锚点后 3 行内出现上下文型特征即确认

/** 把 analyzer 规则 + 命中证据组装成「人类能看懂」的诊断报告（前端直接渲染） */
function buildReport(rule, line, ctx = {}) {
  const reason = String(line == null ? '' : line);
  return {
    ok: false,
    code: rule.code,
    title: rule.title,
    severity: rule.severity,
    reason: reason.length > 300 ? reason.slice(0, 300) + '…' : reason,
    suggestions: (rule.suggestions || []).slice(),
    evidence: (ctx.evidence || []).slice(),
    stream: ctx.stream || 'stderr',
    source: ctx.source || 'stream',
    exitCode: ctx.exitCode !== undefined ? ctx.exitCode : null,
    signal: ctx.signal !== undefined ? ctx.signal : null,
    at: ctx.now || Date.now(),
    // 人话摘要：标题 + 原因 + 首要建议，弹窗第一行就能看懂发生了什么、该做什么
    human: `${rule.title}。\n命中：${reason.slice(0, 160)}\n建议：${(rule.suggestions || [])[0] || '查看下方日志定位原因'}`
  };
}

class CrashGuardian extends EventEmitter {
  /**
   * @param {object} opts { windowSize=30, now, intentionalStopGuard }
   *   windowSize: 证据环形缓冲行数；now: 可注入时钟；dedupe: 同 code 只报一次
   */
  constructor(opts = {}) {
    super();
    this.windowSize = opts.windowSize || 30;
    this.now = opts.now || (() => Date.now());
    this.dedupe = opts.dedupe !== false;
    this._ring = [];
    this._reported = new Set();
    this._pending = [];       // 上下文型待确认命中
    this._lineNo = 0;
    this._anchorAt = -Infinity;
    this._intentional = false; // 用户主动停止 → 不产生崩溃报告
    this._finished = false;
    this._fatalCount = 0;
  }

  /** 用户主动点「停止游戏」：标记后 finish 不再兜底上报 */
  markIntentional() { this._intentional = true; }

  _push(stream, text) {
    this._ring.push({ stream, text });
    if (this._ring.length > this.windowSize) this._ring.shift();
  }

  _evidence() { return this._ring.map(x => `[${x.stream}] ${x.text}`); }

  _report(rule, line, extra = {}) {
    if (this.dedupe && this._reported.has(rule.code)) return null;
    this._reported.add(rule.code);
    this._fatalCount++;
    const report = buildReport(rule, line, {
      evidence: this._evidence(),
      stream: extra.stream || 'stderr',
      source: extra.source || 'stream',
      exitCode: extra.exitCode,
      signal: extra.signal,
      now: this.now()
    });
    this.emit('fatal', report);
    return report;
  }

  /** 逐行喂入。stream: 'stdout' | 'stderr'（JVM 致命错误主要在 stderr） */
  ingest(line, stream = 'stderr') {
    if (this._finished) return null;
    const text = String(line == null ? '' : line);
    if (!text.trim()) return null;
    this._lineNo++;
    this._push(stream, text);

    const isAnchor = ANCHORS.some(re => re.test(text));
    if (isAnchor) this._anchorAt = this._lineNo;

    const rule = ALL_RULES.find(r => r.patterns.some(p => p.test(text)));
    if (rule) {
      // 显式守卫：_anchorAt 未设置时不得把 Infinity/溢出当成「锚点在窗口内」
      const anchored = this._anchorAt > 0 && this._lineNo - this._anchorAt <= CONTEXT_WINDOW;
      if (STRONG.has(rule.code) || isAnchor || anchored) {
        return this._report(rule, text, { stream });
      }
      // 上下文型、且当前无崩溃锚点 → 暂存，等锚点到来再确认，避免误杀被 catch 的警告
      this._pending.push({ rule, line: text, stream, at: this._lineNo });
      if (this._pending.length > 8) this._pending.shift();
      return null;
    }

    // 崩溃锚点出现 → 确认此前暂存的上下文型命中
    if (isAnchor && this._pending.length) {
      const hit = this._pending[this._pending.length - 1];
      if (this._lineNo - hit.at <= CONTEXT_WINDOW) {
        this._pending.length = 0;
        return this._report(hit.rule, hit.line, { stream: hit.stream });
      }
    }
    return null;
  }

  /** 进程退出兜底：即使流式阶段没命中，异常退出也必须给出人类可读报告，绝不静默卡死 */
  finish(exitInfo = {}) {
    if (this._finished) return null;
    this._finished = true;
    const code = exitInfo.code === undefined ? null : Number(exitInfo.code);
    const signal = exitInfo.signal || null;
    // 正常退出 / 主动停止（TERM、KILL 来自 game:stop）/ 已报过 → 不重复弹窗
    if (this._intentional) return null;
    if (code === 0 && !signal) return null;
    if (signal && /^(SIGTERM|SIGKILL|SIGINT)$/i.test(String(signal))) return null;
    if (this._fatalCount > 0) return null;

    const log = this._ring.map(x => x.text).join('\n');
    const analysis = analyzer.analyzeCrash({ log, exitCode: code, signal });
    const primary = analysis.primary;
    if (primary && (primary.severity === 'fatal' || primary.severity === 'error')) {
      const rule = ALL_RULES.find(r => r.code === primary.code) || {
        code: primary.code, title: primary.title, severity: primary.severity,
        suggestions: primary.suggestions || []
      };
      return this._report(rule, (primary.matches && primary.matches[0]) || `进程退出 code=${code} signal=${signal}`, {
        source: 'exit', exitCode: code, signal
      });
    }
    // 未识别特征但确实异常退出：也给出可读报告，保证用户永远不会被留在「启动中」
    return this._report({
      code: 'UNKNOWN_EXIT', severity: 'fatal',
      title: `游戏异常退出（退出码 ${code === null ? '未知' : code}${signal ? ` / ${signal}` : ''}）`,
      suggestions: ['打开控制台查看完整日志', '在崩溃分析页提交最新日志做深入诊断',
        '确认 Java 版本与游戏版本匹配', '检查是否分配内存过大或过小']
    }, `进程退出 code=${code} signal=${signal}`, { source: 'exit', exitCode: code, signal });
  }

  /** 监听 GameLauncher 的 log 事件（{level,text,stream}），返回 detach */
  attach(launcher) {
    if (!launcher || typeof launcher.on !== 'function') return () => {};
    const onLog = (l) => this.ingest(l && l.text != null ? l.text : l, l && l.stream ? l.stream : 'stderr');
    launcher.on('log', onLog);
    return () => { try { launcher.removeListener('log', onLog); } catch {} };
  }

  summary() {
    return {
      lines: this._lineNo, fatalCount: this._fatalCount,
      reported: [...this._reported], pending: this._pending.length,
      finished: this._finished, intentional: this._intentional
    };
  }
}

module.exports = {
  CrashGuardian, buildReport, ALL_RULES, STRONG, ANCHORS,
  FATAL_RULES, NATIVE_FATAL
};
