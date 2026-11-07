'use strict';
/**
 * 【0.5.0 模块三】沙盒环境下的模拟压测（Mock，但使用真实 zip / 真实 jar 元数据 / 真实文件 IO）
 *
 *  场景 A：导出一个包含 50 个模组的隔离实例 → 验证收集完整、index 标准、可被 parseMrpack 读回、
 *          重新 installPlan 能完整还原 mods/config/options.txt（导出→导入闭环）。
 *  场景 B：导入一个「缺失前置 Fabric API」的整合包 → preflightImport 明确拦截、
 *          installWithPreflight 返回 blocked 且不创建任何实例目录、不抛异常（UI 可安全展示报错）。
 *
 * 全部使用 adm-zip 生成真实 zip 字节，绝不 new 一个假对象冒充整合包。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const isolation = require('../engine/isolation.cjs');
const modpack = require('../engine/modpack.cjs');
const exporter = require('../engine/modpackExport.cjs');

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-stress-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** 生成一个带真实 fabric.mod.json 的模组 jar 字节 */
function modJar(id, opts = {}) {
  const z = new AdmZip();
  z.addFile('fabric.mod.json', Buffer.from(JSON.stringify({
    schemaVersion: 1, id, version: opts.version || '1.0.0',
    name: opts.name || id,
    depends: opts.depends || {},
    provides: opts.provides || []
  })));
  z.addFile('META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\n'));
  return z.toBuffer();
}

