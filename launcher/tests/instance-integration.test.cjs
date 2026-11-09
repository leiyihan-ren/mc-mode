/**
 * instance-integration.test.cjs — 0.9.0 模块一A：启动链路隔离集成测试（E2E 级）
 *
 * 用 stubbed Electron + stubbed GameLauncher + stubbed os.homedir 真实跑一遍
 * registerIpc → dispatchChannel('game:launch')，断言 JVM 构造参数里的 gameDir
 * 指向**实例隔离目录**且该目录的 mods/config/saves 物理存在。
 *
 * 这是「多实例完全隔离」是否真正落进启动链路的关键防线：
 * 只测 isolation.gameDirForLaunch 不够，必须证明 ipc.launchGameCore 用了它。
 * os.homedir 被 stub 到临时根，测试完全自包含、不污染真实 ~/.mc-next。
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

const realOs = require('os');

function withStubs(sandboxHome, fn) {
  const captured = { launchers: [], preflightCalls: [] };
  const original = Module._load;

  class FakeGameLauncher extends EventEmitter {
    constructor(opts) { super(); this.opts = opts; this.process = null; this.running = false; captured.launchers.push(this); }
    launch() { this.process = { pid: 999999, kill() {} }; this.running = true; return this.process; }
    kill() { this.running = false; return Promise.resolve(); }
  }

  const fakeOs = Object.create(realOs);
  fakeOs.homedir = () => sandboxHome;

  Module._load = function (request) {
    if (request === 'electron') {
      return {
        ipcMain: { handle: () => {} },
        dialog: { showOpenDialog: async () => ({ canceled: true }) },
        shell: { openExternal: async () => {} }
      };
    }
    if (request === 'os') return fakeOs;
    if (request === '../engine/launcher') {
      return { GameLauncher: FakeGameLauncher, classifyLine: () => 'info', stripAnsi: (s) => s };
    }
    if (request === '../engine/preflight.cjs') {
      return {
        runPreflight: (o) => {
          captured.preflightCalls.push(o);
          return { ok: true, warnings: [], blocking: [], issues: [], resolvedJavaPath: null, java: {}, memory: {}, natives: {}, summary: 'ok' };
        }
      };
    }
    return original.apply(this, arguments);
  };

  const clearIpcCache = () => {
    for (const k of Object.keys(require.cache)) {
      if (k.includes('/electron/ipc.cjs') || k.includes('/electron/remoteControl.cjs')) delete require.cache[k];
    }
  };
  clearIpcCache();
  // registerIpc 会填充 HANDLERS（dispatchChannel 依赖它），需在 stub 生效期间执行。
  // 这里延迟到 fn 内首次 require 后由 loadIpc 完成，避免提前 require 绕过 stub。
  const loadIpc = () => {
    const ipc = require('../electron/ipc.cjs');
    ipc.registerIpc(null);
    return ipc;
  };
  return Promise.resolve(fn({ captured, sandboxHome, clearIpcCache, loadIpc })).finally(() => {
    Module._load = original;
    clearIpcCache();
  });
}

const versionJson = { libraries: [], mainClass: 'net.minecraft.client.main.Main', assetIndex: { id: '17' } };
const launchOpts = (extra) => ({
  versionId: '1.12.2', versionJson, minMemory: '1G', maxMemory: '2G',
  javaPath: '/usr/bin/java', ...extra
});

test('game:launch 显式 instanceId → JVM gameDir 指向隔离目录，且 mods/config/saves 物理存在', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-iint-'));
  try {
    await withStubs(home, async ({ captured, sandboxHome, loadIpc }) => {
      const iso = require('../engine/isolation.cjs');
      const ipc = loadIpc();
      // ipc 的 LAUNCHER_DIR = homedir()/.mc-next，已被 stub 到 sandboxHome
      const launcherDir = path.join(sandboxHome, '.mc-next');

      const r = await ipc.dispatchChannel('game:launch', launchOpts({ instanceId: 'mc-1.12.2' }));

      assert.equal(r.ok, true, `启动应成功: ${r.error || ''}`);
      assert.equal(captured.launchers.length, 1, '应真实构造一次 GameLauncher');
      const gd = captured.launchers[0].opts.gameDir;
      const expectDir = iso.gameDirOf(launcherDir, 'mc-1.12.2');
      assert.equal(gd, expectDir, 'JVM gameDir 必须等于实例隔离目录');
      assert.equal(r.gameDir, gd, '返回值 gameDir 与 JVM 实参一致');
      assert.equal(r.isolated, true);
      assert.equal(r.instanceId, 'mc-1.12.2');
      // 物理隔离目录真实落盘
      for (const d of ['mods', 'config', 'saves']) {
        assert.ok(fs.existsSync(path.join(gd, d)), `实例 ${d} 目录应被 ensureInstance 创建`);
      }
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('多实例完全隔离 E2E：切换 A/B 两次启动，gameDir 互不相同且不串味', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-iint-'));
  try {
    await withStubs(home, async ({ captured, sandboxHome, loadIpc }) => {
      const iso = require('../engine/isolation.cjs');
      const ipc = loadIpc();
      const launcherDir = path.join(sandboxHome, '.mc-next');

      // 先创建两个实例（对应 1.12.2 / 1.20.1）
      iso.ensureInstance(launcherDir, 'mc-1.12.2', { gameVersion: '1.12.2' });
      iso.ensureInstance(launcherDir, 'mc-1.20.1', { gameVersion: '1.20.1' });

      const a = await ipc.dispatchChannel('instance:switch', 'mc-1.12.2');
      assert.equal(a.ok, true);
      const launchA = await ipc.dispatchChannel('game:launch', launchOpts({})); // 无显式 id → 用激活实例
      assert.equal(launchA.ok, true, `A 启动应成功: ${launchA.error || ''}`);
      assert.equal(launchA.instanceId, 'mc-1.12.2');

      const b = await ipc.dispatchChannel('instance:switch', 'mc-1.20.1');
      assert.equal(b.ok, true);
      assert.equal(b.from, 'mc-1.12.2', '切换应记录来源');
      // 两次启动之间显式停止上一个实例（模拟玩家退出游戏后再切换版本启动）
      await ipc.dispatchChannel('game:stop');
      const launchB = await ipc.dispatchChannel('game:launch', launchOpts({}));
      assert.equal(launchB.ok, true, `B 启动应成功: ${launchB.error || ''}`);
      assert.equal(launchB.instanceId, 'mc-1.20.1');

      assert.notEqual(launchA.gameDir, launchB.gameDir, '两个版本的 gameDir 必须不同');
      const v = iso.verifyIsolation(launcherDir, 'mc-1.12.2', 'mc-1.20.1');
      assert.equal(v.isolated, true);
      assert.equal(v.overlaps.length, 0);
      assert.equal(captured.launchers.length, 2);
      assert.equal(captured.launchers[0].opts.gameDir, launchA.gameDir);
      assert.equal(captured.launchers[1].opts.gameDir, launchB.gameDir);
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('game:launch 不带 instanceId 且无激活实例 → 回落主 game 目录（不误隔离）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-iint-'));
  try {
    await withStubs(home, async ({ captured, sandboxHome, loadIpc }) => {
      const ipc = loadIpc();
      const r = await ipc.dispatchChannel('game:launch', launchOpts({}));
      assert.equal(r.ok, true, `启动应成功: ${r.error || ''}`);
      const gd = captured.launchers[0].opts.gameDir;
      assert.equal(gd, path.join(sandboxHome, '.mc-next', 'game'), '应回落共享主目录');
      assert.equal(r.isolated, false);
      assert.equal(r.instanceId, null);
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('game:launch 显式绝对 gameDir 优先级最高且不标隔离', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-iint-'));
  const custom = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-custom-'));
  try {
    await withStubs(home, async ({ captured, loadIpc }) => {
      const ipc = loadIpc();
      const r = await ipc.dispatchChannel('game:launch', launchOpts({ gameDir: custom, instanceId: 'whatever' }));
      assert.equal(r.ok, true, `启动应成功: ${r.error || ''}`);
      assert.equal(captured.launchers[0].opts.gameDir, custom);
      assert.equal(r.isolated, false);
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(custom, { recursive: true, force: true });
  }
});

test('instance:switch / active / verify handler 已注册；切到不存在实例被拒', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-iint-'));
  try {
    await withStubs(home, async ({ sandboxHome, loadIpc }) => {
      const iso = require('../engine/isolation.cjs');
      const ipc = loadIpc();
      for (const ch of ['instance:switch', 'instance:active', 'instance:verify']) {
        assert.equal(ipc.hasChannel(ch), true, `缺少 handler: ${ch}`);
      }
      assert.equal(await ipc.dispatchChannel('instance:active'), null, '初始无激活实例');
      const bad = await ipc.dispatchChannel('instance:switch', 'ghost');
      assert.equal(bad.ok, false, '不存在的实例不得切换成功');
      assert.match(bad.error, /不存在/);
      iso.ensureInstance(path.join(sandboxHome, '.mc-next'), 'real');
      const good = await ipc.dispatchChannel('instance:switch', 'real');
      assert.equal(good.ok, true);
      assert.equal(await ipc.dispatchChannel('instance:active'), 'real');
      const v = await ipc.dispatchChannel('instance:verify', { idA: 'a', idB: 'b' });
      assert.equal(v.isolated, true);
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
