import type { AgentService } from '../agent/ask'
import { handle } from './handle'

export function registerAgentIpc(agent: AgentService): void {
  handle('agent:status', () => agent.status())
  handle('entries:ask', (req) => agent.ask(req))
  handle('entries:retryAsk', ({ entryId }) => agent.retry(entryId))
}
