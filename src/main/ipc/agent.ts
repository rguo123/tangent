import type { AgentService } from '../agent/ask'
import type { OnThreadActivity } from '../agent/extractionService'
import { handle } from './handle'

export function registerAgentIpc(agent: AgentService, onActivity: OnThreadActivity): void {
  handle('agent:status', () => agent.status())

  handle('entries:ask', (req) => {
    const result = agent.ask(req)
    // The question counts as engagement the moment it's asked; the answer only
    // counts if it's pinned, which arrives as its own activity.
    onActivity(req.threadId)
    return result
  })

  handle('entries:retryAsk', ({ entryId }) => agent.retry(entryId))
}
