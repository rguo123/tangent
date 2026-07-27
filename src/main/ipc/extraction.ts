import type { ExtractionService } from '../agent/extractionService'
import { handle } from './handle'

export function registerExtractionIpc(extraction: ExtractionService): void {
  handle('extraction:setActiveThread', ({ threadId }) => extraction.setActiveThread(threadId))
  handle('extraction:run', ({ threadId }) => extraction.run(threadId))
  handle('extraction:undo', ({ batchId }) => extraction.undo(batchId))
}
