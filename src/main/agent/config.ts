import { readFileSync } from 'fs'
import { join } from 'path'
import { MOCK_CHAT_MODEL, MOCK_EMBEDDING_MODEL } from './provider/mock'

/**
 * Agent configuration: which endpoint, which models.
 *
 * A JSON file in the app-data dir (`agent.json`) overrides the defaults;
 * **API keys are never in it** — those come from the environment (see
 * src/main/env.ts), so the data dir stays safe to copy around as a backup. A
 * settings UI is Phase 7.
 *
 * `openai-compatible` is one implementation covering every endpoint that
 * speaks the OpenAI wire format, so switching vendors is a `baseUrl` + `model`
 * edit rather than new code.
 */

export interface AgentConfig {
  provider: 'openai-compatible' | 'mock'
  /** Chat endpoint root, e.g. https://openrouter.ai/api/v1 */
  baseUrl: string
  model: string
  embeddingProvider: 'openai-compatible' | 'voyage' | 'mock'
  /** Only consulted when `embeddingProvider` is `openai-compatible` — Voyage
   *  has a fixed endpoint. Embeddings are usually a different vendor from
   *  chat, since chat aggregators mostly don't serve them. */
  embeddingBaseUrl: string
  embeddingModel: string
}

export const AGENT_CONFIG_FILE = 'agent.json'

/**
 * OpenRouter by default: one key reaches hundreds of models, so trying a
 * cheaper or stronger one is a config edit. Model prices as of 2026-07-26 —
 * DeepSeek V4 Flash is $0.14/$0.28 per MTok (~35x under the Opus tier) with a
 * 1M context. `deepseek/deepseek-v4-pro` ($0.435/$0.87) is the same family a
 * quality tier up; `openai/gpt-oss-120b` ($0.037/$0.17) is the floor.
 */
export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  provider: 'openai-compatible',
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'deepseek/deepseek-v4-flash',
  // OpenRouter serves chat, not embeddings — Phase 5 needs a separate vendor.
  embeddingProvider: 'voyage',
  embeddingBaseUrl: 'https://api.openai.com/v1',
  embeddingModel: 'voyage-3.5-lite',
}

/** What `TANGENT_MOCK_LLM=1` resolves to. Exported so tests describe mock runs
 *  with the same object the app uses rather than a copy that can drift. */
export const MOCK_AGENT_CONFIG: AgentConfig = {
  provider: 'mock',
  baseUrl: '',
  model: MOCK_CHAT_MODEL,
  embeddingProvider: 'mock',
  embeddingBaseUrl: '',
  embeddingModel: MOCK_EMBEDDING_MODEL,
}

/**
 * Resolve config for this launch. `TANGENT_MOCK_LLM=1` wins over the file —
 * it's the offline-dev switch, and it should work regardless of what's on disk.
 * A malformed file degrades to the defaults with a warning rather than
 * blocking startup.
 */
export function loadAgentConfig(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): AgentConfig {
  if (env.TANGENT_MOCK_LLM === '1') return { ...MOCK_AGENT_CONFIG }

  let raw: string
  try {
    raw = readFileSync(join(dataDir, AGENT_CONFIG_FILE), 'utf8')
  } catch {
    return { ...DEFAULT_AGENT_CONFIG }
  }

  try {
    const parsed = JSON.parse(raw) as Partial<AgentConfig>
    return { ...DEFAULT_AGENT_CONFIG, ...parsed }
  } catch (err) {
    console.warn(`Ignoring malformed ${AGENT_CONFIG_FILE}: ${String(err)}`)
    return { ...DEFAULT_AGENT_CONFIG }
  }
}
