'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const mp = require('../engine/modpack.cjs');

function tmp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-pack-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }

const MR_INDEX = {
  formatVersion: 1, game: 'minecraft', versionId: '1.3.0', name: 'Hardcore Pack',
  dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.11', 'neoforge': 'NONE' },
  files: [
    { path: 'mods/sodium.jar', hashes: { sha512: 'aa', sha1: 'bb' }, env: { client: 'required', server: 'required' }, downloads: ['https://cdn.modrinth.com/data/AANobbMI/versions/xyz/sodium.jar'], fileSize: 123456 },
    { path: 'mods/server-only.jar', hashes: { sha512: 'cc', sha1: 'dd' }, env: { client: 'unsupported', server: 'required' }, downloads: ['https://cdn.modrinth.com/server.jar'], fileSize: 999 }
  ]
};

function mrpackBuffer() {
  const z = new AdmZip();
  z.addFile('modrinth.index.json', Buffer.from(JSON.stringify(MR_INDEX)));
  z.addFile('overrides/config/sodium-options.json', Buffer.from('{"quality":"fancy"}'));
  z.addFile('overrides/mods/patch.txt', Buffer.from('patch'));
  z.addFile('client-overrides/options.txt', Buffer.from('fov=90'));
  return z.toBuffer();
}

test('解析真实 .mrpack 结构：依赖/加载器/文件/overrides', () => {
  const plan = mp.parseMrpack(mrpackBuffer());
  assert.equal(plan.format, 'mrpack');
  assert.equal(plan.name, 'Hardcore Pack');
  assert.equal(plan.gameVersion, '1.20.1');
  assert.deepEqual(plan.loaders, [{ type: 'fabric', version: '0.15.11' }, { type: 'neoforge', version: 'NONE' }]);
  assert.equal(plan.files.length, 2);
  assert.equal(plan.files[0].sha1, 'bb');
  assert.equal(plan.files[0].urls[0], 'https://cdn.modrinth.com/data/AANobbMI/versions/xyz/sodium.jar');
  assert.ok(plan.overrides.some(o => o.name === 'config/sodium-options.json'));
  assert.ok(plan.overrides.some(o => o.name === 'options.txt' && o.side === 'client'));
});

test('env.client=unsupported 的服务端文件被过滤', () => {
  const plan = mp.parseMrpack(mrpackBuffer());
  const files = mp.filterClientFiles(plan);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'mods/sodium.jar');
});

test('CurseForge manifest：forge-47.2.0 解析为加载器，fileID 不伪造直链', () => {
  const plan = mp.parseCurseManifest({
    name: 'Curse Pack', version: '2.0.0',
    minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.2.0', primary: true }] },
    files: [{ projectID: 238222, fileID: 4712345, required: true }],
    overrides: 'overrides'
  });
  assert.equal(plan.format, 'curse');
  assert.deepEqual(plan.loaders, [{ type: 'forge', version: '47.2.0' }]);
  assert.equal(plan.files[0].apiUrl, 'https://api.curseforge.com/v1/mods/238222/files/4712345');
  assert.deepEqual(plan.files[0].urls, [], '无 API Key 时不应编造下载直链');
  assert.equal(plan.unresolved.length, 1);
});

test('CurseForge zip（manifest.json + overrides/）自动识别并提取覆盖文件', () => {
  const z = new AdmZip();
  z.addFile('manifest.json', Buffer.from(JSON.stringify({
    minecraft: { version: '1.16.5', modLoaders: [{ id: 'forge-36.2.34', primary: true }] },
    files: [], overrides: 'overrides', name: 'ZipPack'
  })));
  z.addFile('overrides/config/a.cfg', Buffer.from('a=1'));
  const plan = mp.parseModpack(z.toBuffer());
  assert.equal(plan.format, 'curse');
  assert.equal(plan.overrides.length, 1);
  assert.equal(plan.overrides[0].name, 'config/a.cfg');
});

