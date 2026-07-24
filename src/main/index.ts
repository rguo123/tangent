import { join } from 'path'
import { app, BrowserWindow } from 'electron'
import { initStorage } from './db/init'
import { registerDebugIpc } from './ipc/debug'
import { registerDocumentIpc } from './ipc/documents'
import { registerEntryIpc } from './ipc/entries'
import { registerThreadIpc } from './ipc/threads'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // Env override keeps automated runs / scratch profiles out of the real DB.
  const storage = initStorage(process.env.TANGENT_DATA_DIR ?? app.getPath('userData'))
  registerDebugIpc(storage.db)
  registerDocumentIpc(storage)
  registerThreadIpc(storage)
  registerEntryIpc(storage)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
