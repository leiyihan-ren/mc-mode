'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const c = require('../engine/server/console.cjs');
const sd = require('../engine/serverDeploy.js');

function tmp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcnext-con-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }

test('parseLogLine 解析真实 log4j 服务端日志（含 logger 段）', () => {
  const a = c.parseLogLine('[16:32:10] [Server thread/INFO]: Starting minecraft server version 1.20.1');
  assert.equal(a.time, '16:32:10');
  assert.equal(a.thread, 'Server thread');
  assert.equal(a.level, 'info');
  assert.equal(a.message, 'Starting minecraft server version 1.20.1');
  const b = c.parseLogLine('[16:32:11] [Worker-Main-3/WARN] [net.minecraft.server.packs.resources.ResourceManager/]: Missing texture');
  assert.equal(b.level, 'warn');
  assert.equal(b.logger, 'net.minecraft.server.packs.resources.ResourceManager/');
  assert.equal(b.message, 'Missing texture');
  const d = c.parseLogLine('[16:32:12] [Server thread/ERROR]: java.lang.NullPointerException: boom');
  assert.equal(d.level, 'error');
  assert.equal(c.parseLogLine('任意裸日志').level, 'info');
});

test('ANSI 清洗与彩色 HTML：SGR 还原 + XSS 转义', () => {
  const raw = '\x1b[31m[10:00:00] [Server thread/ERROR]: <script>alert(1)</script>\x1b[0m';
  assert.equal(c.stripAnsi(raw), '[10:00:00] [Server thread/ERROR]: <script>alert(1)</script>');
  const p = c.parseLogLine(raw);
  assert.equal(p.ansi, true);
  assert.equal(p.level, 'error');
  const html = c.highlight(raw);
  assert.ok(html.includes('mc-log-error'));
  assert.ok(html.includes('color:#e06c75'), 'SGR 31 应还原为红色');
  assert.ok(html.includes('&lt;script&gt;'), '必须转义 HTML');
  assert.ok(!html.includes('<script>alert'), '不得出现可执行脚本');
  assert.equal(c.escapeHtml('a&b"c\'d'), 'a&amp;b&quot;c&#39;d');
});

test('ServerConsole 真实子进程：双流日志、指令下发、优雅退出、导出', async (t) => {
  const dir = tmp(t);
  const script = path.join(dir, 'fake-server.sh');
  fs.writeFileSync(script, [
    '#!/bin/sh',
    'echo \'[12:00:01] [Server thread/INFO]: Starting minecraft server version 1.20.1\'',
    'echo \'[12:00:02] [Server thread/WARN]: Can\'"\'"\'t keep up! Is the server overloaded?\'',
    'printf \'\\033[31m[12:00:03] [Server thread/ERROR]: Crash <script>bad</script>\\033[0m\\n\'',
    'echo \'[12:00:04] [Server thread/INFO]: Done (3.000s)! For help, type "help"\'',
    'while read line; do',
    '  if [ "$line" = "stop" ]; then',
    '    echo \'[12:00:06] [Server thread/INFO]: Stopping server\'',
    '    exit 0',
    '  fi',
    '  echo "[12:00:05] [Server thread/INFO]: <console> $line"',
    'done'
  ].join('\n'));
  fs.chmodSync(script, 0o755);

  const con = new c.ServerConsole({ workDir: dir, command: '/bin/sh', args: [script] });
  const events = [];
  con.on('log', e => events.push(e));
  let watchdog;
  const exited = new Promise((resolve, reject) => {
    con.once('exit', (info) => { clearTimeout(watchdog); resolve(info); });
    watchdog = setTimeout(() => reject(new Error('服务端未在 10s 内退出')), 10000);
  });
  let sent = false;
  con.on('log', (e) => {
    if (!sent && e.text.includes('Done (3.000s)')) {
      sent = true;
      assert.equal(con.sendCommand('/stop'), true, '/stop 应写入 stdin');
    }
  });
  con.start();
  assert.equal(con.status().running, true);
  const exit = await exited;
  assert.equal(exit.code, 0);
  assert.equal(con.status().running, false);
  assert.ok(events.length >= 6);
  assert.ok(events.some(e => e.level === 'warn'));
  assert.ok(events.some(e => e.level === 'error' && e.ansi));
  assert.ok(events.some(e => e.command && e.text.includes('/stop')), '指令应回显');
  assert.ok(events.some(e => e.text.includes('Stopping server')), '服务端应响应 stop 指令');
  assert.equal(con.logs({ level: 'error' }).length, 1);
  assert.equal(con.logs({ query: 'Done' }).length, 1);
  assert.equal(con.logs({ limit: 2 }).length, 2);
  const txt = con.exportText(path.join(dir, 'logs', 'server.log'));
  assert.ok(fs.readFileSync(txt, 'utf8').includes('Stopping server'));
  const html = con.exportHtml(path.join(dir, 'logs', 'server.html'));
  assert.ok(fs.readFileSync(html, 'utf8').includes('mc-log-error'));
  assert.throws(() => con.start(), /已在运行|服务端已/);
});

test('服务端部署真实生成 eula.txt 与可执行启动脚本', (t) => {
  const dir = tmp(t);
  const eula = sd.writeEula(dir);
  assert.ok(fs.readFileSync(eula, 'utf8').includes('eula=true'));
  const s = sd.generateStartScripts(dir, { coreJar: 'server.jar', memory: '4G', extraArgs: '-XX:+UseG1GC ' });
  const sh = fs.readFileSync(s.sh, 'utf8');
  assert.ok(sh.startsWith('#!/bin/bash'));
  assert.ok(sh.includes('-Xms1G -Xmx4G'));
  assert.ok(sh.includes('-XX:+UseG1GC'));
  assert.ok(sh.includes('-jar server.jar nogui'));
  assert.ok((fs.statSync(s.sh).mode & 0o111) !== 0, 'start.sh 应可执行');
  assert.ok(fs.readFileSync(s.bat, 'utf8').includes('@echo off'));
});
