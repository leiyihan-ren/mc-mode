'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const an = require('../engine/crash/analyzer.cjs');
const lc = require('../engine/crash/logCleaner.cjs');

// 按真实 Minecraft crash-report / latest.log 格式构造的样本
const OOM_LOG = [
  '[16:32:10] [Server thread/INFO]: Starting minecraft server version 1.20.1',
  '[16:32:11] [Server thread/ERROR]: Encountered an unexpected exception',
  'java.lang.OutOfMemoryError: Java heap space',
  '\tat net.minecraft.world.World.func_72966_v(World.java:1234)',
  '\tat net.minecraft.server.MinecraftServer.func_71190_q(MinecraftServer.java:789)',
  '---- Minecraft Crash Report ----',
  'Description: Ticking entity',
  '---- End of report ----'
].join('\n');

const JAVA_LOG = [
  '[10:00:00] [main/INFO]: Loading 1.20.1',
  'java.lang.UnsupportedClassVersionError: net/minecraft/client/main/Main has been compiled by a more recent version of the Java Runtime (class file version 61.0), this version of the Java Runtime only recognizes class file versions up to 52.0',
  '\tat java.base/java.lang.ClassLoader.defineClass1(Native Method)',
  '\tat net.fabricmc.loader.impl.launch.knot.KnotClassDelegate.tryLoadClass(KnotClassDelegate.java:1)',
  'Caused by: java.lang.ClassNotFoundException: net.minecraft.client.main.Main'
].join('\n');

const STACK_LOG = [
  '[16:32:10] [main/INFO]: Loading Minecraft 1.20.1 with Fabric',
  '[16:32:11] [main/INFO]: Environment: authHost=https://authserver.mojang.com, session=eyJhbGciOiJIUzI1NiJ9SECRETVALUE123456, contact=dev@example.com, ip=192.168.1.77',
  '[16:32:12] [main/WARN]: Mod sodium uses deprecated API',
  '[16:32:13] [main/ERROR]: Caught exception in mod loader',
  'java.lang.RuntimeException: Something broke in mod init',
  '\tat net.minecraft.client.main.Main.main(Main.java:1)',
  '\tat com.example.mymod.MyMod.init(MyMod.java:42)',
  'Caused by: java.io.FileNotFoundException: config/mymod.cfg (No such file or directory)',
  '\tat java.base/java.io.FileInputStream.open0(Native Method)',
  '\t... 12 more',
  ...Array.from({ length: 20 }, () => "[16:32:14] [Server thread/WARN]: Can't keep up! Is the server overloaded?"),
  '[16:32:35] [main/INFO]: Login --accessToken eyJhbGciOiJIUzI1NiJ9SECRETTOKEN --uuid 069a79f4-44e9-4726-a5be-fca90e38aaf5',
  '[16:32:36] [main/ERROR]: Rendering entity in world',
  '---- Minecraft Crash Report ----',
  'Description: Rendering entity in world',
  'java.lang.NullPointerException: Cannot invoke method because entity is null',
  '\tat net.minecraft.client.renderer.entity.EntityRenderer.render(EntityRenderer.java:120)',
  '---- End of report ----',
  '[16:32:37] [main/INFO]: Stopping!'
].join('\n');

// ---------------- analyzer ----------------
test('OOM 崩溃诊断：primary=fatal/OOM，含可执行建议', () => {
  const r = an.analyzeCrash({ log: OOM_LOG, exitCode: 1, gameVersion: '1.20.1' });
  assert.equal(r.ok, false);
  assert.equal(r.severity, 'fatal');
  assert.equal(r.primary.code, 'OOM');
  assert.ok(r.primary.suggestions.some(s => s.includes('-Xmx')));
  assert.equal(r.description, 'Ticking entity');
  assert.equal(r.gameVersion, '1.20.1');
  assert.ok(r.summary.includes('堆内存溢出'));
});

test('Java 版本不匹配：class file version 61 → Java 17，并按当前 Java 给出提示', () => {
  const r = an.analyzeCrash({ log: JAVA_LOG, exitCode: 1, javaVersion: 8 });
  assert.equal(r.javaRequired, 17);
  assert.equal(r.javaCurrent, 8);
  assert.ok(r.findings.some(f => f.code === 'JAVA_VERSION'));
  assert.ok(r.findings.some(f => f.code === 'MISSING_LIB'));
  assert.ok(r.primary.suggestions.some(s => s.includes('Java 17')));
  assert.ok(r.causedBy.some(x => x.includes('ClassNotFoundException')));
  assert.equal(an.classFileVersionToJava(52), 8);
  assert.equal(an.classFileVersionToJava(65), 21);
});

