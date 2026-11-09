/**
 * tests/architecture.test.cjs — 架构守卫（Arch Unit Test）
 *
 * v0.7.0 模块一「对齐大厂工程规范」的回归防线：纯静态源码扫描，
 * 不依赖 Electron / 浏览器 / 网络，可在任何 CI 里跑。
 * 一旦有人把 window.mcnext 或 console.log 写回 UI 层，这里立刻失败。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const CODE_DIRS = [SRC, path.join(ROOT, 'electron'), path.join(ROOT, 'engine')];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'build', '.git'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(jsx?|cjs|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 去掉整行注释，避免文档示例文本触发误报 */
function codeOnly(text) {
  return text.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*|\*\/)/.test(l)).join('\n');
}
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const read = (p) => fs.readFileSync(p, 'utf8');

test('目录结构 Feature 化：features/ 与 services/ 就位，旧 pages/ components/ 已清除', () => {
  assert.ok(fs.existsSync(path.join(SRC, 'features')), '缺少 src/features/');
  assert.ok(fs.existsSync(path.join(SRC, 'services/bridge.js')), '缺少 Service 门面');
  assert.ok(!fs.existsSync(path.join(SRC, 'pages')), '旧 src/pages/ 未清理');
  assert.ok(!fs.existsSync(path.join(SRC, 'components')), '旧 src/components/ 未清理');
  const groups = fs.readdirSync(path.join(SRC, 'features'), { withFileTypes: true })
    .filter(e => e.isDirectory()).map(e => e.name).sort();
  assert.deepEqual(groups,
    ['account', 'crash', 'launcher', 'mods', 'server', 'settings', 'shell', 'world']);
});

