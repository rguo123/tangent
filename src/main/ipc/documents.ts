import { dialog } from 'electron'
import type { Storage } from '../db/init'
import {
  IMPORT_FILE_FILTERS,
  importDocument,
  importUrlDocument,
  readDocumentContent,
} from '../documents/import'
import { fetchBytesViaClipSession, fetchPageViaBrowser } from '../documents/webFetch'
import { handle } from './handle'

export function registerDocumentIpc(storage: Storage): void {
  handle('documents:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Import document',
      properties: ['openFile'],
      filters: IMPORT_FILE_FILTERS,
    })
    if (canceled || filePaths.length === 0) return null
    return importDocument(storage, filePaths[0])
  })

  handle('documents:importUrl', ({ url }) =>
    importUrlDocument(storage, url, {
      fetchPage: fetchPageViaBrowser,
      fetchBytes: fetchBytesViaClipSession,
    }),
  )

  handle('documents:content', ({ documentId }) => readDocumentContent(storage, documentId))
}