/** 创建实例并写入指定文件 */
function makeInstance(root, id, meta, files) {
  const inst = isolation.ensureInstance(root, id, meta);
  for (const [rel, data] of Object.entries(files)) {
    const p = path.join(inst.gameDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
  }
  return inst;
}

const FAKE_DOWNLOAD = async (tasks) => ({
  results: tasks.map(t => {
    fs.mkdirSync(path.dirname(t.dest), { recursive: true });
    fs.writeFileSync(t.dest, 'DOWNLOADED');
    return { id: t.id, ok: true, dest: t.dest };
  })
});

// ==================== 场景 A：50 个模组实例导出 ====================
test('压测 A：导出含 50 个模组的实例，收集完整且生成标准 .mrpack', (t) => {
  const root = tmp(t);
  const files = {};
  for (let i = 1; i <= 50; i++) {
    const id = `stressmod${String(i).padStart(2, '0')}`;
    files[`mods/${id}.jar`] = modJar(id, { name: `Stress Mod ${i}`, version: `${i}.0.0` });
  }
  files['config/stress.cfg'] = Buffer.from('quality=fancy\n');
  files['config/sub/nested.json'] = Buffer.from('{"a":1}');
  files['options.txt'] = Buffer.from('fov=90\nrenderDistance=12\n');
  // 敏感/禁用文件不应被导出
  files['usercache.json'] = Buffer.from('SECRET');
  files['mods/disabled.jar.disabled'] = Buffer.from('DISABLED');
  files['saves/world1/level.dat'] = Buffer.from('SAVE');

  const inst = makeInstance(root, 'stress-50', {
    name: 'Stress Pack 50', gameVersion: '1.20.1', loader: 'fabric-0.15.11'
  }, files);
  assert.equal(inst.meta.gameVersion, '1.20.1');

  const r = exporter.exportInstance(root, 'stress-50', {});
  assert.equal(r.ok, true, r.error);
  assert.equal(r.format, 'mrpack');
  assert.equal(r.collected.mods, 50, '应收集 50 个启用的模组');
  assert.equal(r.collected.configFiles, 2, 'config 含嵌套目录应全部收集');
  assert.equal(r.collected.optionsTxt, true);
  assert.equal(r.manifest.mods.length, 50, '自描述清单应有 50 条真实模组记录');
  assert.ok(r.manifest.mods.every(m => /^[0-9a-f]{64}$/.test(m.sha256)), '每个模组都有真实 sha256');
  assert.equal(r.manifest.mods[0].loader, 'fabric');
  assert.ok(r.size > 0);
  assert.match(r.sha256, /^[0-9a-f]{64}$/);

  // 标准依赖：minecraft + fabric-loader
  assert.equal(r.index.formatVersion, 1);
  assert.equal(r.index.dependencies.minecraft, '1.20.1');
  assert.equal(r.index.dependencies['fabric-loader'], '0.15.11');
  assert.deepEqual(r.index.files, [], '本地模组不伪造远程下载直链');

  // zip 结构：index + manifest + overrides
  const zip = new AdmZip(r.buffer);
  const names = zip.getEntries().map(e => e.entryName);
  assert.ok(names.includes('modrinth.index.json'));
  assert.ok(names.includes('mcnext-manifest.json'));
  assert.equal(names.filter(n => /^overrides\/mods\/.*\.jar$/.test(n)).length, 50);
  assert.ok(names.includes('overrides/options.txt'));
  assert.ok(names.includes('overrides/config/sub/nested.json'));
  assert.ok(!names.some(n => n.includes('usercache')), '敏感文件不得导出');
  assert.ok(!names.some(n => n.includes('disabled')), '禁用模组不得导出');
  assert.ok(!names.some(n => n.includes('saves/')), '存档不得导出');
});

test('压测 A：导出的 .mrpack 能被现有 parseMrpack 读回（闭环）', (t) => {
  const root = tmp(t);
  const files = {};
  for (let i = 1; i <= 50; i++) files[`mods/m${i}.jar`] = modJar(`m${i}`);
  files['options.txt'] = Buffer.from('fov=75\n');
  makeInstance(root, 'loop', { name: 'Loop', gameVersion: '1.20.1', loader: 'fabric-0.15.11' }, files);
  const r = exporter.exportInstance(root, 'loop', {});
  assert.equal(r.ok, true);

  const plan = modpack.parseMrpack(r.buffer);
  assert.equal(plan.format, 'mrpack');
  assert.equal(plan.gameVersion, '1.20.1');
  assert.deepEqual(plan.loaders, [{ type: 'fabric', version: '0.15.11' }]);
  assert.equal(plan.overrides.filter(o => /\.jar$/.test(o.name)).length, 50);
  // 自描述清单可读回
  const mf = exporter.readExportManifest(r.buffer);
  assert.equal(mf.counts.mods, 50);
  assert.equal(mf.sourceInstance.id, 'loop');
});

test('压测 A：导出包重新安装能完整还原 50 模组 + config + options.txt', async (t) => {
  const root = tmp(t);
  const files = {};
  for (let i = 1; i <= 50; i++) files[`mods/m${i}.jar`] = modJar(`m${i}`);
  files['config/a.cfg'] = Buffer.from('a=1');
  files['options.txt'] = Buffer.from('fov=80\n');
  makeInstance(root, 'src', { name: 'Src', gameVersion: '1.20.1', loader: 'fabric-0.15.11' }, files);
  const exp = exporter.exportInstance(root, 'src', {});
  const plan = modpack.parseMrpack(exp.buffer);

  const report = await modpack.installPlan({ plan, root, instanceId: 'restored', downloadBatch: FAKE_DOWNLOAD });
  const gd = report.gameDir;
  assert.equal(fs.readdirSync(path.join(gd, 'mods')).filter(f => f.endsWith('.jar')).length, 50);
  assert.equal(fs.readFileSync(path.join(gd, 'config', 'a.cfg'), 'utf8'), 'a=1');
  assert.equal(fs.readFileSync(path.join(gd, 'options.txt'), 'utf8'), 'fov=80\n');
  assert.equal(report.gameVersion, '1.20.1');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'instances', 'restored', 'instance.json'), 'utf8')).loader, 'fabric-0.15.11');
});

// ==================== 场景 B：缺失前置 API 的整合包导入拦截 ====================
/** 造一个自包含 mrpack：overrides 内嵌若干 jar（可指定依赖），声明 fabric-loader */
function selfContainedPack(mods, opts = {}) {
  const z = new AdmZip();
  const deps = { minecraft: opts.gameVersion || '1.20.1' };
  if (opts.loaderKey) deps[opts.loaderKey] = opts.loaderVersion || '0.15.11';
  z.addFile('modrinth.index.json', Buffer.from(JSON.stringify({
    formatVersion: 1, game: 'minecraft', versionId: '1.0.0',
    name: opts.name || 'Missing Dep Pack', dependencies: deps, files: []
  })));
  for (const m of mods) z.addFile(`overrides/mods/${m.id}.jar`, modJar(m.id, m));
  return z.toBuffer();
}