test('UI 层彻底统一：features/ 下零 window.mcnext、零 console 调试输出', () => {
  const files = walk(path.join(SRC, 'features'));
  assert.ok(files.length >= 23, `features/ 文件数异常: ${files.length}`);
  const bridge = files.filter(f => /window\.mcnext/.test(codeOnly(read(f))));
  const logs = files.filter(f => /console\.(log|debug|warn|info)\(/.test(codeOnly(read(f))));
  assert.deepEqual(bridge.map(rel), [], `UI 层不得直接访问底层桥: ${bridge.map(rel).join(', ')}`);
  assert.deepEqual(logs.map(rel), [], `UI 层不得有调试输出: ${logs.map(rel).join(', ')}`);
});

test('底层通信唯一出入口：仅 Service 门面与桥接实现层可接触 window.mcnext', () => {
  const allowed = new Set([
    'src/services/bridge.js',   // 唯一调用门面
    'src/lib/nativeBridge.js',  // Android 同构桥的注入实现
    'src/lib/remote.js'         // 仅做平台检测（判断桥是否存在），不发起 API 调用
  ]);
  const bad = walk(SRC)
    .filter(f => /window\.mcnext/.test(codeOnly(read(f))))
    .filter(f => !allowed.has(rel(f)));
  assert.deepEqual(bad.map(rel), [], `底层桥接泄漏到: ${bad.map(rel).join(', ')}`);
});

test('生产代码零 console.log：调试输出已收敛为正式日志流', () => {
  const bad = CODE_DIRS.flatMap(d => walk(d))
    .filter(f => /console\.(log|debug)\(/.test(codeOnly(read(f))));
  assert.deepEqual(bad.map(rel), [], `仍有散落调试输出: ${bad.map(rel).join(', ')}`);
});

test('features/ 内零相对 import：目录再移动也不会断链', () => {
  const bad = walk(path.join(SRC, 'features'))
    .filter(f => /from\s+['"]\.{1,2}\//.test(read(f)));
  assert.deepEqual(bad.map(rel), [], `仍有相对引用: ${bad.map(rel).join(', ')}`);
});

test('Service 门面由 preload 契约生成，路径别名已配置', () => {
  const s = read(path.join(SRC, 'services/bridge.js'));
  assert.match(s, /contract\.methodMap/, 'invoke 方法应由契约生成');
  assert.match(s, /contract\.eventMethodMap/, '事件方法应由契约生成');
  const v = read(path.join(ROOT, 'vite.config.mjs'));
  assert.match(v, /alias:/, 'Vite 缺少 @ 别名');
  assert.match(v, /'@'/, 'Vite 别名未指向 @');
  assert.match(v, /drop:\s*\['console'\]/, '生产构建未剥离 console.*');
});

// ==================== 0.7.0 模块三：安卓底层接线防回退 ====================
const JAVA_MAIN = path.join(ROOT, 'android/app/src/main/java/com/mcnext/launcher');
const BRIDGE_JAVA = path.join(ROOT, 'android/bridge/java/com/mcnext/launcher');

test('渲染后端：GPU 探测 / 自动选择 / 降级链 / 手动解析均已接线', () => {
  const rb = read(path.join(JAVA_MAIN, 'RenderBackend.java'));
  assert.match(rb, /autoSelect\s*\(/, '缺少按 GPU 自动选择');
  assert.match(rb, /resolve\s*\(/, '缺少自动/手动解析');
  assert.match(rb, /fallbackChain\s*\(/, '缺少降级链');
  assert.match(rb, /"auto"/, '缺少 auto 请求值');
  assert.ok(fs.existsSync(path.join(JAVA_MAIN, 'GpuProbe.java')), '缺少真实 GPU 探测');
  // JvmBridge 必须用 resolve（按 GPU 解析），且把结果写回 cfg 保证环境/库名同源
  const jb = read(path.join(JAVA_MAIN, 'JvmBridge.java'));
  assert.match(jb, /RenderBackend\.resolve\(/, 'JvmBridge 未走 resolve');
  assert.match(jb, /cfg\.renderer = backend\.id/, '渲染环境与 GL 库名未强制同源');
});

test('安卓启动链路：失败自动降级 + 崩溃/切后台强制释放虚拟按键', () => {
  const nr = read(path.join(BRIDGE_JAVA, 'NativeCommandRouter.java'));
  assert.match(nr, /RenderBackend\.fallbackChain/, '启动链路未接入降级链');
  assert.match(nr, /自动降级到/, '降级未给出可读日志');
  assert.match(nr, /InputBridge\.releaseAllHeld\(\)/, 'JVM 退出/崩溃未释放按键');
  const ma = read(path.join(BRIDGE_JAVA, 'MainActivity.java'));
  for (const life of ['onPause', 'onStop', 'onWindowFocusChanged', 'onDestroy']) {
    assert.match(ma, new RegExp(life + '\\s*\\('), `缺少生命周期 ${life}`);
  }
  assert.match(ma, /InputBridge\.releaseAllHeld\(\)/, 'Activity 生命周期未释放按键');
  const ib = read(path.join(JAVA_MAIN, 'input/InputBridge.java'));
  assert.match(ib, /releaseAllHeld\s*\(/, '缺少全局按键释放兜底');
  assert.match(ib, /heldKeys/, '缺少按下状态追踪');
});

test('移动端 GC 调度已写入启动参数，且尊重用户自选 GC', () => {
  const ab = read(path.join(JAVA_MAIN, 'ArgBuilder.java'));
  assert.match(ab, /mobileGcOptions/, '缺少移动端 GC 调度');
  assert.match(ab, /UseSerialGC/, '未降低 GC 线程数');
  assert.match(ab, /userPickedGc/, '未做用户自选 GC 去重');
  assert.match(ab, /UsePerfData/, '未关闭后台 perf 数据写入');
});

// ==================== 0.7.0 模块四：高可靠稳定性守护 ====================

test('崩溃守护：桌面 guardian + 安卓 AndroidCrashGuard 双端同源接线', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'engine/crash/guardian.cjs')), '缺少桌面崩溃守护器');
  assert.ok(fs.existsSync(path.join(ROOT, 'engine/crash/reaper.cjs')), '缺少进程树回收器');
  const g = read(path.join(ROOT, 'engine/crash/guardian.cjs'));
  assert.match(g, /class CrashGuardian/, '缺少守护器类');
  assert.match(g, /markIntentional/, '缺少主动停止去重');
  assert.match(g, /finish\s*\(/, '缺少异常退出兜底');
  assert.match(g, /CONTEXT_WINDOW|anchored/, '缺少防误杀上下文确认');
  const ag = read(path.join(JAVA_MAIN, 'AndroidCrashGuard.java'));
  assert.match(ag, /class AndroidCrashGuard/, '缺少安卓崩溃守护器');
  assert.match(ag, /synchronized Report ingest/, '安卓守护器未做并发保护');
  assert.match(ag, /UNKNOWN_EXIT/, '安卓缺少异常退出兜底');
});

test('崩溃弹窗：preload 事件 / CrashDialog 组件 / App 挂载 / 契约原生事件', () => {
  const pre = read(path.join(ROOT, 'electron/preload.cjs'));
  assert.match(pre, /onGameCrash.*game:crash/, 'preload 缺少崩溃事件通道');
  assert.ok(fs.existsSync(path.join(SRC, 'features/shell/components/CrashDialog.jsx')), '缺少崩溃弹窗组件');
  const dialog = read(path.join(SRC, 'features/shell/components/CrashDialog.jsx'));
  assert.match(dialog, /setGameRunning\(false\)/, '崩溃未复位 UI 状态（会卡在启动中）');
  const app = read(path.join(SRC, 'App.jsx'));
  assert.match(app, /<CrashDialog/, '崩溃弹窗未挂载到 App');
  const contract = JSON.parse(read(path.join(SRC, 'lib/bridge-contract.json')));
  assert.ok(contract.events.includes('game:crash'), '契约缺少 game:crash 事件');
  assert.ok(contract.nativeEvents.includes('game:crash'), '安卓未把崩溃事件列为原生事件');
});

test('进程树回收：detached spawn / killTree / 退出兜底 / 主进程 before-quit', () => {
  const l = read(path.join(ROOT, 'engine/launcher.js'));
  assert.match(l, /spawnOptions\(/, 'spawn 未使用 detached 进程组');
  assert.match(l, /spawnFailed:\s*true/, 'spawn 失败未补发 exit（UI 会卡在启动中）');
  assert.match(l, /finishOnce/, 'exit/close/error 未去重');
  assert.match(l, /killTree\(/, 'kill 未回收整棵进程树');
  const ipc = read(path.join(ROOT, 'electron/ipc.cjs'));
  assert.match(ipc, /guardian\.finish\(r\)/, '游戏退出未做崩溃兜底');
  assert.match(ipc, /processRegistry\.track/, '未登记子进程');
  assert.match(ipc, /reapAllProcesses/, '缺少全局回收导出');
  const main = read(path.join(ROOT, 'electron/main.cjs'));
  assert.match(main, /before-quit/, '主进程退出未挂兜底清理');
  assert.match(main, /reapAllProcesses\(/, 'before-quit 未调用进程回收');
});

test('安卓崩溃上报：logcat 逐行喂入 / finally 兜底 / 停止标记', () => {
  const nr = read(path.join(BRIDGE_JAVA, 'NativeCommandRouter.java'));
  assert.match(nr, /\.ingest\(line\)/, 'logcat 未喂入崩溃守护');
  assert.match(nr, /\.finish\(code, lastErr\)/, 'JVM finally 未做退出兜底');
  assert.match(nr, /\.markIntentional\(\)/, '主动停止未标记（会误报崩溃）');
  assert.match(nr, /emitCrashIfAny/, '缺少崩溃报告转换与上报');
  assert.match(nr, /game:crash/, '未 emit 崩溃事件');
});

// ==================== 0.9.0 模块一A：多实例完全隔离 ====================

test('多实例隔离：引擎激活会话 + 启动链路 gameDir 接线 + 前端平滑切换', () => {
  const iso = read(path.join(ROOT, 'engine/isolation.cjs'));
  for (const fn of ['getActiveInstance', 'switchInstance', 'gameDirForLaunch', 'verifyIsolation']) {
    assert.match(iso, new RegExp('function ' + fn + '\\s*\\('), `隔离引擎缺少 ${fn}`);
  }
  assert.match(iso, /renameSync/, '切换写入必须原子（tmp + rename）');
  // 启动链路必须真正使用隔离后的 gameDir，而不是硬编码 GAME_DIR
  const ipc = read(path.join(ROOT, 'electron/ipc.cjs'));
  assert.match(ipc, /gameDirForLaunch\(LAUNCHER_DIR, opts, GAME_DIR\)/, 'launchGameCore 未接入实例 gameDir 解析');
  assert.match(ipc, /gameDir: dirSel\.gameDir/, 'GameLauncher 仍用共享 GAME_DIR，隔离未生效');
  assert.match(ipc, /instance:switch/, '缺少实例切换 handler');
  const ctx = read(path.join(SRC, 'features/shell/InstanceContext.jsx'));
  assert.match(ctx, /SWITCH_TRANSITION_MS/, '缺少切换过渡时长');
  assert.match(ctx, /instanceSwitch/, 'Context 未调用真实切换 IPC');
  assert.match(ctx, /onInstanceChanged/, '缺少切换事件广播同步');
  const app = read(path.join(SRC, 'App.jsx'));
  assert.match(app, /InstanceProvider/, 'App 未包裹 InstanceProvider');
  assert.match(app, /instance-switching/, '未把过渡态应用到 app shell');
  const css = read(path.join(SRC, 'index.css'));
  assert.match(css, /\.app-shell\.instance-switching/, '缺少切换过渡 CSS');
  assert.ok(fs.existsSync(path.join(ROOT, 'tests/instance-integration.test.cjs')), '缺少启动链路隔离 E2E 测试');
});