test('MultiMC / Prism mmc-pack.json 组件解析', () => {
  const plan = mp.parseMmcPack({
    formatVersion: 1,
    components: [
      { uid: 'net.minecraft', version: '1.21.1' },
      { uid: 'net.fabricmc.fabric-loader', version: '0.16.5' },
      { uid: 'org.quiltmc.quilt-loader', version: '0.26.0' }
    ]
  });
  assert.equal(plan.gameVersion, '1.21.1');
  assert.deepEqual(plan.loaders.map(l => l.type), ['fabric', 'quilt']);
});

test('Zip Slip 路径穿越被拦截', (t) => {
  const dir = tmp(t);
  assert.throws(() => mp.extractOverrides([
    { name: '../../../../tmp/evil.txt', data: Buffer.from('EVIL') }
  ], dir), /Zip Slip 拦截/);
  assert.equal(fs.existsSync('/tmp/evil.txt'), false);
  const ok = mp.extractOverrides([{ name: 'config/ok.cfg', data: Buffer.from('OK') }], dir);
  assert.deepEqual(ok, ['config/ok.cfg']);
  assert.equal(fs.readFileSync(path.join(dir, 'config', 'ok.cfg'), 'utf8'), 'OK');
});

test('resolveCurseFiles：无 Key 报错；有 Key 时解析真实 API 响应', async () => {
  const plan = mp.parseCurseManifest({ minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.2.0', primary: true }] }, files: [{ projectID: 1, fileID: 2 }] });
  await assert.rejects(() => mp.resolveCurseFiles(plan, ''), /API Key/);
  const fetchImpl = async (url, init) => {
    assert.equal(url, 'https://api.curseforge.com/v1/mods/1/files/2');
    assert.equal(init.headers['x-api-key'], 'KEY');
    return { ok: true, status: 200, json: async () => ({ data: { downloadUrl: 'https://edge.forgecdn.net/files/1/2/jei.jar', fileName: 'jei.jar', fileLength: 42 } }) };
  };
  const r = await mp.resolveCurseFiles(plan, 'KEY', fetchImpl);
  assert.equal(r[0].path, 'mods/jei.jar');
  assert.equal(r[0].urls[0], 'https://edge.forgecdn.net/files/1/2/jei.jar');
});

test('installPlan 一键安装：隔离实例 + 并发下载 + overrides 落地', async (t) => {
  const root = tmp(t);
  const fakeDownload = async (tasks, opts) => {
    const results = tasks.map(task => {
      fs.mkdirSync(path.dirname(task.dest), { recursive: true });
      fs.writeFileSync(task.dest, 'REAL-MOD-BYTES');
      if (opts.onEvent) opts.onEvent({ type: 'done', id: task.id });
      return { id: task.id, ok: true, dest: task.dest };
    });
    return { results };
  };
  const plan = mp.parseMrpack(mrpackBuffer());
  const events = [];
  const report = await mp.installPlan({ plan, root, instanceId: 'hardcore-1.20.1', downloadBatch: fakeDownload, onEvent: e => events.push(e) });
  assert.equal(report.downloaded, 1, '客户端文件应被下载');
  assert.equal(report.failed.length, 0);
  assert.equal(report.gameVersion, '1.20.1');
  assert.equal(report.loaders[0].type, 'fabric');
  assert.ok(fs.existsSync(path.join(report.gameDir, 'mods', 'sodium.jar')));
  assert.equal(fs.readFileSync(path.join(report.gameDir, 'config', 'sodium-options.json'), 'utf8'), '{"quality":"fancy"}');
  assert.equal(fs.readFileSync(path.join(report.gameDir, 'options.txt'), 'utf8'), 'fov=90', 'client-overrides 应落地');
  assert.equal(fs.existsSync(path.join(report.gameDir, 'mods', 'server-only.jar')), false, '服务端专用模组不应安装');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'instances', 'hardcore-1.20.1', 'instance.json'), 'utf8')).gameVersion, '1.20.1');
  assert.ok(events.some(e => e.type === 'plan') && events.some(e => e.type === 'installed'));
});
