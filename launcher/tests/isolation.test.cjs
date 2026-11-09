'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const iso = require('../engine/isolation.cjs');

const roots = [];
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-iso-')); roots.push(d); return d; }
after(() => { for (const d of roots) fs.rmSync(d, { recursive: true, force: true }); });

test('ensureInstance 建立完整隔离布局与共享目录，且幂等', () => {
  const root = tmp();
  const a = iso.ensureInstance(root, '1.20.1-fabric', { gameVersion: '1.20.1', loader: 'fabric' });
  for (const d of iso.ISOLATED_DIRS) assert.ok(fs.existsSync(path.join(a.gameDir, d)), `缺少 ${d}`);
  for (const d of iso.SHARED_DIRS) assert.ok(fs.existsSync(path.join(root, d)), `缺少共享 ${d}`);
  assert.equal(a.meta.gameVersion, '1.20.1');
  assert.equal(a.meta.isolated, true);
  const b = iso.ensureInstance(root, '1.20.1-fabric', { name: '我的整合包' });
  assert.equal(b.meta.createdAt, a.meta.createdAt, '不应覆盖创建时间');
  assert.equal(b.meta.name, '我的整合包');
});

test('两个实例的 mods/saves/config 物理隔离', () => {
  const root = tmp();
  const A = iso.ensureInstance(root, 'A').gameDir;
  const B = iso.ensureInstance(root, 'B').gameDir;
  fs.writeFileSync(path.join(A, 'mods', 'jei.jar'), 'AAA');
  fs.mkdirSync(path.join(A, 'saves', '世界A'));
  fs.writeFileSync(path.join(A, 'config', 'jei.cfg'), 'a=1');
  assert.equal(fs.readdirSync(path.join(B, 'mods')).length, 0);
  assert.equal(fs.readdirSync(path.join(B, 'saves')).length, 0);
  const iA = iso.instanceInfo(root, 'A');
  const iB = iso.instanceInfo(root, 'B');
  assert.equal(iA.mods, 1); assert.equal(iA.saves, 1); assert.ok(iA.bytes > 0);
  assert.equal(iB.mods, 0); assert.equal(iB.saves, 0);
});

test('buildInstanceArgs 生成真实 MC 启动参数', () => {
  const root = tmp();
  const args = iso.buildInstanceArgs(root, '1.21.1', { assetIndex: '17', versionType: 'release' });
  assert.equal(args[args.indexOf('--gameDir') + 1], path.join(root, 'instances', '1.21.1', '.minecraft'));
  assert.equal(args[args.indexOf('--assetsDir') + 1], path.join(root, 'assets'));
  assert.ok(args.includes('--assetIndex') && args.includes('17'));
  assert.ok(args.includes('--versionType'));
});

test('listInstances 与 instanceInfo 反映真实磁盘状态', () => {
  const root = tmp();
  iso.ensureInstance(root, 'x', { gameVersion: '1.20.1' });
  iso.ensureInstance(root, 'y');
  const list = iso.listInstances(root);
  assert.deepEqual(list.map(i => i.id).sort(), ['x', 'y']);
  assert.equal(list.find(i => i.id === 'x').gameVersion, '1.20.1');
  fs.writeFileSync(path.join(iso.gameDirOf(root, 'x'), 'mods', 'a.jar'), 'x');
  fs.writeFileSync(path.join(iso.gameDirOf(root, 'x'), 'logs', 'latest.log'), 'log');
  const info = iso.instanceInfo(root, 'x');
  assert.equal(info.mods, 1); assert.equal(info.logs, 1); assert.deepEqual(info.saveNames, []);
});

