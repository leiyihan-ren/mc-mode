/**
 * tests/smoke-electron.cjs — Electron UI 冒烟测试（无头）
 * 启动应用 → 等待渲染 → 截图 → 验证 IPC 往返 → 退出
 */
'use strict';
const path = require('path');
const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280, height: 820, show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, '..', 'electron', 'preload.cjs')
    }
  });
  await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  const { registerIpc } = require('../electron/ipc.cjs');
  registerIpc(win);
  await new Promise(r => setTimeout(r, 2500));

  const results = { ok: true, checks: [] };
  const check = (name, pass, extra) => {
    results.checks.push({ name, pass, extra });
    if (!pass) results.ok = false;
  };

  // 1. React 根节点渲染
  const rootHtml = await win.webContents.executeJavaScript('document.getElementById("root").innerHTML.length');
  check('React 渲染非空', rootHtml > 500, `innerHTML length=${rootHtml}`);

  // 2. 标题/导航渲染
  const bodyText = await win.webContents.executeJavaScript('document.body.innerText');
  check('侧边导航渲染', bodyText.includes('游戏启动') && bodyText.includes('下载中心'));
  check('标题渲染', bodyText.includes('MC-Next'));

  // 3. IPC 往返（通过 preload 暴露的 mcnext）
  try {
    const clients = await win.webContents.executeJavaScript('window.mcnext.listClients()');
    check('IPC listClients', Array.isArray(clients) && clients.length > 0, `返回 ${clients ? clients.length : 0} 个客户端`);
  } catch (e) {
    check('IPC listClients', false, String(e));
  }

  // 4. 截图
  const img = await win.webContents.capturePage();
  require('fs').writeFileSync(path.join(__dirname, '..', 'smoke.png'), img.toPNG());
  check('截图已保存', true, 'smoke.png');

  console.log('SMOKE_RESULT:' + JSON.stringify(results));
  app.exit(results.ok ? 0 : 1);
});
