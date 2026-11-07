'use strict';
/** 【0.5.0 模块一】UI 视觉革命逻辑层单元测试（纯函数，无 IO / 无 DOM / 无网络） */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const A = require('../engine/appearance.cjs');

// ---------- 真实图片字节夹具（魔数 + IHDR 尺寸，模拟文件头，不做像素编码） ----------
function png(w, h) {
  const b = Buffer.alloc(24 + 8);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(32, 0x11)]);
const gif = (() => { const b = Buffer.alloc(16, 0); b.write('GIF89a', 0, 'ascii'); b.writeUInt16LE(128, 6); b.writeUInt16LE(64, 8); return b; })();
const webp = (() => { const b = Buffer.alloc(20, 0); b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(12, 4); b.write('WEBP', 8, 'ascii'); return b; })();

// ==================== 动态背景引擎 ====================
test('默认配置是深色极简，三种模式均合法', () => {
  const d = A.validateAppearance({});
  assert.equal(d.ok, true);
  assert.equal(d.config.mode, 'dark');
  assert.equal(d.config.imageDataUrl, null);
  for (const m of ['dark', 'particles']) {
    assert.equal(A.validateAppearance({ mode: m }).config.mode, m);
  }
});

test('未知模式回退 dark 并给出 warning', () => {
  const r = A.validateAppearance({ mode: 'wallpaper-engine-9000' });
  assert.equal(r.config.mode, 'dark');
  assert.ok(r.issues.some(i => i.type === 'bad-mode'));
});

test('数值夹取：粒子数/模糊/遮罩越界被规范化', () => {
  const r = A.validateAppearance({ mode: 'particles', particleCount: 99999, blur: -5, overlayOpacity: 5, particleSpeed: 'abc', particleColor: 'red' });
  assert.equal(r.config.particleCount, 240);
  assert.equal(r.config.blur, 0);
  assert.equal(r.config.overlayOpacity, 0.9);
  assert.equal(r.config.particleSpeed, A.DEFAULT_APPEARANCE.particleSpeed);
  assert.equal(r.config.particleColor, A.DEFAULT_APPEARANCE.particleColor);
});

// ==================== 本地背景图片校验 ====================
test('detectImageMime 真实识别 PNG/JPEG/GIF/WebP，拒绝乱码', () => {
  assert.equal(A.detectImageMime(png(64, 32)), 'image/png');
  assert.equal(A.detectImageMime(jpeg), 'image/jpeg');
  assert.equal(A.detectImageMime(gif), 'image/gif');
  assert.equal(A.detectImageMime(webp), 'image/webp');
  assert.equal(A.detectImageMime(Buffer.from('not an image')), null);
});

test('inspectBackgroundImage 读 PNG 宽高 + sha256 + 生成合法 dataUrl', () => {
  const r = A.inspectBackgroundImage(png(64, 32));
  assert.equal(r.ok, true);
  assert.equal(r.mime, 'image/png');
  assert.equal(r.width, 64);
  assert.equal(r.height, 32);
  assert.equal(r.size, png(64, 32).length);
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
  assert.ok(r.dataUrl.startsWith('data:image/png;base64,'));
});

test('声明类型与实际不符被拒绝，不编造通过', () => {
  const r = A.inspectBackgroundImage(jpeg, 'image/png');
  assert.equal(r.ok, false);
  assert.match(r.error, /不符/);
});

test('非图片字节 / 空字节被拒绝', () => {
  assert.equal(A.inspectBackgroundImage(Buffer.from('hello')).ok, false);
  assert.equal(A.inspectBackgroundImage(Buffer.alloc(0)).ok, false);
  assert.equal(A.inspectBackgroundImage(null).ok, false);
});

test('超过 12MB 上限被拒绝', () => {
  const big = Buffer.concat([png(16, 16), Buffer.alloc(A.MAX_IMAGE_BYTES + 1, 0)]);
  const r = A.inspectBackgroundImage(big);
  assert.equal(r.ok, false);
  assert.match(r.error, /上限/);
});

test('validateImageDataUrl 往返、拒绝非图片 dataUrl', () => {
  const r = A.inspectBackgroundImage(gif);
  assert.equal(A.validateImageDataUrl(r.dataUrl).ok, true);
  assert.equal(A.validateImageDataUrl('https://example.com/a.png').ok, false);
  assert.equal(A.validateImageDataUrl('data:text/plain;base64,aGVsbG8=').ok, false);
});

test('image 模式无合法图片 → 明确 error 并回退 dark', () => {
  const r = A.validateAppearance({ mode: 'image', imageDataUrl: null });
  assert.equal(r.ok, false);
  assert.equal(r.config.mode, 'dark');
  assert.ok(r.issues.some(i => i.type === 'image-invalid'));
});

