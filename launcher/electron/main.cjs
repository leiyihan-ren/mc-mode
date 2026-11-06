/**
 * electron/main.cjs — Electron 主进程（窗口管理）
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const { registerIpc } = require('./ipc.cjs');
const { startRemoteControl } = require('./remoteControl.cjs');

let mainWindow = null;

function createWindow() {
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
  mainWindow.once('ready-to-show', () => mainWindow.show());

  if (process.env.NODE_ENV === 'development' || !fs.existsSync(path.join(__dirname, '..', 'dist', 'index.html'))) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();
  registerIpc(mainWindow);
  startRemoteControl(); // 局域网手机遥控（端口 25300）
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
