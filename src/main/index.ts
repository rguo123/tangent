import { join } from 'path'
import { app, BrowserWindow } from 'electron'
import { createAgentService } from './agent/ask'
import { loadAgentConfig } from './agent/config'
import { createExtractionService } from './agent/extractionService'
import { createProvider } from './agent/provider'
import { initStorage } from './db/init'
import { loadEnvFiles } from './env'
import { registerAgentIpc } from './ipc/agent'
import { registerDebugIpc } from './ipc/debug'
import { registerDocumentIpc } from './ipc/documents'
import { emitToRenderers } from './ipc/emit'
import { registerEntryIpc } from './ipc/entries'
import { registerExtractionIpc } from './ipc/extraction'
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
  const dataDir = process.env.TANGENT_DATA_DIR ?? app.getPath('userData')
  const storage = initStorage(dataDir)

  // API keys, before anything that might want one. The data dir comes first
  // because that's the per-install file a settings UI would eventually write
  // (Phase 7); the project-root file is the dev convenience.
  for (const file of loadEnvFiles([join(dataDir, '.env'), join(app.getAppPath(), '.env')])) {
    console.log(`Loaded ${file.path}: ${file.keys.join(', ') || 'no new keys'}`)
  }

  const agentConfig = loadAgentConfig(dataDir)
  const provider = createProvider(agentConfig)
  const agent = createAgentService(storage, provider, agentConfig, emitToRenderers)
  const extraction = createExtractionService(storage, provider, emitToRenderers)

  registerDebugIpc(storage.db)
  registerDocumentIpc(storage)
  registerThreadIpc(storage)
  registerEntryIpc(storage, extraction.touch)
  registerAgentIpc(agent, extraction.touch)
  registerExtractionIpc(extraction)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // Don't leave a stream writing into a DB that's about to close, or a timer
  // waiting to start one.
  app.on('before-quit', () => {
    agent.abortAll()
    extraction.dispose()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
