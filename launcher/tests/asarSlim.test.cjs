'use strict';
/**
 * asarSlim.test.cjs — 0.9.0 通宵加固·模块二B：桌面安装包体积防回退守卫
 *
 * 【排查结论】v0.6.0 的 app.asar 达 23.8MB，其中 node_modules 独占 25MB(解包后)，
 * 而真正需要随主进程运行的只有 adm-zip（engine/ 下 11 个文件真实 require）。
 * three(13M)/skinview3d(9.4M)/@capacitor/core(368K) 只被 src/ 渲染层 import，
 * 且 Vite 已把它们的实现完整打进 dist/assets/*.js（自包含、零 bare import）；
 * axios(1.9M)+其传递依赖全仓零 import（主进程用 Node 原生 fetch）。
 * 这些被误放在 dependencies → electron-builder 原样复制进 asar，纯属冗余。
 *
 * 【修复】把 4 个「仅构建期需要」的依赖移到 devDependencies，
 * dependencies 只保留 adm-zip；实测 app.asar 23.8MB → 1.44MB（-94%），
 * 解包 27M → 1.6M，node_modules 只剩 adm-zip，dist/electron/engine/config 完整。
 * 主进程运行时（Electron/Chromium）只加载 dist 与 engine，不 require 这些前端库，
 * 因此零功能影响；devDependencies 在 npm run build:renderer 时仍可用，构建不回归。
 *
 * 【本测试作用】静态守卫，防止未来有人把前端库塞回 dependencies 或让白名单失守。
 * 真实体积字节由构建脚本产出，不在单测里伪造；本测试只守结构与引用不变量。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const lock = require('../package-lock.json');

const FRONTEND_ONLY = ['three', 'skinview3d', '@capacitor/core', 'axios'];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'build', '.git'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(cjs|js|mjs|jsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const read = (p) => fs.readFileSync(p, 'utf8');

// ==================== 1. 生产依赖收敛 ====================
test('dependencies 仅保留主进程真实需要的 adm-zip，前端库全部在 devDependencies', () => {
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['adm-zip'],
    '生产依赖应只有 adm-zip；前端库误入 dependencies 会让 asar 回胖');
  for (const d of FRONTEND_ONLY) {
    assert.ok(pkg.devDependencies[d], `${d} 应移到 devDependencies 供 Vite 构建期使用`);
    assert.equal(pkg.dependencies[d], undefined, `${d} 不得留在 dependencies`);
  }
});

test('package-lock 顶层与 package.json 依赖声明一致（npm ci 可复现）', () => {
  const root = lock.packages[''];
  assert.equal(root.version, pkg.version, 'lock 版本应同步 0.9.0');
  assert.deepEqual(root.dependencies, pkg.dependencies);
  for (const d of Object.keys(pkg.devDependencies)) {
    assert.equal(root.devDependencies[d], pkg.devDependencies[d], `lock devDeps 缺 ${d}`);
  }
});

test('主进程侧零引用前端库：electron/engine 不 require three/skinview3d/capacitor/axios', () => {
  const files = [...walk(path.join(ROOT, 'electron')), ...walk(path.join(ROOT, 'engine'))];
  for (const f of files) {
    const code = read(f);
    for (const d of FRONTEND_ONLY) {
      const re = new RegExp(`require\\(['\"]${d.replace('/', '\\/')}['\"]\\)|from ['\"]${d.replace('/', '\\/')}['\"]`);
      assert.ok(!re.test(code),
        `主进程文件 ${path.relative(ROOT, f)} 不应直接 require ${d}（会打进 asar 运行时）`);
    }
  }
});

test('主进程唯一生产依赖 adm-zip 被真实使用（不是留了个没用的包）', () => {
  const files = walk(path.join(ROOT, 'engine'));
  const users = files.filter(f => /require\(['"]adm-zip['"]\)/.test(read(f)));
  assert.ok(users.length >= 5, `adm-zip 应有多处真实引用，实际 ${users.length}`);
});

// ==================== 2. 渲染层自包含（移到 devDeps 后运行时不缺库） ====================
test('前端库只被 src/ import，且 Vite 无 external 配置（全部打进 dist）', () => {
  const vite = read(path.join(ROOT, 'vite.config.mjs'));
  assert.ok(!/external/.test(vite), 'vite 不得 external 前端库，否则运行时会去 node_modules 找');
  const srcFiles = walk(path.join(ROOT, 'src'));
  const importers = FRONTEND_ONLY.filter(d =>
    srcFiles.some(f => read(f).includes(`from '${d}'`) || read(f).includes(`from "${d}"`)));
  // skinview3d / @capacitor/core 有真实渲染层 import；three/axios 允许零引用
  assert.ok(importers.includes('skinview3d'));
  assert.ok(importers.includes('@capacitor/core'));
});

test('dist 产物零 bare import（构建后自包含，运行不依赖 node_modules）', () => {
  const assets = path.join(ROOT, 'dist', 'assets');
  if (!fs.existsSync(assets)) return; // 未构建时跳过，构建脚本会产出
  const js = fs.readdirSync(assets).filter(f => f.endsWith('.js'));
  for (const f of js) {
    const code = read(path.join(assets, f));
    for (const d of FRONTEND_ONLY) {
      const re = new RegExp(`from\\s*['"]${d.replace('/', '\\/')}['"]`);
      assert.ok(!re.test(code), `dist/${f} 残留 bare import ${d}（瘦身后会白屏）`);
    }
    // three / capacitor 的实现特征确实被打进 bundle
    assert.ok(/WebGLRenderer|isNativePlatform|registerPlugin/.test(code),
      'dist 应自包含 3D / Capacitor 实现');
  }
});

// ==================== 3. 打包白名单收敛 ====================
test('build.files 白名单只含运行期目录，不含 node_modules 通配（依赖由 dependencies 自动带入）', () => {
  const files = pkg.build.files;
  assert.ok(Array.isArray(files));
  assert.ok(files.includes('electron/**/*'));
  assert.ok(files.includes('engine/**/*'));
  assert.ok(files.includes('dist/**/*'));
  assert.ok(files.includes('package.json'));
  const bad = files.filter(f => /node_modules/.test(f) && !f.startsWith('!'));
  assert.deepEqual(bad, [], '不得用通配把整个 node_modules 打进 asar');
});

test('构建脚本与瘦身工具链齐备（可复现、产物级审计）', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'tools', 'apk-slim.cjs')), '缺少 APK 瘦身工具');
  assert.ok(fs.existsSync(path.join(ROOT, 'tools', 'build-signed-desktop.sh')), '缺少签名构建链');
  const scripts = pkg.scripts;
  assert.ok(scripts['build:renderer'], '应有渲染层构建');
  assert.ok(scripts.build.includes('electron-builder'), '应有桌面打包');
});
