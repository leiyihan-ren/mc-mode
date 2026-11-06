'use strict';
/** 模块三（仅 1 扫描存档 / 2 备份回滚）单元测试。按用户指令不含任何 AI/大模型内容。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const N = require('../engine/world/nbt.cjs');
const W = require('../engine/world/manager.cjs');

// ---- 构造真实 NBT（大端，gzip）----
const str = s => { const b = Buffer.from(s, 'utf8'), h = Buffer.alloc(2); h.writeUInt16BE(b.length); return Buffer.concat([h, b]); };
const tag = (t, n, p) => Buffer.concat([Buffer.from([t]), str(n), p]);
const i64 = n => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(n)); return b; };
const i32 = n => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const end = Buffer.from([0]);

function makeLevelDat(opts = {}) {
  const version = tag(10, 'Version', Buffer.concat([tag(8, 'Name', str(opts.version || '1.20.1')), tag(3, 'Id', i32(3465)), end]));
  const data = tag(10, 'Data', Buffer.concat([
    tag(8, 'LevelName', str(opts.name || '测试世界')),
    tag(4, 'RandomSeed', i64(opts.seed || '123456789012345')),
    tag(4, 'Time', i64(opts.time || 480000)),
    tag(4, 'LastPlayed', i64(opts.lastPlayed || 1700000000000)),
    tag(3, 'GameType', i32(0)),
    tag(1, 'hardcore', Buffer.from([1])),
    version, end
  ]));
  return zlib.gzipSync(Buffer.concat([Buffer.from([10]), str(''), data, end]));
}

function fixture(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcworld-'));
  const gameDir = path.join(root, 'game');
  const world = path.join(gameDir, 'saves', '测试世界');
  fs.mkdirSync(path.join(world, 'region'), { recursive: true });
  fs.mkdirSync(path.join(world, 'stats'), { recursive: true });
  fs.mkdirSync(path.join(gameDir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(world, 'level.dat'), makeLevelDat(opts));
  fs.writeFileSync(path.join(world, 'region', 'r.0.0.mca'), Buffer.from('CHUNK'));
  fs.writeFileSync(path.join(world, 'stats', 'p.json'), JSON.stringify({
    stats: { 'minecraft:custom': { 'minecraft:play_time': opts.playTime ?? 720000 } }
  }));
  fs.writeFileSync(path.join(gameDir, 'mods', 'jei.jar'), Buffer.from('MOD'));
  fs.writeFileSync(path.join(world, 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return { root, gameDir, world };
}

test('NBT 解析：gzip 自动解压、全部 TAG 类型、BigInt 不截断', () => {
  const compound = tag(10, 'Root', Buffer.concat([
    tag(1, 'Byte', Buffer.from([7])),
    tag(2, 'Short', Buffer.alloc(2)),
    tag(3, 'Int', i32(-42)),
    tag(4, 'Long', i64('9007199254740993')),
    tag(5, 'Float', Buffer.from([0x3f, 0x80, 0, 0])),
    tag(6, 'Double', Buffer.from([0, 0, 0, 0, 0, 0, 0, 0])),
    tag(7, 'ByteArray', Buffer.concat([i32(2), Buffer.from([1, 2])])),
    tag(8, 'String', str('hello')),
    tag(9, 'List', Buffer.concat([Buffer.from([3]), i32(2), i32(10), i32(20)])),
    tag(11, 'IntArray', Buffer.concat([i32(2), i32(1), i32(2)])),
    tag(12, 'LongArray', Buffer.concat([i32(1), i64(99)])),
    end
  ]));
  const raw = Buffer.concat([Buffer.from([10]), str(''), compound, end]);
  const buf = zlib.gzipSync(raw);
  const r = N.parseNbt(buf);
  assert.equal(r.name, '');
  assert.equal(r.value.Root.Byte, 7);
  assert.equal(r.value.Root.Int, -42);
  assert.equal(r.value.Root.Long, 9007199254740993n);
  assert.equal(r.value.Root.String, 'hello');
  assert.deepEqual(r.value.Root.List, [10, 20]);
  assert.deepEqual(r.value.Root.IntArray, [1, 2]);
  assert.equal(r.value.Root.LongArray[0], 99n);
  assert.equal(r.bytesRead, raw.length);
  // toPlain 可安全 JSON 序列化
  assert.doesNotThrow(() => JSON.stringify(N.toPlain(r.value)));
});

test('NBT 损坏数据明确抛错，不返回半截结果', () => {
  assert.throws(() => N.parseNbt(Buffer.from([10, 0, 0])), /截断|NBT/);
  assert.throws(() => N.parseNbt(Buffer.from([99, 0, 0, 0, 0])), /未知 NBT TAG/);
});

test('levelSummary：种子/版本/游戏天数/极限模式正确提取', () => {
  const s = N.levelSummary(makeLevelDat());
  assert.equal(s.name, '测试世界');
  assert.equal(s.seed, '123456789012345');
  assert.equal(s.version, '1.20.1');
  assert.equal(s.gameDays, 20);
  assert.equal(s.hardcore, true);
  assert.equal(s.gameTypeName, '生存');
});

test('扫描世界：真实游玩时长取自 stats 并如实标注来源', () => {
  const { root, gameDir } = fixture();
  const r = W.listWorlds(gameDir);
  assert.equal(r.ok, true);
  assert.equal(r.worlds.length, 1);
  const w = r.worlds[0];
  assert.equal(w.name, '测试世界');
  assert.equal(w.playTimeTicks, 720000);
  assert.equal(w.playTimeHuman, '10 小时 0 分');
  assert.equal(w.playTimeSource, 'stats');
  assert.match(w.playTimeNote, /stats\/\*\.json/);
  assert.equal(w.modCount, 1);
  assert.equal(w.mods[0].name, 'jei.jar');
  assert.equal(w.modded, true);
  assert.ok(w.icon.startsWith('data:image/png;base64,'));
  assert.ok(w.sizeBytes > 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('缺少 stats 时明确标注为估算，不冒充真实游玩时长', () => {
  const { root, gameDir, world } = fixture();
  fs.rmSync(path.join(world, 'stats'), { recursive: true });
  const w = W.listWorlds(gameDir).worlds[0];
  assert.equal(w.playTimeTicks, null);
  assert.equal(w.playTimeHuman, null);
  assert.equal(w.playTimeSource, 'estimated-from-gameTime');
  assert.match(w.playTimeNote, /并非真实在线时长/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('旧版统计键 stat.playOneMinute 兼容', () => {
  const { root, gameDir, world } = fixture();
  fs.writeFileSync(path.join(world, 'stats', 'p.json'), JSON.stringify({ stats: { 'stat.playOneMinute': 36000 } }));
  const w = W.listWorlds(gameDir).worlds[0];
  assert.equal(w.playTimeHuman, '30 分 0 秒');
  fs.rmSync(root, { recursive: true, force: true });
});

test('备份：7 次只保留最近 5 份，含真实 SHA-256 与关卡元数据', () => {
  const { root, gameDir } = fixture();
  const bdir = path.join(root, 'backups');
  for (let i = 0; i < 7; i++) {
    fs.writeFileSync(path.join(gameDir, 'saves', '测试世界', 'region', 'r.0.0.mca'), Buffer.from('V' + i));
    const r = W.backupWorld(gameDir, '测试世界', { root: bdir });
    assert.equal(r.ok, true);
    assert.match(r.meta.sha256, /^[0-9a-f]{64}$/);
    assert.equal(r.meta.level.version, '1.20.1');
  }
  const list = W.listBackups(bdir, '测试世界');
  assert.equal(list.length, W.KEEP_BACKUPS);
  assert.ok(list[0].createdAt);
  fs.rmSync(root, { recursive: true, force: true });
});

test('回滚：还原数据 + 自动生成 pre-restore 快照', () => {
  const { root, gameDir } = fixture();
  const bdir = path.join(root, 'backups');
  const first = W.backupWorld(gameDir, '测试世界', { root: bdir });
  fs.writeFileSync(path.join(gameDir, 'saves', '测试世界', 'region', 'r.0.0.mca'), Buffer.from('MODIFIED'));
  const r = W.restoreWorld(gameDir, '测试世界', first.file, { root: bdir });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(gameDir, 'saves', '测试世界', 'region', 'r.0.0.mca')).toString(), 'CHUNK');
  assert.ok(r.preRestoreBackup && fs.existsSync(r.preRestoreBackup));
  assert.equal(r.world.name, '测试世界');
  fs.rmSync(root, { recursive: true, force: true });
});

test('安全：拒绝备份目录外的文件与 Zip-Slip 路径', () => {
  const { root, gameDir } = fixture();
  const bdir = path.join(root, 'backups');
  const bad = W.restoreWorld(gameDir, '测试世界', '/etc/passwd', { root: bdir });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /不在本启动器的备份目录内/);

  // 直接对防护函数注入含穿越段的条目名（adm-zip 自身也会规范化 addFile 路径，
  // 这里验证的是解压前的最后一道校验逻辑）
  const fakeZip = names => ({ getEntries: () => names.map(entryName => ({ entryName })) });
  assert.throws(() => W.assertSafeZip(fakeZip(['../../../evil.txt'])), /Zip-Slip/);
  assert.throws(() => W.assertSafeZip(fakeZip(['/etc/passwd'])), /Zip-Slip/);
  assert.throws(() => W.assertSafeZip(fakeZip(['C:\\Windows\\evil'])), /Zip-Slip/);
  assert.doesNotThrow(() => W.assertSafeZip(fakeZip(['region/r.0.0.mca', 'level.dat'])));
  fs.rmSync(root, { recursive: true, force: true });
});

test('humanDuration / safeName 边界', () => {
  assert.equal(W.humanDuration(0), '0 秒');
  assert.equal(W.humanDuration(3600), '1 小时 0 分');
  assert.equal(W.humanDuration(90061), '1 天 1 小时 1 分');
  assert.equal(W.safeName('我的世界/../危险'), '我的世界_.._危险');
});
