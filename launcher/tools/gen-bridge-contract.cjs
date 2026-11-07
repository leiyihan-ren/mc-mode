#!/usr/bin/env node
/**
 * gen-bridge-contract.cjs — 两端 UI 大一统的「单一数据源」指令契约生成器
 *
 * 从 electron/preload.cjs 真实解析：
 *   - 84 个 invoke 方法 / channel 映射（含参数个数，仅用于文档与断言）
 *   - 11 个事件订阅方法 / channel 映射
 * 生成三份同源契约：
 *   1. engine/bridge/contract.cjs          Node 侧（测试 / 远程 RPC 校验）
 *   2. src/lib/bridge-contract.json         渲染层 polyfill（Vite 打包）
 *   3. android/bridge/java/.../BridgeContract.java  Java 白名单（防止任意指令注入）
 *
 * 这样「安卓 UI 发出的每一个指令」都有据可查；新增桌面 channel 后重跑本脚本，
 * 测试 tests/native-bridge.test.cjs 会强制校验契约与 preload 完全一致。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const preload = fs.readFileSync(path.join(ROOT, 'electron', 'preload.cjs'), 'utf8');

const METHOD_RE = /^\s{2}([A-Za-z_$][\w$]*):\s*\(([^)]*)\)\s*=>\s*ipcRenderer\.invoke\('([^']+)'/gm;
const EVENT_RE = /^\s{2}([A-Za-z_$][\w$]*):\s*\(([^)]*)\)\s*=>\s*ipcRenderer\.on\('([^']+)'/gm;

function parse(re) {
  const out = [];
  let m;
  while ((m = re.exec(preload)) !== null) {
    const params = m[2].trim();
    out.push({ method: m[1], channel: m[3], arity: params ? params.split(',').length : 0 });
  }
  return out;
}
const invokes = parse(METHOD_RE);
const events = parse(EVENT_RE);
if (!invokes.length || !events.length) throw new Error('preload.cjs 解析失败：未找到 IPC 映射');

const INVOKE_CHANNELS = [...new Set(invokes.map(x => x.channel))];
const EVENT_CHANNELS = [...new Set(events.map(x => x.channel))];
const METHOD_MAP = Object.fromEntries(invokes.map(x => [x.method, x.channel]));
const EVENT_METHOD_MAP = Object.fromEntries(events.map(x => [x.method, x.channel]));

/**
 * 安卓本地（JNI / JvmBridge / GL4ES）直接执行的 channel。
 * 其余 invoke 全部走「远程 RPC」转发到 PC 端真实 IPC handler（由 ipc.cjs dispatchChannel 提供），
 * 不伪造任何结果；未配置 PC 时由 polyfill 返回明确错误。
 */
const NATIVE_CHANNELS = [
  'game:launch', 'game:stop', 'game:status',
  'java:scan', 'app:release', 'app:openExternal',
  'mobile:export', 'net:guide',
  // 模块五：Android 端本地做热更新检查 / 打开下载页（不静默安装 APK）
  'update:check', 'update:download'
];
/** 安卓本地真实产生的事件（JVM 日志 / 退出），其余事件由远程通道转发 */
const NATIVE_EVENTS = ['game:log', 'game:exit'];

for (const c of NATIVE_CHANNELS) {
  if (!INVOKE_CHANNELS.includes(c)) throw new Error(`NATIVE_CHANNELS 含不存在的 channel: ${c}`);
}
for (const c of NATIVE_EVENTS) {
  if (!EVENT_CHANNELS.includes(c)) throw new Error(`NATIVE_EVENTS 含不存在的事件: ${c}`);
}

const j = (v) => JSON.stringify(v, null, 2);

