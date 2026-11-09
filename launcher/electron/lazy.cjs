'use strict';
/**
 * electron/lazy.cjs — 0.9.0 模块二A：主进程惰性模块代理
 *
 * 【为什么需要，且为什么这样设计】
 * 对 ipc.cjs 顶层 30+ 引擎模块做过真实 require 耗时剖析：串行累加约 16ms，
 * 冷启动大头其实是 Electron/Chromium 初始化与同步磁盘 IO 阻塞事件循环，
 * 而非模块解析本身（数据见 DELIVERY-0.9.0.md，不虚报「压缩 X 毫秒」）。
 * 但「非核心功能服务」（Modrinth / 皮肤 / 世界 / 联机房间 / 整合包 / 外观 / 自动更新…）
 * 在启动关键路径上根本不会被访问，惰性代理带来的真实收益是：
 *   1) 首帧前零加载这些服务及其传递依赖，减少启动期解析与内存常驻；
 *   2) 首次真实 IPC 访问才 require，之后命中 require.cache，零额外开销；
 *   3) 保持 `const X = require(...)` 的调用点形态不变（Proxy get 拦截），
 *      因此所有 handler 引用零改动、测试用 Module._load 注入的 stub 依然命中
 *      （惰性 require 发生在 stub 生效的 handler 执行期内）。
 *
 * 【实现约束】
 *  - 返回「原始属性值」而非 bind 包装：候选模块均导出对象字面量，
 *    保持函数/类身份稳定，不破坏 new / instanceof / 断言比较。
 *  - Symbol / then / toJSON 等内部探测不触发加载，避免 console / Promise
 *    序列化 / 断言工具意外提前加载模块。
 *  - __isLazy / __loaded / __module 为可观测探针，供测试断言「未访问不加载」。
 */
function lazy(loader) {
  let mod = null;
  const load = () => (mod === null ? (mod = loader()) : mod);
  // 这些属性名用于运行时探测（Promise 判定、序列化、检查器），
  // 拦截为 undefined，避免一次无心的打印就吃掉惰性收益。
  const NON_LOADING = new Set([
    'then', 'catch', 'finally', 'toJSON', 'inspect', 'constructor',
    Symbol.toStringTag, Symbol.iterator, Symbol.toPrimitive,
    '$$typeof', 'nodeType', '_isReactElement'
  ]);
  return new Proxy(Object.create(null), {
    get(_t, prop) {
      if (prop === '__isLazy') return true;
      if (prop === '__loaded') return mod !== null;
      if (prop === '__module') return load();
      if (typeof prop !== 'string' || NON_LOADING.has(prop)) return undefined;
      return load()[prop];
    },
    set(_t, prop, value) {
      if (typeof prop === 'string') load()[prop] = value;
      return true;
    },
    has(_t, prop) {
      if (prop === '__isLazy' || prop === '__loaded' || prop === '__module') return true;
      if (typeof prop !== 'string' || NON_LOADING.has(prop)) return false;
      return prop in load();
    },
    ownKeys() { return Reflect.ownKeys(load()); },
    getOwnPropertyDescriptor(_t, prop) {
      const d = Reflect.getOwnPropertyDescriptor(load(), prop);
      // target 无不可配置属性，返回 configurable:true 的副本满足 Proxy invariant
      return d ? { ...d, configurable: true } : undefined;
    }
  });
}

/** 供测试 / 诊断：判断一个值是否为惰性代理 */
function isLazy(v) {
  try { return !!(v && v.__isLazy === true); } catch { return false; }
}

module.exports = { lazy, isLazy };
