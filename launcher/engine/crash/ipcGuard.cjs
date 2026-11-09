/**
 * ipcGuard.cjs — 0.9.0 模块一C：IPC / JNI 通信全局异常拦截防线
 *
 * 背景：v0.7.0 的 CrashGuardian 只拦截「游戏进程 stderr」的崩溃文本，但
 *   1) 桌面 IPC handler 自身抛异常时，invoke 直接 reject，前端若无 catch 会
 *      unhandledRejection / 卡在「启动中」，且不会弹窗；
 *   2) 底层 JNI / GL4ES / 渲染原生层抛出的 SIGSEGV、hs_err、UnsatisfiedLinkError
 *      等致命错误，与普通业务失败混在一起被静默吞掉。
 *
 * 本模块给**每一个** IPC handler 套一层统一防线：
 *   - 成功结果原样透传（零侵入，不破坏既有返回契约）
 *   - 任何同步抛错 / Promise reject 一律归一化为结构化错误对象，绝不 rethrow
 *     → 前端永远拿到 { ok:false, error, ... }，不会闪退或卡死
 *   - 命中原生层致命特征时，额外通过 onFatal 回调派发与 CrashDialog 同构的
 *     人类可读报告（复用 guardian.buildReport），由主进程 send('game:crash') 弹窗
 *
 * 设计红线：
 *   - 不伪造崩溃：只依据真实 Error 的 message/name/code/signal/stack 判定
 *   - 不误报：普通业务错误（如「账号不存在」）不得弹致命弹窗
 *   - onFatal / onError 自身抛错绝不掩盖原始错误，也不阻断返回
 *   - 纯函数 + 依赖可注入（now），离线 TDD 无需 Electron / 真实崩溃
 */
'use strict';

const { buildReport, NATIVE_FATAL } = require('./guardian.cjs');

/**
 * 原生层致命特征。刻意保持精确，避免把普通业务失败误判成崩溃。
 * 覆盖：POSIX 信号、JVM hs_err 报告、Windows 访问冲突、JNI 链接失败、JRE 启动失败。
 */
const NATIVE_FATAL_RE = /\b(SIGSEGV|SIGBUS|SIGABRT|SIGFPE|SIGILL|SIGKILL)\b|Segfault|Segmentation fault|native[\s_-]?crash|A fatal error has been detected by the Java Runtime Environment|hs_err_pid\d+\.log|Problematic frame:|Native frames:|EXCEPTION_ACCESS_VIOLATION|0xC0000005|UnsatisfiedLinkError|JNI_CreateJavaVM|libjvm\.so|libmcnext_jni\.so/i;

/** 兜底规则：guardian 的 NATIVE_FATAL 规则源不可用时仍能产出合规报告 */
const FALLBACK_RULE = {
  code: 'NATIVE_CRASH',
  severity: 'fatal',
  title: '底层原生通信崩溃（IPC / JNI / 渲染）',
  suggestions: [
    '本次操作已被安全拦截，启动器不会闪退，可重试或切换版本',
    '尝试在设置中切换渲染后端（GL4ES / VirGL / Zink）',
    '检查 Java 版本与 natives 库是否匹配当前游戏版本',
    '若为模组导致，先禁用最近新增的原生模组后重试'
  ]
};

/** 是否属于必须弹窗的原生层致命错误（而非普通业务失败）。 */
function isFatalError(err) {
  if (!err) return false;
  if (err.fatal === true || err.nativeCrash === true) return true;
  const text = [err.name, err.message, err.code, err.signal, err.stack]
    .filter(v => v !== undefined && v !== null && v !== '')
    .join(' | ');
  return NATIVE_FATAL_RE.test(text);
}

/** 把任意抛出值归一化为前端可安全消费的结构化错误（绝不 rethrow）。 */
function normalizeError(err, ctx = {}) {
  const fatal = ctx.fatal !== undefined ? !!ctx.fatal : isFatalError(err);
  const message = (err && err.message) ? String(err.message) : String(err == null ? '未知错误' : err);
  const out = {
    ok: false,
    error: message,
    fatal,
    code: fatal ? 'NATIVE_CRASH' : 'IPC_HANDLER_ERROR'
  };
  if (ctx.channel) out.channel = ctx.channel;
  if (err && err.signal) out.signal = err.signal;
  return out;
}

/** 组装与 CrashDialog 完全同构的报告（字段来自 guardian.buildReport）。 */
function buildFatalReport(err, channel, opts = {}) {
  const rule = (Array.isArray(NATIVE_FATAL) && NATIVE_FATAL.find(r => r && r.code === 'NATIVE_CRASH')) || FALLBACK_RULE;
  const reason = `[${channel || 'ipc'}] ${(err && err.message) || String(err)}`;
  const evidence = [
    `channel=${channel || 'unknown'}`,
    `name=${(err && err.name) || 'Error'}`,
    `signal=${(err && err.signal) || 'none'}`
  ];
  if (err && err.stack) {
    for (const line of String(err.stack).split('\n').slice(1, 4)) evidence.push(line.trim());
  }
  // guardian.buildReport 的 ctx.now 期望「数值时间戳」；而本模块与其它引擎一样
  // 允许注入「时钟函数」offline TDD。这里统一归一化，兼容两种形态。
  const nowVal = typeof opts.now === 'function' ? opts.now() : (opts.now || Date.now());
  return buildReport(rule, reason, {
    source: 'ipc',
    stream: 'ipc',
    evidence,
    now: nowVal
  });
}

/**
 * 包裹一个 IPC handler。
 * @param {string} channel channel 名（用于报告定位）
 * @param {Function} fn 原始 handler（签名 (evt, ...args)）
 * @param {object} opts { onFatal(report), onError(normalized, err), now }
 * @returns {Function} async 包装函数，成功原样透传、失败返回结构化错误
 */
function wrapHandler(channel, fn, opts = {}) {
  const onFatal = typeof opts.onFatal === 'function' ? opts.onFatal : null;
  const onError = typeof opts.onError === 'function' ? opts.onError : null;
  return async function guarded(...args) {
    try {
      return await fn(...args);
    } catch (err) {
      const fatal = isFatalError(err);
      const normalized = normalizeError(err, { fatal, channel });
      if (onError) {
        try { onError(normalized, err); } catch { /* 监控回调不得掩盖原错误 */ }
      }
      if (fatal) {
        let report = null;
        try { report = buildFatalReport(err, channel, opts); } catch { /* 报告构造失败不阻断 */ }
        if (report) {
          // 完整报告随错误对象返回：前端 Service 层据此做兜底广播（与 game:crash 双通道去重）
          normalized.report = report;
          if (onFatal) {
            try { onFatal(report); } catch { /* 上报失败仍返回结构化错误 */ }
          }
        }
      }
      return normalized;
    }
  };
}

module.exports = {
  NATIVE_FATAL_RE, FALLBACK_RULE,
  isFatalError, normalizeError, buildFatalReport, wrapHandler
};
