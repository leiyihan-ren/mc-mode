'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const { mergeJars, extractUniversalFromInstaller, countEntries } = require('../engine/merge');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-merge-'));

function mkJar(p, files) {
  const z = new AdmZip();
  for (const [name, content] of Object.entries(files)) z.addFile(name, Buffer.from(content));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  z.writeZip(p);
  return p;
}

test('合并: overlay 覆盖 base 同名类，签名文件被丢弃', () => {
  const d = tmp();
  const base = mkJar(path.join(d, 'base.jar'), {
    'net/minecraft/A.class': 'BASE-A',
    'net/minecraft/B.class': 'BASE-B',
    'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\n',
    'META-INF/ORIG.SF': 'sig'
  });
  const overlay = mkJar(path.join(d, 'universal.jar'), {
    'net/minecraft/A.class': 'PATCHED-A',           // 覆盖
    'net/minecraftforge/C.class': 'FORGE-C',        // 新增
    'META-INF/MANIFEST.MF': 'evil',                 // 应丢弃
    'META-INF/FORGE.SF': 'evil-sig',                // 应丢弃
    'META-INF/FORGE.RSA': 'evil-rsa'
  });
  const out = path.join(d, 'merged.jar');
  const r = mergeJars(base, overlay, out);
  assert.equal(r.overwritten, 1, 'A.class 应被覆盖');
  assert.equal(r.added, 1, 'C.class 应新增');
  assert.equal(r.skippedSig, 3, '3 个签名/manifest 应被跳过');

  const z = new AdmZip(out);
  assert.equal(z.readFile(z.getEntry('net/minecraft/A.class')).toString(), 'PATCHED-A');
  assert.equal(z.readFile(z.getEntry('net/minecraft/B.class')).toString(), 'BASE-B');
  assert.equal(z.readFile(z.getEntry('net/minecraftforge/C.class')).toString(), 'FORGE-C');
  assert.equal(z.readFile(z.getEntry('META-INF/MANIFEST.MF')).toString(), 'Manifest-Version: 1.0\n');
  assert.equal(z.getEntry('META-INF/ORIG.SF') !== null, true, 'base 签名保留');
  assert.equal(z.getEntry('META-INF/FORGE.SF'), null, 'overlay 签名必须丢弃');
  assert.equal(z.getEntry('META-INF/FORGE.RSA'), null);
});

test('合并: 空 overlay 不破坏 base', () => {
  const d = tmp();
  const base = mkJar(path.join(d, 'base.jar'), { 'a.class': 'A' });
  const overlay = mkJar(path.join(d, 'u.jar'), {});
  const out = mergeJars(base, overlay, path.join(d, 'm.jar')).out;
  assert.equal(countEntries(out), 1);
});

test('真实 Forge installer 提取 universal 并冒烟合并', () => {
  const LOADERS = '/root/.codebuddy/artifact/2f8a7d30-9c21-4f0b-1d56-08153a6a8000/模组加载器';
  let installer = null;
  for (const dir of fs.readdirSync(LOADERS)) {
    const full = path.join(LOADERS, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      if (f.startsWith('forge-1.10.2') && f.endsWith('-installer.jar')) installer = path.join(full, f);
    }
  }
  if (!installer) { console.log('跳过: 无 Forge 1.10.2 样本'); return; }
  const d = tmp();
  const uni = extractUniversalFromInstaller(installer, d);
  assert.ok(fs.existsSync(uni) && fs.statSync(uni).size > 100000, 'universal jar 应存在');
  // 找一个真实原版客户端做 base（1.10.2 或任意小版本）
  const clientJar = '/workspace/MC正式版客户端/1.10.2.jar';
  if (!fs.existsSync(clientJar)) { console.log('跳过: 无 1.10.2 客户端样本'); return; }
  const out = path.join(d, 'merged.jar');
  const r = mergeJars(clientJar, uni, out);
  assert.ok(r.overwritten > 0, 'universal 应覆盖部分原版类');
  assert.ok(r.added > 0, 'universal 应新增大量 Forge 类');
  // 合并后应含 Forge 核心类
  const z = new AdmZip(out);
  const names = z.getEntries().map(e => e.entryName);
  assert.ok(names.some(n => n.startsWith('net/minecraftforge/')), '应含 minecraftforge 类');
  // 完整性: 合并后条目数 > 原版条目数
  assert.ok(countEntries(out) > countEntries(clientJar));
  // 合并 jar 的 version.json(游戏元数据) 保留
  assert.ok(z.getEntry('version.json') !== null, '游戏元数据 version.json 应保留');
});

test('损坏 installer 抛清晰错误', () => {
  const d = tmp();
  const p = path.join(d, 'bad.jar');
  fs.writeFileSync(p, 'garbage');
  assert.throws(() => extractUniversalFromInstaller(p, d), /无法打开 installer jar|未找到 universal\.jar/);
});

test('无 universal 的 installer 抛错', () => {
  const d = tmp();
  const p = mkJar(path.join(d, 'nouni.jar'), { 'foo.txt': 'bar' });
  assert.throws(() => extractUniversalFromInstaller(p, d), /未找到 universal\.jar/);
});