// ---- 1. Node 契约 ----
const nodeOut = `'use strict';
/**
 * 由 tools/gen-bridge-contract.cjs 自动生成，请勿手工修改。
 * 数据源：electron/preload.cjs（${invokes.length} 个 invoke 方法 / ${events.length} 个事件方法）
 */
const INVOKE_CHANNELS = Object.freeze(${j(INVOKE_CHANNELS)});
const EVENT_CHANNELS = Object.freeze(${j(EVENT_CHANNELS)});
const METHOD_MAP = Object.freeze(${j(METHOD_MAP)});
const EVENT_METHOD_MAP = Object.freeze(${j(EVENT_METHOD_MAP)});
const NATIVE_CHANNELS = Object.freeze(${j(NATIVE_CHANNELS)});
const NATIVE_EVENTS = Object.freeze(${j(NATIVE_EVENTS)});
const METHOD_ARITY = Object.freeze(${j(Object.fromEntries(invokes.map(x => [x.method, x.arity])))});

/** channel 落点分类：unknown / native / remote */
function classifyChannel(channel) {
  if (!INVOKE_CHANNELS.includes(channel)) return 'unknown';
  return NATIVE_CHANNELS.includes(channel) ? 'native' : 'remote';
}
function classifyEvent(channel) {
  if (!EVENT_CHANNELS.includes(channel)) return 'unknown';
  return NATIVE_EVENTS.includes(channel) ? 'native' : 'remote';
}
module.exports = {
  INVOKE_CHANNELS, EVENT_CHANNELS, METHOD_MAP, EVENT_METHOD_MAP,
  NATIVE_CHANNELS, NATIVE_EVENTS, METHOD_ARITY, classifyChannel, classifyEvent
};
`;

// ---- 2. 渲染层 JSON ----
const jsonOut = j({
  generatedFrom: 'electron/preload.cjs',
  invoke: INVOKE_CHANNELS,
  events: EVENT_CHANNELS,
  methodMap: METHOD_MAP,
  eventMethodMap: EVENT_METHOD_MAP,
  native: NATIVE_CHANNELS,
  nativeEvents: NATIVE_EVENTS
}) + '\n';

// ---- 3. Java 白名单 ----
const javaArr = (name, arr) =>
  `    public static final String[] ${name} = {\n` +
  arr.map((s, i) => `        "${s}"${i === arr.length - 1 ? '' : ','}`).join('\n') + '\n    };';
const javaOut = `package com.mcnext.launcher;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * 由 tools/gen-bridge-contract.cjs 自动生成，请勿手工修改。
 * 与桌面端 electron/preload.cjs 完全同源：只有白名单内的 channel 才会被派发到 JNI / 远程 RPC。
 */
public final class BridgeContract {
    private BridgeContract() {}

${javaArr('INVOKE_CHANNELS', INVOKE_CHANNELS)}

${javaArr('EVENT_CHANNELS', EVENT_CHANNELS)}

${javaArr('NATIVE_CHANNELS', NATIVE_CHANNELS)}

${javaArr('NATIVE_EVENTS', NATIVE_EVENTS)}

    private static final Set<String> INVOKE_SET = new HashSet<>(Arrays.asList(INVOKE_CHANNELS));
    private static final Set<String> EVENT_SET = new HashSet<>(Arrays.asList(EVENT_CHANNELS));
    private static final Set<String> NATIVE_SET = new HashSet<>(Arrays.asList(NATIVE_CHANNELS));

    public static boolean isKnownInvoke(String channel) { return INVOKE_SET.contains(channel); }
    public static boolean isKnownEvent(String channel) { return EVENT_SET.contains(channel); }
    public static boolean isNative(String channel) { return NATIVE_SET.contains(channel); }

    /** unknown / native / remote */
    public static String classify(String channel) {
        if (!isKnownInvoke(channel)) return "unknown";
        return isNative(channel) ? "native" : "remote";
    }
}
`;

const targets = [
  ['engine/bridge/contract.cjs', nodeOut],
  ['src/lib/bridge-contract.json', jsonOut],
  ['android/bridge/java/com/mcnext/launcher/BridgeContract.java', javaOut]
];
for (const [rel, content] of targets) {
  const p = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  console.log(`[gen] ${rel}`);
}
console.log(`[done] ${invokes.length} invoke 方法 / ${INVOKE_CHANNELS.length} channel, ` +
  `${events.length} 事件方法 / ${EVENT_CHANNELS.length} 事件, native=${NATIVE_CHANNELS.length}`);
