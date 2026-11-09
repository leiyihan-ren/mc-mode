/**
 * aiDigest.cjs — 0.9.0 通宵加固·模块三A：AI 可读崩溃日志摘要（纯函数，零侵入）
 *
 * 【为什么要这个模块】
 * 项目里已有三处各自产出崩溃信息，但对「AI / 自动化诊断」并不友好：
 *   1) engine/crash/analyzer.cjs      事后全量分析（findings / causedBy / modSuspects / summary）
 *   2) engine/crash/guardian.cjs      进程运行中实时拦截（人类可读 report：human/evidence/reason）
 *   3) engine/crash/logCleaner.cjs    latest.log 净化 + 纯文本报告（Java `at xxx` 堆栈、脱敏）
 *   4) engine/crash/ipcGuard.cjs      IPC/JNI handler 抛错的归一化 report（含 Error.stack 片段）
 *
 * 缺口 A：logCleaner 的 STACK_FRAME 只认 Java 字节码帧 `at pkg.Class.method(...)::`，
 *   而 JVM 原生崩溃（hs_err_pid*.log / JNI Segfault，正是模块一C 的防线目标）里
 *   真正致命的是 `Problematic frame: # C [libjvm.so+0x...]` 与 `Native frames:` 段的
 *   `C  [libgl4es_114.so+0x...]` 原生帧。这些帧此前 AI 读不到 —— 无法判断崩在
 *   libjvm / libgl4es / libmcnext_jni 哪个 .so。
 * 缺口 B：没有一个把「诊断结论 + 人类摘要 + Java 堆栈 + 原生帧 + 脱敏证据」
 *   聚合到**单一、有界、脱敏、结构化**对象的入口，AI 要么读全文 latest.log（token 爆炸、
 *   含 accessToken 等敏感信息），要么只拿到零散片段。
 *
 * 【本模块做什么】
 *   - parseNativeFrames()  解析 hs_err / JNI 原生帧（Problematic frame、C/J/Vv 帧）
 *   - buildAiDigest()     把上述四路输入聚合成结构化 digest + 固定上限的 Markdown，
 *                         全程复用 logCleaner.redact 脱敏（单一数据源），绝不输出原始 token
 *   - 纯函数、依赖可注入、无 IO、无 Electron 依赖，可离线 TDD
 *
 * 【诚实边界】不伪造崩溃、不臆测根因：所有字段均来自真实传入的日志/分析结果；
 *   未识别的特征如实标注 unknown/空数组，绝不生成"看起来像"的堆栈或建议。
 */
'use strict';

const analyzer = require('./analyzer.cjs');
const logCleaner = require('./logCleaner.cjs');

/** 输出硬上限：AI 上下文预算友好，防止巨型日志撑爆 token */
const AI_LIMITS = Object.freeze({
  FINDINGS: 8,          // 最多诊断条目
  STACK_TRACES: 4,      // 最多 Java 异常堆栈组
  FRAMES_PER_TRACE: 14, // 每组 Java 堆栈帧
  NATIVE_FRAMES: 16,    // 最多原生帧
  CAUSED_BY: 4,         // 每组 Caused by 链
  EVIDENCE: 30,         // 最多证据行
  MOD_SUSPECTS: 10,     // 最多可疑 Mod
  SUGGESTIONS: 6,       // 最多建议
  LINE_CHARS: 240,      // 单行截断
  MARKDOWN_CHARS: 12000 // 最终 Markdown 硬上限
});

/**
 * hs_err_pid*.log 原生帧特征（对齐 HotSpot 真实格式）：
 *   # A fatal error has been detected by the Java Runtime Environment:
 *   #  SIGSEGV (0xb) at pc=0x00007f..., pid=123, tid=456
 *   # Problematic frame:
 *   # C  [libgl4es_114.so+0x1a2b3]  glDrawElements+0x33
 *   Native frames: (J=compiled Java code, j=interpreted, Vv=VM code, C=native code)
 *   C  [libjvm.so+0x8ab123]  JVM_...+0x..
 *   j  net.minecraft...foo()+0
 *   J 1234 C1 ...
 */