test('压测 B：缺失 Fabric API 的整合包 → preflight 明确拦截（标红 issue + 引导链接）', () => {
  const buf = selfContainedPack([
    { id: 'fancy-shader-mod', name: 'Fancy Shader', depends: { 'fabric-api': '>=0.90', minecraft: '1.20.1' } }
  ], { loaderKey: 'fabric-loader' });
  const plan = modpack.parseMrpack(buf);

  const pf = exporter.preflightImport(plan);
  assert.equal(pf.blocked, true);
  assert.equal(pf.ok, false);
  assert.ok(pf.errorCount >= 1);
  const miss = pf.issues.find(i => i.type === 'missing-dependency');
  assert.ok(miss, '应识别出 missing-dependency');
  assert.equal(miss.severity, 'error');
  assert.equal(miss.missing, 'fabric-api');
  assert.ok(miss.links.some(l => l.url && l.url.includes('modrinth.com')), '应带真实引导链接供 UI 展示');
  assert.match(pf.summary, /已拦截导入/);
  assert.match(pf.summary, /未创建任何实例目录/);
  // 可序列化（UI 通过 IPC 传递）
  assert.doesNotThrow(() => JSON.stringify(pf));
});

test('压测 B：installWithPreflight 硬拦截，不崩溃、不创建半成品实例', async (t) => {
  const root = tmp(t);
  const buf = selfContainedPack([
    { id: 'jei-like', name: 'JEI Like', depends: { 'fabric-api': '*' } }
  ], { loaderKey: 'fabric-loader' });
  const plan = modpack.parseMrpack(buf);

  let result;
  await assert.doesNotReject(async () => {
    result = await exporter.installWithPreflight({ plan, root, instanceId: 'should-not-exist', downloadBatch: FAKE_DOWNLOAD });
  });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.match(result.error, /已拦截导入/);
  assert.equal(result.preflight.errorCount >= 1, true);
  assert.equal(fs.existsSync(path.join(root, 'instances', 'should-not-exist')), false, '拦截后不得创建实例目录');
});

test('压测 B：describeModpack 精简摘要可序列化，且正确反映拦截', () => {
  const buf = selfContainedPack([
    { id: 'needs-api', depends: { 'fabric-api': '*' } }
  ], { loaderKey: 'fabric-loader' });
  const plan = modpack.parseMrpack(buf);
  const desc = exporter.describeModpack(plan);
  assert.equal(desc.format, 'mrpack');
  assert.equal(desc.overrideJarCount, 1);
  assert.equal(desc.preflight.blocked, true);
  const json = JSON.stringify(desc);
  assert.ok(!json.includes('"data"'), '摘要不得携带大 Buffer 字段');
  assert.ok(!json.includes('"type":"Buffer"'), '摘要不得携带 Buffer');
});

test('压测 B：未声明 fabric-loader 的 Fabric 模组包 → loader-missing 拦截', () => {
  const buf = selfContainedPack([
    { id: 'plainmod', depends: {} }
  ], { loaderKey: null }); // 不声明任何 loader
  const plan = modpack.parseMrpack(buf);
  const pf = exporter.preflightImport(plan);
  assert.equal(pf.blocked, true);
  assert.ok(pf.issues.some(i => i.type === 'loader-missing'));
});