test('migrateLegacy 真实迁移旧 .minecraft（移动与复制两种模式）', () => {
  const root = tmp();
  const legacy = path.join(root, 'legacy-.minecraft');
  fs.mkdirSync(path.join(legacy, 'mods'), { recursive: true });
  fs.mkdirSync(path.join(legacy, 'saves', '旧存档'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'mods', 'optifine.jar'), 'MOD');
  fs.writeFileSync(path.join(legacy, 'saves', '旧存档', 'level.dat'), 'LEVEL');
  const moved = iso.migrateLegacy(root, 'legacy', legacy);
  assert.ok(moved.includes(path.join('mods', 'optifine.jar')));
  assert.equal(fs.readFileSync(path.join(iso.gameDirOf(root, 'legacy'), 'mods', 'optifine.jar'), 'utf8'), 'MOD');
  assert.ok(!fs.existsSync(path.join(legacy, 'mods', 'optifine.jar')), '移动模式原文件应消失');
  // 复制模式
  const root2 = tmp();
  const legacy2 = path.join(root2, 'old');
  fs.mkdirSync(path.join(legacy2, 'config'), { recursive: true });
  fs.writeFileSync(path.join(legacy2, 'config', 'a.cfg'), 'CFG');
  iso.migrateLegacy(root2, 'new', legacy2, { copy: true });
  assert.equal(fs.readFileSync(path.join(legacy2, 'config', 'a.cfg'), 'utf8'), 'CFG');
  assert.equal(fs.readFileSync(path.join(iso.gameDirOf(root2, 'new'), 'config', 'a.cfg'), 'utf8'), 'CFG');
});

test('removeInstance 非空保护与 force 删除', () => {
  const root = tmp();
  iso.ensureInstance(root, 'empty');
  assert.equal(iso.removeInstance(root, 'empty'), true);
  assert.equal(iso.listInstances(root).length, 0);
  iso.ensureInstance(root, 'busy');
  fs.writeFileSync(path.join(iso.gameDirOf(root, 'busy'), 'mods', 'a.jar'), 'x');
  assert.throws(() => iso.removeInstance(root, 'busy'), /非空/);
  assert.equal(iso.removeInstance(root, 'busy', { force: true }), true);
});

test('safeId 拦截路径穿越与非法字符', () => {
  assert.throws(() => iso.safeId('../evil'), /非法实例 id/);
  assert.throws(() => iso.safeId('a/b'), /非法实例 id/);
  assert.throws(() => iso.safeId(''), /不能为空/);
  assert.equal(iso.safeId('1.20.1-forge'), '1.20.1-forge');
});

// ==================== 0.9.0 模块一A：激活实例会话 / 一键切换 / 启动链路隔离 ====================

test('getActiveInstance：无记录返回 null，不伪造；损坏文件容错', () => {
  const root = tmp();
  assert.equal(iso.getActiveInstance(root), null);
  fs.writeFileSync(path.join(root, iso.ACTIVE_FILE), '{ broken json');
  assert.equal(iso.getActiveInstance(root), null, '损坏的激活文件应容错返回 null');
});

test('switchInstance：真实校验目标存在；不存在时拒绝且保留原激活态', () => {
  const root = tmp();
  iso.ensureInstance(root, 'A');
  iso.ensureInstance(root, 'B');
  const r1 = iso.switchInstance(root, 'A');
  assert.equal(r1.ok, true);
  assert.equal(r1.from, null);
  assert.equal(r1.to, 'A');
  assert.equal(r1.gameDir, iso.gameDirOf(root, 'A'));
  assert.equal(iso.getActiveInstance(root), 'A');

  const r2 = iso.switchInstance(root, 'B');
  assert.equal(r2.ok, true);
  assert.equal(r2.from, 'A', '应记录切换来源供 UI 过渡');
  assert.equal(r2.to, 'B');
  assert.equal(iso.getActiveInstance(root), 'B');

  const bad = iso.switchInstance(root, '不存在');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /不存在/);
  assert.equal(iso.getActiveInstance(root), 'B', '失败切换不得改坏激活态');
});

