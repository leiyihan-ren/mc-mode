'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GameLauncher, stripAnsi, classifyLine } = require('../engine/launcher');

test('stripAnsi 去除颜色码', () => {
  assert.equal(stripAnsi('\x1b[32mhello\x1b[0m'), 'hello');
  assert.equal(stripAnsi('plain'), 'plain');
});

test('classifyLine 日志分级', () => {
  assert.equal(classifyLine('[INFO] hello'), 'info');
  assert.equal(classifyLine('[WARN] careful'), 'warn');
  assert.equal(classifyLine('[ERROR] boom'), 'error');
  assert.equal(classifyLine('java.lang.Exception: x'), 'error');
  assert.equal(classifyLine('Done (3.2s)!'), 'success');
  assert.equal(classifyLine('random text'), 'normal');
});

test('真实 Java 进程: 启动/日志捕获/退出码', async () => {
  // java -version 输出到 stderr, 退出码 0 —— 验证进程管理全链路
  const gl = new GameLauncher({
    versionJson: { mainClass: 'x', arguments: { jvm: [], game: [] }, libraries: [] },
    classpath: '',
    gameDir: os.tmpdir(),
    nativesDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-nat-')),
    javaPath: 'java',
    versionId: 'test'
  });
  const lines = [];
  gl.on('log', l => lines.push(l.text));
  const exitP = new Promise(resolve => gl.on('exit', resolve));

  // 用自定义 java 命令: 覆写 mainClass 路径为 version 输出
  gl.opts.versionJson.mainClass = '-version';
  gl.launch();
  const res = await exitP;
  assert.equal(res.code, 0, 'java -version 退出码应为 0');
  const all = lines.join('\n');
  assert.ok(/version|openjdk|Java/i.test(all), `应捕获 java 版本输出, 实际: ${all.slice(0, 200)}`);
  assert.equal(gl.running, false);
});

test('sendCommand: 未运行时返回 false', () => {
  const gl = new GameLauncher({});
  assert.equal(gl.sendCommand('stop'), false);
});

test('重复 launch 抛错', () => {
  const gl = new GameLauncher({});
  gl.running = true;
  assert.throws(() => gl.launch(), /已在运行/);
});