test('压测 B：依赖齐全的包预检通过，不误拦截；force 可显式跳过拦截', async (t) => {
  const root = tmp(t);
  // fabric-api 作为 provided 的另一个模组 + 一个依赖它的模组 → 无缺失
  const buf = selfContainedPack([
    { id: 'fabric-api', name: 'Fabric API', depends: {} },
    { id: 'mymod', name: 'My Mod', depends: { 'fabric-api': '*' } }
  ], { loaderKey: 'fabric-loader' });
  const plan = modpack.parseMrpack(buf);
  const pf = exporter.preflightImport(plan);
  assert.equal(pf.blocked, false, '依赖齐全不应误拦截');
  assert.equal(pf.errorCount, 0);

  const missingBuf = selfContainedPack([
    { id: 'lonely', depends: { 'fabric-api': '*' } }
  ], { loaderKey: 'fabric-loader' });
  const bad = modpack.parseMrpack(missingBuf);
  const forced = await exporter.installWithPreflight({
    plan: bad, root, instanceId: 'forced', force: true, downloadBatch: FAKE_DOWNLOAD
  });
  assert.equal(forced.ok, true, 'force:true 作为逃生舱允许跳过拦截');
  assert.equal(forced.blocked, false);
  assert.ok(fs.existsSync(path.join(root, 'instances', 'forced', 'instance.json')));
});

test('压测 B：损坏 jar / 残缺 overrides 不导致预检崩溃', () => {
  const pf = exporter.preflightImport({
    format: 'mrpack', gameVersion: '1.20.1', loaders: [{ type: 'fabric', version: '0.15.11' }],
    files: [],
    overrides: [
      { name: 'mods/broken.jar', data: Buffer.from('this is not a zip') },
      { name: 'readme.txt', data: Buffer.from('hello') }
    ]
  });
  assert.equal(pf.blocked, false, '损坏 jar 只是提示，不是阻断性依赖缺失');
  assert.ok(pf.issues.some(i => i.type === 'unparsed'));
  assert.equal(typeof pf.summary, 'string');
  assert.doesNotThrow(() => JSON.stringify(pf));
});

test('压测：拖拽导入经 IPC 往返（Buffer 被 clone 成 Uint8Array / JSON 对象）仍能正确安装', async (t) => {
  const root = tmp(t);
  const z = new AdmZip();
  z.addFile('modrinth.index.json', Buffer.from(JSON.stringify({
    formatVersion: 1, game: 'minecraft', versionId: '1.0.0', name: 'Roundtrip',
    dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.11' }, files: []
  })));
  const apiJar = new AdmZip();
  apiJar.addFile('fabric.mod.json', Buffer.from(JSON.stringify({ id: 'fabric-api', version: '0.91', depends: {} })));
  z.addFile('overrides/mods/fabric-api.jar', apiJar.toBuffer());
  z.addFile('overrides/config/demo.cfg', Buffer.from('a=1'));
  z.addFile('overrides/options.txt', Buffer.from('fov=90'));
  const plan = modpack.parseMrpack(z.toBuffer());

  // 模拟渲染进程把 plan 完全 JSON 化后再传回主进程（最严苛的 IPC 退化场景）
  const cloned = JSON.parse(JSON.stringify(plan));
  assert.equal(typeof cloned.overrides[0].data, 'object');
  const coerced = exporter.coerceBytes(cloned.overrides[0].data);
  assert.ok(Buffer.isBuffer(coerced), 'coerceBytes 应把 {type:Buffer,data:[]} 还原为 Buffer');

  const r = await exporter.installWithPreflight({ plan: cloned, root, instanceId: 'rt', downloadBatch: FAKE_DOWNLOAD });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.blocked, false);
  const gd = r.gameDir;
  assert.equal(fs.readFileSync(path.join(gd, 'mods', 'fabric-api.jar')).length, apiJar.toBuffer().length);
  assert.equal(fs.readFileSync(path.join(gd, 'config', 'demo.cfg'), 'utf8'), 'a=1');
  assert.equal(fs.readFileSync(path.join(gd, 'options.txt'), 'utf8'), 'fov=90');
});

test('压测边界：实例不存在 / 无 MC 版本 → 导出明确报错而非崩溃', (t) => {
  const root = tmp(t);
  const r1 = exporter.exportInstance(root, 'ghost', {});
  assert.equal(r1.ok, false);
  assert.match(r1.error, /不存在/);
  isolation.ensureInstance(root, 'no-version', { name: 'NoVer' });
  const r2 = exporter.exportInstance(root, 'no-version', {});
  assert.equal(r2.ok, false);
  assert.match(r2.error, /MC 版本/);
});