test('image 模式带合法 dataUrl → 保留且不降级', () => {
  const dataUrl = A.inspectBackgroundImage(png(100, 50)).dataUrl;
  const r = A.validateAppearance({ mode: 'image', imageDataUrl: dataUrl, blur: 20 });
  assert.equal(r.ok, true);
  assert.equal(r.config.mode, 'image');
  assert.equal(r.config.blur, 20);
  assert.equal(r.config.imageDataUrl, dataUrl);
});

// ==================== 极客 JVM 面板 ====================
test('parseJvmArgs 支持引号 / 多行 / # 注释', () => {
  const text = `
# 这是整行注释
-XX:+UseG1GC -XX:MaxGCPauseMillis=200
-Dminecraft.launcher.brand="MC Next" -Dfoo=bar
-XX:+AlwaysPreTouch # 行内注释到行尾
`;
  const args = A.parseJvmArgs(text);
  assert.deepEqual(args, [
    '-XX:+UseG1GC', '-XX:MaxGCPauseMillis=200',
    '-Dminecraft.launcher.brand=MC Next', '-Dfoo=bar',
    '-XX:+AlwaysPreTouch'
  ]);
});

test('validateJvmArgs 拦截 shell 元字符 / 非 flag，去重', () => {
  const r = A.validateJvmArgs(['-XX:+UseG1GC', '-XX:+UseG1GC', 'java -jar evil.jar;rm -rf /', 'plainword', '--not-flag-but-ok', 'echo `whoami`']);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some(i => i.type === 'unsafe-char'));
  assert.ok(r.issues.some(i => i.type === 'not-a-flag'));
  assert.equal(r.args.filter(a => a === '-XX:+UseG1GC').length, 1);
  assert.ok(r.args.includes('--not-flag-but-ok'));
  assert.ok(!r.args.includes('plainword'));
});

test('-Xmx/-Xms 被界面内存托管，剥离并给出 warning', () => {
  const r = A.validateJvmArgs(['-Xmx8G', '-Xms2G', '-XX:+UseG1GC']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.args, ['-XX:+UseG1GC']);
  assert.equal(r.issues.filter(i => i.type === 'memory-managed').length, 2);
});

test('recommendedProfiles 返回 4 个真实预设，G1 含 UseG1GC 且不含内存项', () => {
  const ps = A.recommendedProfiles();
  assert.equal(ps.length, 4);
  const g1 = ps.find(p => p.id === 'g1');
  assert.ok(g1.args.includes('-XX:+UseG1GC'));
  assert.ok(g1.args.some(a => a.startsWith('-XX:MaxGCPauseMillis=')));
  assert.ok(!g1.args.some(a => /^-Xmx|^-Xms/.test(a)), '预设不应自带内存参数');
  // 返回副本，外部修改不影响常量
  g1.args.push('-Dmutated');
  assert.ok(!A.recommendedProfiles().find(p => p.id === 'g1').args.includes('-Dmutated'));
});

test('mergeLaunchJvm：预设 + 自定义合并、内存独立、非法内存回退预设', () => {
  const r = A.mergeLaunchJvm({ profileId: 'g1', extraJvmArgsText: '-Dfoo=bar -XX:+UseG1GC', minMemory: '2G', maxMemory: '6G' });
  assert.equal(r.ok, true);
  assert.equal(r.profileId, 'g1');
  assert.equal(r.minMemory, '2G');
  assert.equal(r.maxMemory, '6G');
  assert.ok(r.jvmArgs.includes('-XX:+UseG1GC'));
  assert.ok(r.jvmArgs.includes('-Dfoo=bar'));
  assert.equal(r.jvmArgs.filter(a => a === '-XX:+UseG1GC').length, 1, '预设与自定义重复项应去重');
  assert.ok(!r.jvmArgs.some(a => /^-Xmx|^-Xms/.test(a)));
});

test('mergeLaunchJvm：无预设时仅用自定义；非法内存格式回退默认', () => {
  const r = A.mergeLaunchJvm({ extraJvmArgsText: '-Dk=v', minMemory: '999TB', maxMemory: '; evil' });
  assert.equal(r.profileId, null);
  assert.deepEqual(r.jvmArgs, ['-Dk=v']);
  assert.equal(r.minMemory, '1G');
  assert.equal(r.maxMemory, '4G');
});

test('mergeLaunchJvm：危险自定义参数导致 ok:false 且被剔除', () => {
  const r = A.mergeLaunchJvm({ profileId: 'lowspec', extraJvmArgsText: '-Dok=1 badtoken' });
  assert.equal(r.ok, false);
  assert.ok(!r.jvmArgs.includes('badtoken'));
  assert.ok(r.jvmArgs.includes('-Dok=1'));
  assert.ok(r.jvmArgs.includes('-XX:+UseG1GC'), '预设参数仍保留');
});

test('clampNumber 对 NaN / 非数字回退默认值', () => {
  assert.equal(A.clampNumber('abc', 0, 10, 7), 7);
  assert.equal(A.clampNumber(999, 0, 10, 7), 10);
  assert.equal(A.clampNumber(-5, 0, 10, 7), 0);
});
