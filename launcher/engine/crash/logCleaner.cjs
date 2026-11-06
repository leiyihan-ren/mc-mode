/**
 * logCleaner.cjs — latest.log 正则清洗与关键堆栈提取
 *
 * 真实 MC 日志形态：
 *  [16:32:10] [main/INFO]: ...
 *  [16:32:12] [main/ERROR]: ...
 *  java.lang.RuntimeException: ...
 *      at net.minecraft...            ← 堆栈帧
 *  Caused by: java.io.IOException: ...
 *      ... 12 more
 *  ---- Minecraft Crash Report ----  ← 崩溃报告块
 *
 * 能力：结构化解析、错误/警告提取、堆栈聚合、Caused by 链、
 * 相邻重复刷屏压缩、敏感信息脱敏、噪声剔除、可读报告输出。
 */
'use strict';

const { parseLogLine } = require('../server/console.cjs');

const EXCEPTION_HEAD = /^\s*(?:[\w$]+(?:\.[\w$]+)*)(?:Exception|Error|Throwable)(?::.*)?$/;
const STACK_FRAME = /^\s+(?:at\s+[\w$.<>/]+\(|(?:\.\.\.\s+\d+\s+more)|(?:Caused by:|Suppressed:))/;
const TOKEN_PATTERNS = [
  [/(--accessToken\s+)\S+/gi, '$1<redacted>'],
  [/(--uuid\s+)[0-9a-f-]{32,36}/gi, '$1<redacted>'],
  [/(Authorization:\s*Bearer\s+)\S+/gi, '$1<redacted>'],
  [/([?&](?:accessToken|session|token|sid)=)[^&\s]+/gi, '$1<redacted>'],
  [/(\bsession(?:Id)?["'=:\s]{1,4})[A-Za-z0-9._-]{16,}/gi, '$1<redacted>'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<email>'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?\b/g, '<ip>']
];

function redact(text) {
  let out = String(text);
  for (const [re, rep] of TOKEN_PATTERNS) out = out.replace(re, rep);
  return out;
}

function isStackLine(line) { return STACK_FRAME.test(line) || EXCEPTION_HEAD.test(line) || /^Caused by:/.test(line); }

/** 聚合异常堆栈：异常头 → frames → Caused by 链 */
function extractStackTraces(lines) {
  const traces = [];
  let cur = null;
  for (const line of lines) {
    if (/^Caused by:/.test(line)) {
      if (cur) cur.causedBy.push(line.replace(/^Caused by:\s*/, ''));
      else traces.push(cur = { header: line, frames: [], causedBy: [] });
      continue;
    }
    if (EXCEPTION_HEAD.test(line) && !/^\s+at\s/.test(line)) {
      cur = { header: line.trim(), frames: [], causedBy: [] };
      traces.push(cur);
      continue;
    }
    if (cur && (/^\s+at\s/.test(line) || /^\s+\.\.\.\s+\d+\s+more/.test(line) || /^\s+Suppressed:/.test(line))) {
      cur.frames.push(line.trim());
    } else if (cur && !isStackLine(line) && line.trim()) {
      cur = null;
    }
  }
  return traces.filter(t => t.header || t.frames.length);
}

/** 相邻重复行压缩（真实刷屏场景：Can't keep up! / 网络超时） */
function dedupeAdjacent(lines) {
  const out = [];
  for (const line of lines) {
    const last = out[out.length - 1];
    if (last && last.text === line) last.count++;
    else out.push({ text: line, count: 1 });
  }
  return out;
}

/**
 * 清洗 latest.log。
 * @param {string} text
 * @param {object} opts {maxLines, keepContext, redactTokens}
 */
function cleanLatestLog(text, opts = {}) {
  const maxLines = opts.maxLines || 300;
  const keepContext = opts.keepContext === undefined ? 2 : opts.keepContext;
  const raw = String(text || '').split(/\r?\n/).filter(l => l.trim() !== '');
  const doRedact = opts.redactTokens !== false;
  const lines = raw.map(l => doRedact ? redact(l) : l);
  const parsed = lines.map((l, i) => ({ ...parseLogLine(l), index: i }));

  const errors = [], warnings = [], stackLines = [], reportBlock = [];
  let inReport = false, noiseRemoved = 0;
  const idxSet = new Set();
  for (const p of parsed) {
    if (/---- Minecraft Crash Report ----/.test(p.text)) inReport = true;
    if (inReport) { reportBlock.push(p); idxSet.add(p.index); if (/---- End of report|End of Report/.test(p.text)) inReport = false; continue; }
    if (p.level === 'error' || p.level === 'fatal') { errors.push(p); idxSet.add(p.index); continue; }
    if (p.level === 'warn') { warnings.push(p); idxSet.add(p.index); continue; }
    if (isStackLine(p.raw)) { stackLines.push(p); idxSet.add(p.index); continue; }
    noiseRemoved++;
  }
  // 错误行前后保留上下文
  if (keepContext > 0) {
    for (const e of errors) {
      for (let i = Math.max(0, e.index - keepContext); i <= Math.min(lines.length - 1, e.index + keepContext); i++) idxSet.add(i);
    }
  }
  const kept = parsed.filter(p => idxSet.has(p.index)).slice(-maxLines);
  const deduped = dedupeAdjacent(kept.map(p => p.text));
  const stackTraces = extractStackTraces(stackLines.map(p => p.raw));

  const keyLines = [];
  if (reportBlock.length) keyLines.push(...reportBlock.slice(0, 4).map(p => p.text));
  for (const t of stackTraces.slice(0, 3)) {
    keyLines.push(t.header);
    for (const cb of t.causedBy.slice(0, 2)) keyLines.push('Caused by: ' + cb);
  }
  for (const e of errors.slice(-5)) keyLines.push(e.text);

  return {
    totalLines: raw.length, keptLines: kept.length, noiseRemoved,
    errors, warnings, stackLines, stackTraces, reportBlock,
    lines: kept, deduped, keyLines,
    redacted: doRedact,
    summary: keyLines.length ? keyLines.slice(0, 8).join('\n') : '日志中未发现错误、警告或异常堆栈'
  };
}

/** 生成纯文本诊断报告 */
function toPlainTextReport(result, title = 'MC-Next 日志净化报告') {
  const out = [
    `===== ${title} =====`,
    `总行数 ${result.totalLines} / 保留 ${result.keptLines} / 剔除噪声 ${result.noiseRemoved} / 脱敏 ${result.redacted ? '是' : '否'}`,
    `错误 ${result.errors.length} 条 / 警告 ${result.warnings.length} 条 / 堆栈 ${result.stackTraces.length} 组`,
    '', '--- 关键报错 ---', ...result.keyLines, ''
  ];
  for (let i = 0; i < result.stackTraces.length; i++) {
    const t = result.stackTraces[i];
    out.push(`--- 堆栈 #${i + 1} ---`, t.header, ...t.frames.slice(0, 12));
    for (const cb of t.causedBy) out.push('Caused by: ' + cb);
    out.push('');
  }
  out.push('--- 保留日志（重复已压缩）---');
  for (const d of result.deduped) out.push(d.count > 1 ? `${d.text}  (重复 ${d.count} 次)` : d.text);
  return out.join('\n');
}

module.exports = {
  EXCEPTION_HEAD, STACK_FRAME, redact, isStackLine, extractStackTraces,
  dedupeAdjacent, cleanLatestLog, toPlainTextReport
};