test('switchInstance 原子写入：不留 .tmp，切换即确保隔离目录齐备', () => {
  const root = tmp();
  iso.ensureInstance(root, 'X');
  iso.switchInstance(root, 'X');
  assert.ok(!fs.existsSync(path.join(root, iso.ACTIVE_FILE + '.tmp')), '原子 rename 后不应残留 .tmp');
  const gd = iso.gameDirOf(root, 'X');
  for (const d of ['mods', 'config', 'saves']) assert.ok(fs.existsSync(path.join(gd, d)));
});

test('多实例完全隔离：1.12.2 与 1.20.1 的 mods/config/saves 两两不同且不嵌套', () => {
  const root = tmp();
  iso.ensureInstance(root, 'mc-1.12.2', { gameVersion: '1.12.2' });
  iso.ensureInstance(root, 'mc-1.20.1', { gameVersion: '1.20.1' });
  const v = iso.verifyIsolation(root, 'mc-1.12.2', 'mc-1.20.1');
  assert.equal(v.isolated, true);
  assert.equal(v.overlaps.length, 0);
  // 真实写入互不干扰
  fs.writeFileSync(path.join(v.pathA.mods, 'jei-1.12.jar'), 'OLD');
  fs.writeFileSync(path.join(v.pathA.config, 'forge.cfg'), 'A');
  fs.mkdirSync(path.join(v.pathA.saves, '老存档'));
  assert.equal(fs.readdirSync(v.pathB.mods).length, 0, '1.20.1 的 mods 不得出现 1.12.2 的模组');
  assert.equal(fs.readdirSync(v.pathB.saves).length, 0, '存档必须隔离');
  assert.equal(fs.readdirSync(v.pathB.config).length, 0, '配置必须隔离');
  assert.notEqual(v.pathA.mods, v.pathB.mods);
});

test('gameDirForLaunch 优先级：显式 gameDir > instanceId > 激活实例 > 默认', () => {
  const root = tmp();
  iso.ensureInstance(root, 'explicit');
  iso.ensureInstance(root, 'active');
  const def = path.join(root, 'game');

  const s0 = iso.gameDirForLaunch(root, {}, def);
  assert.equal(s0.gameDir, def);
  assert.equal(s0.isolated, false);
  assert.equal(s0.instanceId, null);

  iso.switchInstance(root, 'active');
  const s1 = iso.gameDirForLaunch(root, {}, def);
  assert.equal(s1.instanceId, 'active', '无显式参数时回落当前激活实例');
  assert.equal(s1.isolated, true);

  const s2 = iso.gameDirForLaunch(root, { instanceId: 'explicit' }, def);
  assert.equal(s2.instanceId, 'explicit', '显式 instanceId 覆盖激活实例');
  assert.equal(s2.gameDir, iso.gameDirOf(root, 'explicit'));

  const custom = path.join(root, 'custom-absolute');
  const s3 = iso.gameDirForLaunch(root, { gameDir: custom, instanceId: 'explicit' }, def);
  assert.equal(s3.gameDir, custom, '显式绝对路径优先级最高');
  assert.equal(s3.isolated, false);
});

test('gameDirForLaunch 命中实例时自动 ensureInstance（物理目录真实存在）', () => {
  const root = tmp();
  // 不预先 ensureInstance，直接解析：应自动创建隔离目录
  const s = iso.gameDirForLaunch(root, { instanceId: 'fresh' }, path.join(root, 'game'));
  assert.equal(s.isolated, true);
  assert.ok(fs.existsSync(path.join(s.gameDir, 'mods')));
  assert.ok(fs.existsSync(path.join(s.gameDir, 'config')));
  assert.ok(fs.existsSync(path.join(s.gameDir, 'saves')));
  assert.ok(fs.existsSync(iso.instanceRoot(root, 'fresh') + '/instance.json'));
});

test('gameDirForLaunch 相对路径显式 gameDir 必须被拒绝', () => {
  const root = tmp();
  assert.throws(() => iso.gameDirForLaunch(root, { gameDir: '../escape' }), /绝对路径/);
});
