'use strict';
/**
 * 模块二（0.4.0）：模组与资源包智能管家单元测试。
 * 使用真实临时目录 + 真实 AdmZip 构造 jar / zip，不伪造模组信息；
 * 恶意 zip 通过等长字节替换条目名构造，验证 Zip-Slip 防护真实生效。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const m = require('../engine/mods/manager.cjs');

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-mods-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
function makeJar(p, meta, entryName = 'fabric.mod.json') {
  const z = new AdmZip();
  if (meta) z.addFile(entryName, Buffer.from(typeof meta === 'string' ? meta : JSON.stringify(meta)));
  z.addFile('META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\n'));
  z.writeZip(p);
  return p;
}
function makeZip(p, files = { 'pack.mcmeta': '{"pack":{}}' }) {
  const z = new AdmZip();
  for (const [n, c] of Object.entries(files)) z.addFile(n, Buffer.from(c));
  z.writeZip(p);
  return p;
}

// ---------------------------------------------------------------- 纯函数

test('normalizeId 统一 fabric-api / fabric_api / 大小写', () => {
  assert.equal(m.normalizeId('Fabric-API'), 'fabric_api');
  assert.equal(m.normalizeId('fabric_api'), 'fabric_api');
  assert.equal(m.normalizeId('fabric.api'), 'fabric_api');
});

test('safeFileName 拒绝路径穿越 / 绝对路径 / 空名', () => {
  assert.equal(m.safeFileName('a.jar'), 'a.jar');
  for (const bad of ['', '..', 'a/b.jar', 'a\\b.jar', 'C:\\evil.zip', 'a\0b.zip']) {
    assert.throws(() => m.safeFileName(bad));
  }
});

test('isUnsafeEntryName 识别 ../、绝对路径、反斜杠', () => {
  for (const bad of ['../../../evil.txt', '/etc/passwd', 'C:\\Windows\\evil', 'a\\..\\b', '']) {
    assert.equal(m.isUnsafeEntryName(bad), true, bad);
  }
  for (const ok of ['pack.mcmeta', 'assets/minecraft/textures/a.png', 'shaders/final.fsh']) {
    assert.equal(m.isUnsafeEntryName(ok), false, ok);
  }
});

// ---------------------------------------------------------------- 真实元数据解析

test('parseFabricMod 解析 id/version/depends/provides', () => {
  const r = m.parseFabricMod(JSON.stringify({
    id: 'jei', name: 'Just Enough Items', version: '15.2.0',
    depends: { fabricloader: '>=0.14', minecraft: '~1.20.1', 'fabric-api': '*' },
    provides: ['jei_api']
  }));
  assert.equal(r.id, 'jei');
  assert.equal(r.loader, 'fabric');
  assert.equal(r.version, '15.2.0');
  assert.deepEqual(r.depends.map(d => d.id), ['fabricloader', 'minecraft', 'fabric-api']);
  assert.deepEqual(r.provides, ['jei_api']);
});

test('parseQuiltMod 解析 depends 数组与 optional', () => {
  const r = m.parseQuiltMod(JSON.stringify({
    quilt_loader: {
      id: 'qmod', version: '1.0', metadata: { name: 'Quilt Mod' },
      depends: [
        { id: 'fabric_api', versions: '>=0.90' },
        { id: 'optional_thing', optional: true }
      ]
    }
  }));
  assert.equal(r.id, 'qmod');
  assert.equal(r.name, 'Quilt Mod');
  assert.equal(r.loader, 'quilt');
  assert.equal(r.depends.length, 2);
  assert.equal(r.depends[1].mandatory, false);
});

test('parseForgeToml 解析 [[mods]] 与 [[dependencies.x]]（含注释/布尔）', () => {
  const toml = `
modLoader="javafml" # 顶层配置应被忽略
loaderVersion="[47,)"
[[mods]]
modId="examplemod"
version="1.0.0"
displayName="Example Mod"
[[dependencies.examplemod]]
    modId="forge"
    mandatory=true
    versionRange="[47,)"
    ordering="NONE"
    side="BOTH"
[[dependencies.examplemod]]
    modId="some_lib"
    mandatory=false
    versionRange="[1,)"
`;
  const r = m.parseForgeToml(toml);
  assert.equal(r.id, 'examplemod');
  assert.equal(r.name, 'Example Mod');
  assert.equal(r.loader, 'forge');
  assert.equal(r.depends.length, 2);
  assert.equal(r.depends[0].id, 'forge');
  assert.equal(r.depends[0].mandatory, true);
  assert.equal(r.depends[1].mandatory, false);
});

test('parseMcmodInfo 解析旧版 mcmod.info', () => {
  const r = m.parseMcmodInfo(JSON.stringify([{ modid: 'oldmod', name: 'Old Mod', version: '2.0', requiredMods: ['Forge'] }]));
  assert.equal(r.id, 'oldmod');
  assert.equal(r.depends[0].id, 'Forge');
});

test('inspectJarBuffer 读取真实 jar 内 fabric.mod.json', (t) => {
  const d = tmp(t);
  const p = makeJar(path.join(d, 'x.jar'), { id: 'realmod', name: 'Real Mod', version: '3.1', depends: { 'fabric-api': '*' } });
  const r = m.inspectJarBuffer(fs.readFileSync(p));
  assert.equal(r.id, 'realmod');
  assert.equal(r.loader, 'fabric');
  assert.ok(r.entries >= 2);
  assert.equal(r.metaSource, 'fabric.mod.json');
});

test('inspectJarBuffer 无元数据 / 损坏 jar 如实返回 unknown + parseError', () => {
  const z = new AdmZip();
  z.addFile('readme.txt', Buffer.from('not a mod'));
  const noMeta = m.inspectJarBuffer(z.toBuffer());
  assert.equal(noMeta.loader, 'unknown');
  assert.match(noMeta.parseError, /未发现模组元数据/);
  const broken = m.inspectJarBuffer(Buffer.from('not-a-zip'));
  assert.equal(broken.loader, 'unknown');
  assert.match(broken.parseError, /无法读取 jar/);
});

test('inspectJarBuffer 识别 neoforge.mods.toml 并标注 neoforge', () => {
  const z = new AdmZip();
  z.addFile('META-INF/neoforge.mods.toml', Buffer.from('[[mods]]\nmodId="neomod"\nversion="1.0"\ndisplayName="Neo Mod"\n'));
  const r = m.inspectJarBuffer(z.toBuffer());
  assert.equal(r.id, 'neomod');
  assert.equal(r.loader, 'neoforge');
});

// ---------------------------------------------------------------- 真实目录扫描 / 启禁

test('listMods 扫描真实 mods 目录并区分 .jar / .jar.disabled', (t) => {
  const d = tmp(t);
  const modsDir = path.join(d, 'mods');
  fs.mkdirSync(modsDir);
  makeJar(path.join(modsDir, 'alpha.jar'), { id: 'alpha', name: 'Alpha', version: '1.0' });
  makeJar(path.join(modsDir, 'beta.jar.disabled'), { id: 'beta', name: 'Beta', version: '2.0' });
  fs.writeFileSync(path.join(modsDir, 'notes.txt'), 'ignored');
  const r = m.listMods(d);
  assert.equal(r.count, 2);
  assert.equal(r.enabledCount, 1);
  assert.equal(r.disabledCount, 1);
  assert.equal(r.mods[0].id, 'alpha');
  assert.equal(r.mods[0].enabled, true);
  assert.equal(r.mods[1].id, 'beta');
  assert.equal(r.mods[1].enabled, false);
});

test('listMods 目录不存在时返回 missing:true 而不是编造列表', (t) => {
  const r = m.listMods(tmp(t));
  assert.equal(r.missing, true);
  assert.deepEqual(r.mods, []);
});

test('toggleMod 真实 rename 启用/禁用且幂等', (t) => {
  const d = tmp(t);
  const modsDir = path.join(d, 'mods');
  fs.mkdirSync(modsDir);
  makeJar(path.join(modsDir, 'alpha.jar'), { id: 'alpha' });
  const off = m.toggleMod(d, 'alpha.jar', false);
  assert.equal(off.ok, true);
  assert.equal(off.changed, true);
  assert.equal(fs.existsSync(path.join(modsDir, 'alpha.jar')), false);
  assert.equal(fs.existsSync(path.join(modsDir, 'alpha.jar.disabled')), true);
  // 幂等：再次禁用
  const off2 = m.toggleMod(d, 'alpha.jar.disabled', false);
  assert.equal(off2.ok, true);
  assert.equal(off2.changed, false);
  // 重新启用
  const on = m.toggleMod(d, 'alpha.jar.disabled', true);
  assert.equal(on.ok, true);
  assert.equal(on.changed, true);
  assert.equal(fs.existsSync(path.join(modsDir, 'alpha.jar')), true);
  assert.equal(m.listMods(d).enabledCount, 1);
});

test('toggleMod 拒绝路径穿越与目标已存在覆盖', (t) => {
  const d = tmp(t);
  const modsDir = path.join(d, 'mods');
  fs.mkdirSync(modsDir);
  assert.throws(() => m.toggleMod(d, '../evil.jar', false));
  makeJar(path.join(modsDir, 'a.jar'), { id: 'a' });
  makeJar(path.join(modsDir, 'a.jar.disabled'), { id: 'a2' });
  const r = m.toggleMod(d, 'a.jar', false);
  assert.equal(r.ok, false);
  assert.match(r.error, /已存在/);
});

// ---------------------------------------------------------------- 冲突检测

const MOD = (id, extra = {}) => ({
  file: id + '.jar', id, name: id, version: '1.0', loader: 'fabric',
  depends: [], provides: [], enabled: true, parseError: null, ...extra
});

test('detectConflicts：缺失 Fabric API 标红并给出真实引导链接', () => {
  const mods = [MOD('jei', { name: 'JEI', depends: [{ id: 'fabric-api', range: '*', mandatory: true }] })];
  const r = m.detectConflicts(mods);
  assert.equal(r.ok, false);
  assert.equal(r.errorCount, 1);
  const issue = r.issues.find(i => i.type === 'missing-dependency');
  assert.equal(issue.severity, 'error');
  assert.equal(issue.missing, 'fabric-api');
  assert.ok(issue.links.some(l => l.url === 'https://modrinth.com/mod/fabric-api'));
  assert.ok(issue.links.every(l => /^https:\/\//.test(l.url)));
});

test('detectConflicts：前置齐备时不报缺失；内置 id（minecraft/forge）不算缺失', () => {
  const mods = [
    MOD('jei', { depends: [{ id: 'fabric-api' }, { id: 'minecraft' }, { id: 'fabricloader' }] }),
    MOD('fabric-api', { name: 'Fabric API' })
  ];
  const r = m.detectConflicts(mods);
  assert.equal(r.issues.filter(i => i.type === 'missing-dependency').length, 0);
  assert.equal(r.ok, true);
  const forge = m.detectConflicts([MOD('fm', { loader: 'forge', depends: [{ id: 'forge' }, { id: 'minecraft' }] })]);
  assert.equal(forge.errorCount, 0);
});

test('detectConflicts：重复 modId 与加载器混装被识别', () => {
  const dup = m.detectConflicts([MOD('same'), MOD('same')]);
  assert.ok(dup.issues.some(i => i.type === 'duplicate-id' && i.severity === 'warning'));
  const mix = m.detectConflicts([MOD('fab', { loader: 'fabric' }), MOD('forg', { loader: 'forge' })]);
  assert.ok(mix.issues.some(i => i.type === 'loader-mismatch' && i.severity === 'error'));
});

test('detectConflicts：禁用的模组默认不参与，includeDisabled 可纳入；解析失败给 warning', () => {
  const mods = [MOD('disabled-dep', { enabled: false, depends: [{ id: 'fabric-api' }] })];
  assert.equal(m.detectConflicts(mods).errorCount, 0);
  assert.equal(m.detectConflicts(mods, { includeDisabled: true }).errorCount, 1);
  const unparsed = m.detectConflicts([MOD('x', { parseError: 'jar 内未发现模组元数据' })]);
  assert.ok(unparsed.issues.some(i => i.type === 'unparsed'));
});

test('detectConflicts 结果带诚实边界说明', () => {
  const r = m.detectConflicts([]);
  assert.match(r.note, /静态检测/);
  assert.equal(r.scanned, 0);
});

// ---------------------------------------------------------------- 光影 / 材质包

test('listPacks / importPack 真实导入并计算 SHA-256', (t) => {
  const d = tmp(t);
  const src = makeZip(path.join(d, 'source.zip'), { 'pack.mcmeta': '{"pack":{"pack_format":15}}' });
  const r = m.importPack(d, 'shaderpacks', src);
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'shaderpacks');
  assert.equal(r.sha256.length, 64);
  assert.equal(fs.existsSync(path.join(d, 'shaderpacks', 'source.zip')), true);
  const packs = m.listPacks(d);
  assert.equal(packs.shaderpacks.packs.length, 1);
  assert.equal(packs.resourcepacks.packs.length, 0);
  // 重复导入不覆盖
  const again = m.importPack(d, 'shaderpacks', src);
  assert.equal(again.ok, false);
  assert.match(again.error, /已存在/);
  const forced = m.importPack(d, 'shaderpacks', src, { overwrite: true });
  assert.equal(forced.ok, true);
});

test('importPack 拒绝非 zip、未知类型与 Zip-Slip 恶意包', (t) => {
  const d = tmp(t);
  const txt = path.join(d, 'a.txt');
  fs.writeFileSync(txt, 'x');
  assert.equal(m.importPack(d, 'resourcepacks', txt).ok, false);
  assert.equal(m.importPack(d, 'bogus', txt).ok, false);
  // 等长替换条目名构造真实恶意 zip（长度不变，zip 结构仍合法）
  const z = new AdmZip();
  z.addFile('safe/entry.txt', Buffer.from('payload'));
  const buf = Buffer.from(z.toBuffer());
  const needle = Buffer.from('safe/entry.txt');       // 14 字节
  const evil = Buffer.from('../../evil.txt');          // 14 字节
  assert.equal(needle.length, evil.length);
  let idx = 0, hits = 0;
  while ((idx = buf.indexOf(needle, idx)) !== -1) { evil.copy(buf, idx); idx += needle.length; hits++; }
  assert.ok(hits >= 2, '条目名应在 local header 与 central directory 各出现一次');
  const bad = path.join(d, 'evil.zip');
  fs.writeFileSync(bad, buf);
  assert.throws(() => m.assertSafeZip(bad), /不安全路径/);
  const r = m.importPack(d, 'shaderpacks', bad);
  assert.equal(r.ok, false);
  assert.match(r.error, /不安全路径/);
  assert.equal(fs.existsSync(path.join(d, 'shaderpacks', 'evil.zip')), false, '恶意包不得落盘');
});

test('checkShaderRequirements：无光影包不打扰；有光影包但缺加载器给出真实链接', () => {
  const noPack = m.checkShaderRequirements([MOD('jei')], { shaderpacks: { packs: [] } });
  assert.equal(noPack.needed, false);
  assert.equal(noPack.status, 'no-shaderpacks');
  const packs = { shaderpacks: { packs: [{ name: 'bsl.zip' }] }, resourcepacks: { packs: [] } };
  const miss = m.checkShaderRequirements([MOD('jei')], packs);
  assert.equal(miss.needed, true);
  assert.equal(miss.status, 'missing-loader');
  assert.ok(miss.links.length >= 4);
  assert.ok(miss.links.every(l => /^https:\/\//.test(l.url)));
  assert.ok(miss.links.some(l => l.url.includes('irisshaders.dev')));
  assert.ok(miss.links.some(l => l.url.includes('optifine.net')));
});

test('checkShaderRequirements：识别 Iris / Oculus / OptiFine 且忽略禁用模组', () => {
  const packs = { shaderpacks: { packs: [{ name: 'bsl.zip' }] } };
  for (const key of ['iris', 'oculus', 'optifine']) {
    const r = m.checkShaderRequirements([MOD(key, { id: key, name: key })], packs);
    assert.equal(r.status, 'ok', key);
    assert.ok(r.found.includes(key));
  }
  const disabled = m.checkShaderRequirements([MOD('iris', { enabled: false })], packs);
  assert.equal(disabled.status, 'missing-loader');
});

test('GUIDE_LINKS 全部为真实 https 地址且无占位符', () => {
  for (const [k, l] of Object.entries(m.GUIDE_LINKS)) {
    assert.match(l.url, /^https:\/\/[a-z0-9.-]+\//i, k);
    assert.ok(l.name && l.id);
    assert.ok(!/example|placeholder|todo|xxx/i.test(l.url), k);
  }
});
