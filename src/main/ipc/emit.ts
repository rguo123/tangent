import { BrowserWindow } from 'electron'
import type { IpcEventChannel, IpcEventPayload } from '@shared/ipc'

/** How a main-process service pushes to the renderer. `emitToRenderers` is the
 *  only production implementation; services take it as a parameter so a test
 *  can collect events instead of needing a window. */
export type RendererEmit = <C extends IpcEventChannel>(
  channel: C,
  payload: IpcEventPayload<C>,
) => void

/** Typed wrapper over webContents.send — the push direction of the IPC
 *  contract. Broadcasts to every window; the MVP has exactly one, and a
 *  renderer that isn't showing the entry ignores the event anyway. */
export function emitToRenderers<C extends IpcEventChannel>(
  channel: C,
  payload: IpcEventPayload<C>,
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}
