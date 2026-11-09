/**
 * electron/main.cjs — Electron 主进程（窗口管理）
 *
 * 0.9.0 模块二A：启动路径减负（真实收益点，剖析数据见 DELIVERY-0.9.0.md）
 *  - dist 探测由同步存在性检查改为异步 fsp.access，启动路径零同步磁盘 IO
 *  - 局域网遥控 HTTP 服务延迟到首帧 ready-to-show 之后，用惰性 require + setImmediate
 *    拉起：它不是窗口显示所必需，绝不与首帧抢冷启动关键路径
 *  - 接入 bootMetrics 记录各阶段耗时并输出结构化日志（2s 预算可观测）
 *  - 非核心功能服务已在 ipc.cjs 用 lazy.cjs 代理，首次 IPC 访问才加载
 */
'use strict';

// 冷启动计时必须在任何模块加载之前创建，才能覆盖完整启动路径
const { createBootClock, format } = require('./bootMetrics.cjs');
const boot = createBootClock();
boot.mark('bootstrap');

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { app, BrowserWindow } = require('electron');
const { registerIpc, reapAllProcesses } = require('./ipc.cjs');
// 注意：remoteControl.cjs 不再顶层 require —— 非核心后台服务走首帧后惰性加载。
boot.mark('modules-loaded');

let mainWindow = null;

/**
 * 异步探测首帧加载目标。
 * development / 无 dist 构建 → Vite dev server；否则 → 本地 dist/index.html。
 * 用 fsp.access 替代同步存在性检查：同步 stat 会阻塞主进程事件循环。
 */
async function detectLoadTarget() {
  if (process.env.NODE_ENV === 'development') {
    return { type: 'url', value: 'http://localhost:5173' };
  }
  const indexHtml = path.join(__dirname, '..', 'dist', 'index.html');
  try {
    await fsp.access(indexHtml);
    return { type: 'file', value: indexHtml };
  } catch {
    return { type: 'url', value: 'http://localhost:5173' };
  }
}

function createWindow(target) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#0a0e17',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0a0e17', symbolColor: '#5eead4' },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  boot.mark('window-created');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    boot.mark('first-frame');
    // 结构化日志：可被宿主日志系统采集，真机定位冷启动瓶颈
    process.stdout.write(format(boot.snapshot()) + '\n');
    // 首帧之后再拉起非核心后台服务，避免与窗口显示抢冷启动关键路径
    deferNonCoreServices();
  });

  if (target.type === 'url') mainWindow.loadURL(target.value);
  else mainWindow.loadFile(target.value);
}

/**
 * 非核心后台服务延迟启动：局域网手机遥控 HTTP 服务（0.0.0.0:25300）。
 * 惰性 require（首帧前根本不解析该模块）+ setImmediate（让出当前事件循环 tick）。
 * 失败只写 stderr，绝不影响启动器主流程。
 */
function deferNonCoreServices() {
  setImmediate(() => {
    try {
      const { startRemoteControl } = require('./remoteControl.cjs');
      startRemoteControl();
      boot.mark('remote-deferred');
    } catch (e) {
      process.stderr.write(`[MC-Next][boot] 遥控服务延迟启动失败: ${e.message}\n`);
    }
  });
}

app.whenReady().then(async () => {
  boot.mark('app-ready');
  const target = await detectLoadTarget();
  boot.mark('probe-dist');
  createWindow(target);
  // IPC handler 必须首帧前注册：渲染层随时可能 invoke，不能延迟
  registerIpc(mainWindow);
  boot.mark('ipc-ready');
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(target);
  });
});

// 0.7.0 模块四：退出前回收所有由启动器拉起的 Java / Launcher 子进程，
// 避免关闭启动器后残留僵尸进程（detached 进程组不会随父进程自动退出）。
app.on('before-quit', () => {
  try {
    const r = reapAllProcesses();
    if (r.alive > 0) process.stderr.write(`[MC-Next] 退出清理：扫描 ${r.scanned}，回收 ${r.killed}/${r.alive} 个子进程\n`);
  } catch { /* 退出阶段绝不因清理抛错阻断退出 */ }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
