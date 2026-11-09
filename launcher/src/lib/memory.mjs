/**
 * src/lib/memory.mjs — 0.9.0 模块二C：渲染层内存守护内核（纯逻辑、零依赖）
 *
 * 解决「长时间挂机内存不暴涨」的两个真实根因：
 *  1) 事件订阅未注销 —— 页面反复 mount/unmount 累积监听器（DownloadPage / ConsolePage /
 *     JavaManagerPage / App 均曾缺 cleanup），且每次事件会被多个陈旧回调重复处理。
 *  2) 高频日志 / 采样缓冲无界或全量渲染 —— 列表 DOM 与数组随时间单调增长。
 *
 * 本模块提供三件工具，供 UI 层与 Service 层共用（单一数据源，可被 Node 单测直接 import）：
 *  - BUFFER_LIMITS       所有高频缓冲的硬上限常量
 *  - appendBounded       有界追加（超限丢弃最旧，绝不单调增长）
 *  - createSubscriptionSet / subscriptionRegistry
 *                        订阅收集与运行时仪表，用于「24h 等价挂机」结构不变量断言
 *
 * 【诚实边界】真实 24 小时 heap 曲线需要 Electron 运行时 + 真机观测，沙盒无 GUI。
 * 这里用高频等价事件（数千次 mount/unmount + 十万级日志）验证**结构性不变量**：
 * 活跃订阅数、缓冲长度、渲染窗口长度恒有上界且不单调增长。
 */
export const BUFFER_LIMITS = Object.freeze({
  LOG_LINES: 3000,        // 每 tab 日志缓冲上限
  RENDER_WINDOW: 500,     // 日志区一次最多渲染的行数（DOM 节点上界）
  HIGHLIGHT_BATCH: 800,   // 一次性 ANSI 着色批量
  METRIC_POINTS: 180,     // 性能小雷达采样点
  PROGRESS_EVENTS: 60,    // 整合包进度事件
  INSTALL_LOG: 40,        // Java 安装日志
  LOBBY_LOG: 20           // 联机大厅状态日志
});

/**
 * 有界追加：返回新数组，长度恒 <= cap；超限丢弃最旧元素。
 * cap 非正 / 非法时返回原数组（表示不发生变更，React 不会无谓重渲染）。
 * 输入不可变，不修改 list / items。
 */
export function appendBounded(list, items, cap) {
  const src = Array.isArray(list) ? list : [];
  const add = Array.isArray(items) ? items : [items];
  if (!Number.isFinite(cap) || cap <= 0) return src;
  if (add.length === 0) return src;
  const merged = src.concat(add);
  return merged.length > cap ? merged.slice(-cap) : merged;
}

/** 只取末尾窗口用于渲染，保证 DOM 节点数恒有上界 */
export function renderWindow(list, cap = BUFFER_LIMITS.RENDER_WINDOW) {
  const src = Array.isArray(list) ? list : [];
  if (!Number.isFinite(cap) || cap <= 0) return [];
  return src.length > cap ? src.slice(-cap) : src;
}

/**
 * 订阅收集器：组件 useEffect 内 add(off)，cleanup 调 disposeAll()。
 * disposeAll 幂等；单个 off 抛错不阻断其余；卸载后 add 不再接受（防御异步迟到）。
 */
export function createSubscriptionSet() {
  const offs = [];
  let disposed = false;
  return {
    add(off) {
      if (typeof off === 'function' && !disposed) offs.push(off);
      return off;
    },
    disposeAll() {
      if (disposed) return 0;
      disposed = true;
      let n = 0;
      for (const off of offs) {
        n++; // 已处理的订阅数：无论 off 是否抛错，该订阅都已从集合中移除
        try { off(); } catch { /* 单个取消失败不阻断其余订阅清理 */ }
      }
      offs.length = 0;
      return n;
    },
    get size() { return offs.length; },
    get disposed() { return disposed; }
  };
}

/**
 * 运行时订阅仪表：track(method) 返回幂等 release()。
 * stats() 暴露 total / byMethod / created / disposed / peak，供挂机测试断言不泄漏。
 */
export function createSubscriptionRegistry() {
  const active = new Map(); // method -> Set<id>
  let created = 0, disposed = 0, peak = 0, seq = 0;
  const totalActive = () => {
    let n = 0;
    for (const s of active.values()) n += s.size;
    return n;
  };
  return {
    track(method) {
      const id = ++seq;
      if (!active.has(method)) active.set(method, new Set());
      active.get(method).add(id);
      created++;
      const t = totalActive();
      if (t > peak) peak = t;
      let released = false;
      return () => {
        if (released) return false; // 幂等：重复 off 不重复计数
        released = true;
        const s = active.get(method);
        if (s) { s.delete(id); if (s.size === 0) active.delete(method); }
        disposed++;
        return true;
      };
    },
    stats() {
      const byMethod = {};
      for (const [m, s] of active) byMethod[m] = s.size;
      return { total: totalActive(), byMethod, created, disposed, peak };
    },
    reset() { active.clear(); created = 0; disposed = 0; peak = 0; seq = 0; }
  };
}

/** 全局单例：bridge.subscribe 用它记账，测试可 reset 后做确定性断言 */
export const subscriptionRegistry = createSubscriptionRegistry();

/**
 * 包装底层 off：登记仪表 + 幂等注销。
 * 底层取消函数抛错或重复调用，都不会让仪表计数泄漏 —— 这是挂机不变量的关键。
 * 纯函数（registry 可注入），供 Node 单测完整覆盖；bridge.subscribe 只做薄接线。
 */
export function wrapSubscription(off, method, registry = subscriptionRegistry) {
  const release = registry.track(method)
  let done = false
  return () => {
    if (done) return false
    done = true
    try { if (typeof off === 'function') off() } catch { /* 底层取消失败仍需注销仪表 */ }
    release()
    return true
  }
}