const PROBLEMATIC_RE = /^#?\s*Problematic frame:/i;
const HS_HEAD_RE = /A fatal error has been detected by the Java Runtime Environment|SIGSEGV|SIGBUS|SIGFPE|SIGILL|EXCEPTION_ACCESS_VIOLATION|0xC0000005/i;
const NATIVE_FRAME_RE = /^\s*(?:#\s*)?([CJjVv]{1,2})\s+\[?([^\s\]]+\.so|[^\s\]]+\.dll|[^\s\]]+\.dylib|[^\s\]]+)\+?(0x[0-9a-fA-F]+)?\]?\s*(.*)$/;

/**
 * 从任意崩溃文本中解析 JVM 原生帧。
 * @param {string} text hs_err / stderr / latest.log 文本
 * @returns {{ hasNativeCrash: boolean, problematicFrame: string|null,
 *             signal: string|null, frames: Array<{kind:string,module:string,offset:string|null,symbol:string}> }}
 */
function parseNativeFrames(text) {
  const lines = String(text || '').split(/\r?\n/);
  const frames = [];
  let problematicFrame = null;
  let signal = null;
  let inNativeFrames = false;
  let sawHeader = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;

    const sig = /\b(SIGSEGV|SIGBUS|SIGFPE|SIGILL|SIGABRT)\b|EXCEPTION_ACCESS_VIOLATION|0xC0000005/i.exec(line);
    if (sig && !signal) signal = sig[1] ? sig[1].toUpperCase() : sig[0].toUpperCase();
    if (HS_HEAD_RE.test(line)) sawHeader = true;

    if (PROBLEMATIC_RE.test(line)) {
      // Problematic frame 的下一非空行是真实帧（可能带 "# " 前缀）
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const cand = lines[j].trim();
        if (!cand || PROBLEMATIC_RE.test(cand)) continue;
        if (/^#\s*(?:SIGSEGV|A fatal|JRE version|Java VM|Problematic)/i.test(cand)) continue;
        problematicFrame = logCleaner.redact(cand.replace(/^#\s*/, ''));
        const m = NATIVE_FRAME_RE.exec(cand.replace(/^#\s*/, ''));
        if (m) frames.push(mkFrame(m));
        break;
      }
      continue;
    }
    if (/^Native frames:/i.test(line)) { inNativeFrames = true; continue; }
    if (inNativeFrames) {
      if (/^Java frames:/i.test(line) || /^\[?\s*$/.test(line) && frames.length) { inNativeFrames = false; continue; }
      const m = NATIVE_FRAME_RE.exec(line.replace(/^#\s*/, ''));
      if (m) frames.push(mkFrame(m));
      else if (/^$/ .test(line)) continue;
      else if (frames.length) inNativeFrames = false; // 段落结束
    }
  }

  // 去重（同一 module+offset 原生帧可能既在 Problematic 又在 Native frames）
  const seen = new Set();
  const deduped = frames.filter(f => {
    const k = `${f.kind}|${f.module}|${f.offset}|${f.symbol}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return {
    hasNativeCrash: sawHeader || deduped.length > 0 || !!signal || !!problematicFrame,
    problematicFrame,
    signal,
    frames: deduped.slice(0, AI_LIMITS.NATIVE_FRAMES)
  };
}

/** @param {RegExpExecArray} m @returns {{kind:string,module:string,offset:string|null,symbol:string}} */
function mkFrame(m) {
  return {
    kind: m[1],
    module: m[2],
    offset: m[3] || null,
    symbol: logCleaner.redact((m[4] || '').trim()).slice(0, AI_LIMITS.LINE_CHARS)
  };
}

/** 安全截断 + 脱敏单行 */
function safeLine(v) {
  return logCleaner.redact(String(v == null ? '' : v)).slice(0, AI_LIMITS.LINE_CHARS);
}

/**
 * 把四路崩溃信息聚合成 AI 可读摘要。
 * 所有输入均可选，缺失时如实留空，绝不臆造。
 *
 * @param {object} input
 * @param {string} [input.log]           原始/latest.log 文本（用于原生帧 + 兜底净化）
 * @param {object} [input.analysis]      analyzer.analyzeCrash() 结果
 * @param {object} [input.clean]         logCleaner.cleanLatestLog() 结果
 * @param {object} [input.report]        guardian.buildReport() / ipcGuard 的结构化报告
 * @param {object} [input.exit]          {exitCode, signal, gameVersion, javaVersion}
 * @returns {{ ok: boolean, version: string, severity: string, primary: object|null,
 *             findings: object[], causedBy: string[], modSuspects: string[],
 *             javaStackTraces: object[], native: object, evidence: string[],
 *             suggestions: string[], human: string, redacted: boolean,
 *             truncated: boolean, markdown: string }}
 */
function buildAiDigest(input = {}) {
  const log = String(input.log || '');
  const analysis = input.analysis || (log ? analyzer.analyzeCrash({ log, ...(input.exit || {}) }) : null);
  const clean = input.clean || (log ? logCleaner.cleanLatestLog(log, { maxLines: 120 }) : null);
  const report = input.report || null;
  const native = parseNativeFrames(log || [report && report.reason, report && (report.evidence || []).join('\n')].filter(Boolean).join('\n'));

  const primary = (analysis && analysis.primary) || (report ? {
    code: report.code || 'UNKNOWN', title: report.title || '底层异常',
    severity: report.severity || 'fatal'
  } : null);
  const severity = (analysis && analysis.severity) || (report && report.severity) || (primary && primary.severity) || 'info';

  // 诊断条目：去重 + 截断
  const findings = [];
  const seenCodes = new Set();
  for (const f of (analysis && analysis.findings) || []) {
    if (!f || seenCodes.has(f.code)) continue;
    seenCodes.add(f.code);
    findings.push({
      code: f.code, title: safeLine(f.title), severity: f.severity,
      matches: (f.matches || []).slice(0, 3).map(safeLine),
      suggestions: (f.suggestions || []).slice(0, AI_LIMITS.SUGGESTIONS).map(safeLine)
    });
    if (findings.length >= AI_LIMITS.FINDINGS) break;
  }

  const causedBy = [
    ...((analysis && analysis.causedBy) || []),
    ...((clean && clean.stackTraces) || []).flatMap(t => t.causedBy || [])
  ].map(safeLine).filter(Boolean);
  const causedByDedup = [...new Set(causedBy)].slice(0, AI_LIMITS.CAUSED_BY * AI_LIMITS.STACK_TRACES);

  const modSuspects = [...new Set((analysis && analysis.modSuspects) || [])].slice(0, AI_LIMITS.MOD_SUSPECTS);

  const javaStackTraces = ((clean && clean.stackTraces) || []).slice(0, AI_LIMITS.STACK_TRACES).map(t => ({
    header: safeLine(t.header),
    frames: (t.frames || []).slice(0, AI_LIMITS.FRAMES_PER_TRACE).map(safeLine),
    causedBy: (t.causedBy || []).slice(0, AI_LIMITS.CAUSED_BY).map(safeLine)
  }));

  const evidence = [
    ...((report && report.evidence) || []),
    ...((clean && clean.keyLines) || [])
  ].map(safeLine).filter(Boolean);
  const evidenceDedup = [...new Set(evidence)].slice(0, AI_LIMITS.EVIDENCE);

  const suggestions = [
    ...((primary && primary.suggestions) || []),
    ...((report && report.suggestions) || []),
    ...findings.flatMap(f => f.suggestions)
  ].map(safeLine).filter(Boolean);
  const suggestionsDedup = [...new Set(suggestions)].slice(0, AI_LIMITS.SUGGESTIONS);

  const human = [
    (analysis && analysis.summary) || '',
    (report && report.human) || ''
  ].filter(Boolean).map(safeLine).join('\n');

  const digest = {
    ok: false, // 有崩溃信息才有意义；调用方据此判断
    version: '1.0',
    severity,
    primary: primary ? {
      code: primary.code, title: safeLine(primary.title), severity: primary.severity
    } : null,
    findings,
    causedBy: causedByDedup,
    modSuspects,
    javaStackTraces,
    native,
    evidence: evidenceDedup,
    suggestions: suggestionsDedup,
    human,
    redacted: true,
    truncated: false,
    markdown: ''
  };
  digest.ok = !!(analysis || report || native.hasNativeCrash || digest.findings.length);

  digest.markdown = toMarkdown(digest);
  if (digest.markdown.length > AI_LIMITS.MARKDOWN_CHARS) {
    digest.markdown = digest.markdown.slice(0, AI_LIMITS.MARKDOWN_CHARS) + '\n\n…（超出 AI 上下文预算，已截断）';
    digest.truncated = true;
  }
  return digest;
}

/** 把 digest 渲染成 AI 最易消费的 Markdown（分节、脱敏、有界） */
function toMarkdown(d) {
  const L = [];
  L.push('# MC-Next 崩溃诊断摘要（AI 可读）', '');
  L.push(`- 严重级别: **${d.severity}**`);
  if (d.primary) L.push(`- 主诊断: \`${d.primary.code}\` ${d.primary.title}`);
  if (d.native.signal) L.push(`- 致命信号: \`${d.native.signal}\``);
  if (d.native.problematicFrame) L.push(`- Problematic frame: \`${d.native.problematicFrame}\``);
  L.push('');

  if (d.human) { L.push('## 人话结论', '', d.human, ''); }
  if (d.findings.length) {
    L.push('## 诊断条目', '');
    for (const f of d.findings) {
      L.push(`- [\`${f.severity}\`] \`${f.code}\` ${f.title}`);
      for (const m of f.matches) L.push(`  - 证据: \`${m}\``);
    }
    L.push('');
  }
  if (d.native.hasNativeCrash) {
    L.push('## JVM / JNI 原生崩溃帧', '');
    if (d.native.frames.length) {
      for (const f of d.native.frames) {
        L.push(`- \`${f.kind}\` \`${f.module}${f.offset ? '+' + f.offset : ''}\` ${f.symbol}`);
      }
    } else {
      L.push('- 检测到原生崩溃特征，但未解析到具体帧（如实留空，不臆造）');
    }
    L.push('');
  }
  if (d.javaStackTraces.length) {
    L.push('## Java 异常堆栈', '');
    d.javaStackTraces.forEach((t, i) => {
      L.push(`### 堆栈 #${i + 1}: \`${t.header}\``);
      for (const fr of t.frames) L.push(`- \`${fr}\``);
      for (const cb of t.causedBy) L.push(`- Caused by: \`${cb}\``);
      L.push('');
    });
  }
  if (d.causedBy.length) { L.push('## Caused by 链', '', ...d.causedBy.map(x => `- \`${x}\``), ''); }
  if (d.modSuspects.length) { L.push('## 可疑 Mod', '', d.modSuspects.map(x => `- \`${x}\``).join('\n'), ''); }
  if (d.evidence.length) { L.push('## 关键证据（已脱敏）', '', ...d.evidence.map(x => `- \`${x}\``), ''); }
  if (d.suggestions.length) { L.push('## 排查建议', '', ...d.suggestions.map((x, i) => `${i + 1}. ${x}`), ''); }

  L.push('---', '', '> 本报告由 MC-Next 结构化聚合生成；敏感 token/UUID/IP/邮箱已脱敏；',
    '> 未识别的特征如实留空，不含任何推测或伪造数据。');
  return L.join('\n');
}

module.exports = {
  AI_LIMITS, parseNativeFrames, buildAiDigest, toMarkdown
};
