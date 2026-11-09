'use strict';
/**
 * electron/bootMetrics.cjs — 0.9.0 模块二A：冷启动可观测与预算
 *
 * 纯逻辑、零 electron / DOM / 同步 IO 依赖，可在 Node 单测里完整覆盖。
 * main.cjs 在真实启动链路打点并输出结构化日志；这里只负责「记录 / 分档 / 预算判定 / 格式化」。
 *
 * 【诚实边界】冷启动总时长 = Electron/Chromium 初始化 + 我们的启动路径。
 * 本模块报告的是「我们可控的启动路径耗时（首帧前各阶段）」，
 * 不把框架时间算作我们的优化成果，也不虚报达到某个数字。
 * 2s 预算用于给启动路径设可观测红线：超预算即输出告警，便于真机定位。
 */
const DEFAULT_BUDGET_MS = 2000;

/**
 * 创建启动时钟。now 可注入（测试用确定性时钟），默认 performance.now()。
 * @returns {{ mark(name:string):number, snapshot():object, now():number }}
 */
function createBootClock(now) {
  const clock = typeof now === 'function'
    ? now
    : (() => { try { return () => require('perf_hooks').performance.now(); } catch { return () => Date.now(); } })();
  const t0 = clock();
  const marks = [];
  return {
    now: clock,
    mark(name) {
      const at = clock();
      const elapsed = Math.max(0, at - t0);
      marks.push({ name: String(name), at, elapsed: Math.round(elapsed * 100) / 100 });
      return elapsed;
    },
    snapshot(extra = {}) {
      const total = marks.length
        ? Math.round((clock() - t0) * 100) / 100
        : 0;
      return {
        total,
        budgetMs: DEFAULT_BUDGET_MS,
        grade: classifyBoot(total),
        marks: marks.slice(),
        ...extra
      };
    }
  };
}

/**
 * 冷启动分档（相对预算）：
 *  invalid   —— 非数值或负值（拒绝伪造数据）
 *  excellent —— ≤ 60% 预算
 *  good      —— ≤ 100% 预算
 *  over      —— ≤ 150% 预算
 *  critical  —— > 150% 预算
 */
function classifyBoot(ms, budget = DEFAULT_BUDGET_MS) {
  const n = Number(ms);
  const b = Number(budget) > 0 ? Number(budget) : DEFAULT_BUDGET_MS;
  if (!Number.isFinite(n) || n < 0) return 'invalid';
  if (n <= b * 0.6) return 'excellent';
  if (n <= b) return 'good';
  if (n <= b * 1.5) return 'over';
  return 'critical';
}

/** 是否在预算内（严格拒绝 NaN / 负值 / 超预算，不谎报达标） */
function isUnderBudget(ms, budget = DEFAULT_BUDGET_MS) {
  const n = Number(ms);
  const b = Number(budget) > 0 ? Number(budget) : DEFAULT_BUDGET_MS;
  return Number.isFinite(n) && n >= 0 && n <= b;
}

/** 结构化日志行（可被宿主日志系统采集），含各阶段耗时，便于真机定位瓶颈 */
function format(snapshot) {
  const s = snapshot || { total: 0, marks: [], budgetMs: DEFAULT_BUDGET_MS };
  const budget = s.budgetMs || DEFAULT_BUDGET_MS;
  const grade = s.grade || classifyBoot(s.total, budget);
  const stages = (s.marks || []).map(m => `${m.name}=${m.elapsed}ms`).join(' → ');
  return `[MC-Next][boot] 首帧 ${s.total}ms / 预算 ${budget}ms · ${grade}${stages ? ' · ' + stages : ''}`;
}

module.exports = { createBootClock, classifyBoot, isUnderBudget, format, DEFAULT_BUDGET_MS };
