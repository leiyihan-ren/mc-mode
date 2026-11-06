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