test('缺库 / 渲染 / 模组冲突 / JVM 启动失败各自命中规则', () => {
  assert.ok(an.analyzeCrash('java.lang.NoClassDefFoundError: org/lwjgl/glfw/GLFWErrorCallback').findings.some(f => f.code === 'MISSING_LIB'));
  assert.ok(an.analyzeCrash('GLFW error 65544: X11: The DISPLAY environment variable is missing').findings.some(f => f.code === 'GL_RENDER'));
  assert.ok(an.analyzeCrash('Mixin apply failed: mixin.sodium.json -> net.minecraft.client.render').findings.some(f => f.code === 'MOD_CONFLICT'));
  assert.ok(an.analyzeCrash('Error: Could not find or load main class net.minecraft.client.main.Main').findings.some(f => f.code === 'JVM_BOOT'));
});

test('退出码 137 / SIGKILL 判定为 OOM Killer，正常退出无致命诊断', () => {
  const kill = an.analyzeCrash({ log: 'no error here', exitCode: 137 });
  assert.equal(kill.primary.code, 'OOM_KILLED');
  const sig = an.analyzeCrash({ log: 'killed', signal: 'SIGKILL' });
  assert.equal(sig.primary.code, 'OOM_KILLED');
  const ok = an.analyzeCrash({ log: '[10:00:00] [main/INFO]: Stopping!', exitCode: 0 });
  assert.equal(ok.ok, true);
  assert.equal(ok.primary.code, 'NORMAL');
});

test('从堆栈帧提取可疑第三方模组包名', () => {
  const s = an.extractModSuspects('\tat com.example.mymod.MyMod.init(MyMod.java:42)\n\tat net.minecraft.client.main.Main.main(Main.java:1)');
  assert.ok(s.includes('com.example.mymod'));
  assert.ok(!s.includes('net.minecraft'));
});

// ---------------- logCleaner ----------------
test('cleanLatestLog 提取错误/警告/堆栈/Caused by/崩溃报告块', () => {
  const r = lc.cleanLatestLog(STACK_LOG);
  assert.equal(r.errors.length, 2);
  assert.equal(r.warnings.length, 21, '1 条普通警告 + 20 条刷屏警告');
  assert.ok(r.stackTraces.length >= 1);
  const first = r.stackTraces[0];
  assert.ok(first.header.includes('RuntimeException'));
  assert.ok(first.frames.some(f => f.includes('com.example.mymod.MyMod.init')));
  assert.ok(first.causedBy.some(x => x.includes('FileNotFoundException')));
  assert.ok(r.reportBlock.some(p => p.text.includes('Description: Rendering entity in world')));
  assert.ok(r.noiseRemoved > 0, 'INFO 噪声应被剔除');
  assert.ok(r.summary.includes('RuntimeException') || r.summary.includes('Rendering'));
});

test('相邻重复刷屏压缩计数', () => {
  const r = lc.cleanLatestLog(STACK_LOG);
  const dup = r.deduped.find(d => d.text.includes("Can't keep up"));
  assert.equal(dup.count, 20);
  assert.ok(lc.toPlainTextReport(r).includes('重复 20 次'));
});

test('敏感信息脱敏：token / uuid / email / IP', () => {
  const r = lc.cleanLatestLog(STACK_LOG);
  const all = r.lines.map(l => l.text).join('\n');
  assert.ok(all.includes('<redacted>'), '应出现脱敏占位');
  assert.ok(!all.includes('SECRETTOKEN'), 'accessToken 不得残留');
  assert.ok(!all.includes('SECRETVALUE123456'), 'session 不得残留');
  assert.ok(!all.includes('dev@example.com'), '邮箱不得残留');
  assert.ok(!all.includes('192.168.1.77'), 'IP 不得残留');
  assert.equal(r.redacted, true);
  assert.ok(!lc.cleanLatestLog(STACK_LOG, { redactTokens: false }).lines.map(l => l.text).join('\n').includes('<redacted>'));
});

test('maxLines 截断、空输入安全、报告可导出', () => {
  const r = lc.cleanLatestLog(STACK_LOG, { maxLines: 12 });
  assert.ok(r.keptLines <= 12);
  assert.equal(r.totalLines, STACK_LOG.split('\n').length);
  const empty = lc.cleanLatestLog('');
  assert.equal(empty.totalLines, 0);
  assert.equal(empty.errors.length, 0);
  assert.match(empty.summary, /未发现/);
  const txt = lc.toPlainTextReport(r);
  assert.ok(txt.includes('MC-Next 日志净化报告'));
  assert.ok(txt.includes('关键报错'));
});

test('净化结果可直接喂给崩溃分析器（模块联动）', () => {
  const cleaned = lc.cleanLatestLog(OOM_LOG);
  const r = an.analyzeCrash({ log: cleaned.lines.map(l => l.raw).join('\n'), exitCode: 1 });
  assert.equal(r.primary.code, 'OOM');
  assert.equal(r.description, 'Ticking entity');
});
