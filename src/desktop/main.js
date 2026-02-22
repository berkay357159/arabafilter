const path = require('path');
const { app: electronApp, BrowserWindow, dialog } = require('electron');
const { startServer } = require('../app');

let mainWindow;
let server;
let port;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 960,
    minHeight: 700,
    autoHideMenuBar: true,
    title: 'Araç Fiyat Paneli',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadURL(`http://localhost:${port}`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function startDesktop() {
  try {
    const started = startServer(Number(process.env.PORT) || 3000);
    server = started.server;
    port = started.port;
    createWindow();
  } catch (error) {
    dialog.showErrorBox(
      'Uygulama Başlatılamadı',
      error.code === 'EADDRINUSE'
        ? `Port ${Number(process.env.PORT) || 3000} zaten kullanımda. Önce çalışan kopyayı kapatın.`
        : `Beklenmeyen hata: ${error.message}`
    );
    electronApp.quit();
  }
}

electronApp.whenReady().then(startDesktop);

electronApp.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

electronApp.on('window-all-closed', () => {
  if (server) {
    server.close(() => {
      electronApp.quit();
    });
    return;
  }

  electronApp.quit();
});
