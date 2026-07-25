import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DEFAULT_AGENT_CONFIG } from '../../src/main/agent/config'
import { createMockProvider, createProvider, hashEmbedding } from '../../src/main/agent/provider'
import type { ChatDelta } from '../../src/main/agent/provider'

async function collect(stream: AsyncIterable<ChatDelta>): Promise<string> {
  let text = ''
  for await (const delta of stream) text += delta.text
  return text
}

describe('MockProvider', () => {
  it('streams a deterministic answer in chunks', async () => {
    const provider = createMockProvider()
    const request = {
      system: 'DOC',
      messages: [{ role: 'user' as const, content: 'What does section 3 argue?' }],
    }

    const chunks: string[] = []
    for await (const delta of provider.chat(request)) chunks.push(delta.text)

    expect(chunks.length).toBeGreaterThan(1) // actually streamed, not one blob
    const answer = chunks.join('')
    expect(answer).toContain('What does section 3 argue?')
    expect(await collect(createMockProvider().chat(request))).toBe(answer)
  })

  it('validates queued structured output against the caller schema', async () => {
    const provider = createMockProvider()
    const schema = z.object({ concepts: z.array(z.object({ canonicalText: z.string() })) })

    provider.queueStructured({ concepts: [{ canonicalText: 'self-attention' }] })
    const result = await provider.structured({
      prompt: 'extract',
      schema,
      schemaName: 'concepts',
    })
    expect(result.concepts[0].canonicalText).toBe('self-attention')

    // A response that doesn't match the schema fails here exactly as it would
    // against a live model — that's the point of parsing through zod.
    provider.queueStructured({ concepts: [{ canonical_text: 'wrong shape' }] })
    await expect(
      provider.structured({ prompt: 'extract', schema, schemaName: 'concepts' }),
    ).rejects.toThrow()
  })

  it('reports a missing queued response instead of inventing one', async () => {
    const provider = createMockProvider()
    await expect(
      provider.structured({ prompt: 'x', schema: z.object({}), schemaName: 'cards' }),
    ).rejects.toThrow(/no queued response for "cards"/)
  })

  it('fails on demand, once — the retryable error path', async () => {
    const provider = createMockProvider()
    provider.failNext('network down')

    await expect(
      collect(provider.chat({ messages: [{ role: 'user', content: 'hi' }] })),
    ).rejects.toThrow('network down')
    await expect(
      collect(provider.chat({ messages: [{ role: 'user', content: 'hi' }] })),
    ).resolves.toContain('Mock answer')
  })

  it('produces stable embeddings whose similarity tracks word overlap', async () => {
    const provider = createMockProvider()
    const [a, b, c] = await provider.embed([
      'attention is all you need',
      'attention is really all you need',
      'photosynthesis converts light into sugar',
    ])

    expect(Array.from(await provider.embed(['attention is all you need']))[0]).toEqual(a)
    expect(cosine(a, b)).toBeGreaterThan(0.85)
    expect(cosine(a, c)).toBeLessThan(0.2)
  })

  it('records calls so callers can assert on assembled context', async () => {
    const provider = createMockProvider()
    await collect(provider.chat({ system: 'the doc', messages: [{ role: 'user', content: 'q' }] }))
    expect(provider.chatCalls[0].system).toBe('the doc')
  })
})

describe('createProvider', () => {
  it('is unavailable — but constructible — without an API key', async () => {
    const provider = createProvider(DEFAULT_AGENT_CONFIG, {})
    expect(provider.unavailable).toMatch(/OPENROUTER_API_KEY/)
    // Construction must not throw: the app still launches, the ask just fails.
    await expect(
      collect(provider.chat({ messages: [{ role: 'user', content: 'q' }] })),
    ).rejects.toThrow(/OPENROUTER_API_KEY/)
  })

  it('accepts either the vendor-specific or the generic key', () => {
    expect(createProvider(DEFAULT_AGENT_CONFIG, { OPENROUTER_API_KEY: 'k' }).unavailable).toBeNull()
    expect(createProvider(DEFAULT_AGENT_CONFIG, { OPENAI_API_KEY: 'k' }).unavailable).toBeNull()
  })

  it('needs no key for a local server — Ollama and LM Studio authenticate nothing', () => {
    const provider = createProvider(
      { ...DEFAULT_AGENT_CONFIG, baseUrl: 'http://localhost:11434/v1', model: 'llama3.1:8b' },
      {},
    )
    expect(provider.unavailable).toBeNull()
  })

  it('reports the endpoint and models it will use', () => {
    const provider = createProvider(
      {
        ...DEFAULT_AGENT_CONFIG,
        baseUrl: 'https://api.groq.com/openai/v1',
        model: 'some-cheap-model',
        embeddingModel: 'voyage-test',
      },
      { OPENAI_API_KEY: 'k', VOYAGE_API_KEY: 'k' },
    )
    expect(provider.chatModel).toBe('some-cheap-model')
    expect(provider.chatBaseUrl).toBe('https://api.groq.com/openai/v1')
    expect(provider.embeddingModel).toBe('voyage-test')
  })

  it('mixes vendors: mock embeddings behind a real chat endpoint', async () => {
    const provider = createProvider(
      { ...DEFAULT_AGENT_CONFIG, embeddingProvider: 'mock' },
      { OPENAI_API_KEY: 'k' },
    )
    const [vector] = await provider.embed(['concept'])
    expect(vector).toEqual(hashEmbedding('concept'))
  })

  it('fails embeddings with an actionable message when only the chat key is set', async () => {
    const provider = createProvider(DEFAULT_AGENT_CONFIG, { OPENROUTER_API_KEY: 'k' })
    // Chat works, embeddings don't — extraction reports it, asking still runs.
    expect(provider.unavailable).toBeNull()
    await expect(provider.embed(['x'])).rejects.toThrow(/VOYAGE_API_KEY/)
  })

  it('keeps the chat and embedding keys apart when they are different services', async () => {
    const provider = createProvider(
      { ...DEFAULT_AGENT_CONFIG, embeddingProvider: 'openai-compatible' },
      { OPENROUTER_API_KEY: 'chat-key' },
    )
    // OPENROUTER_API_KEY must not be handed to the embeddings endpoint.
    await expect(provider.embed(['x'])).rejects.toThrow(/EMBEDDING_API_KEY/)
  })
})

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot // both vectors are unit length
}
