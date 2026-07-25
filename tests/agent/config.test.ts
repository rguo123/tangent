import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_CONFIG_FILE,
  DEFAULT_AGENT_CONFIG,
  loadAgentConfig,
} from '../../src/main/agent/config'

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'tangent-config-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function writeConfig(contents: string): void {
  writeFileSync(join(dataDir, AGENT_CONFIG_FILE), contents)
}

describe('loadAgentConfig', () => {
  it('uses the defaults when no config file exists', () => {
    expect(loadAgentConfig(dataDir, {})).toEqual(DEFAULT_AGENT_CONFIG)
  })

  it('overlays the file onto the defaults, field by field', () => {
    writeConfig(JSON.stringify({ model: 'openai/gpt-oss-120b' }))
    expect(loadAgentConfig(dataDir, {})).toEqual({
      ...DEFAULT_AGENT_CONFIG,
      model: 'openai/gpt-oss-120b',
    })
  })

  it('switches endpoint and model together — the whole point of the wire format', () => {
    // Pointing at a local server is a config edit, not new code.
    writeConfig(JSON.stringify({ baseUrl: 'http://localhost:11434/v1', model: 'llama3.1:8b' }))
    const config = loadAgentConfig(dataDir, {})
    expect(config.provider).toBe('openai-compatible')
    expect(config.baseUrl).toBe('http://localhost:11434/v1')
    expect(config.model).toBe('llama3.1:8b')
  })

  it('lets TANGENT_MOCK_LLM win over the file — offline dev must always work', () => {
    writeConfig(JSON.stringify({ baseUrl: 'https://openrouter.ai/api/v1', model: 'some-model' }))
    const config = loadAgentConfig(dataDir, { TANGENT_MOCK_LLM: '1' })
    expect(config.provider).toBe('mock')
    expect(config.embeddingProvider).toBe('mock')
  })

  it('degrades to the defaults on a malformed file rather than blocking startup', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeConfig('{ not json')
    expect(loadAgentConfig(dataDir, {})).toEqual(DEFAULT_AGENT_CONFIG)
    expect(warn).toHaveBeenCalled()
  })
})
