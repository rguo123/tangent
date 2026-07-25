import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  createOpenAICompatibleChat,
  createOpenAICompatibleEmbeddings,
} from '../../src/main/agent/provider/openaiCompatible'

/**
 * Wire-format tests against a stubbed `fetch`. The point is the shape of what
 * we send and how we read what comes back — the same contract every
 * OpenAI-compatible endpoint implements, so these hold for OpenRouter, Groq,
 * OpenAI, and a local Ollama alike.
 */

const CONFIG = { apiKey: 'test-key', baseUrl: 'https://example.test/v1', model: 'cheap-model' }

type FetchStub = NonNullable<Parameters<typeof createOpenAICompatibleChat>[0]['fetch']>

interface Call {
  url: string
  body: Record<string, unknown>
  headers: Headers
}

/** Records requests and replies with whatever the test queues. */
function stub(responses: Response[]): { fetchStub: FetchStub; calls: Call[] } {
  const calls: Call[] = []
  const queue = [...responses]
  const fetchStub: FetchStub = async (url, init) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      headers: new Headers(init?.headers),
    })
    const next = queue.shift()
    if (!next) throw new Error('stub ran out of responses')
    return next
  }
  return { fetchStub, calls }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Server-sent events, the way a chat completions stream arrives. */
function sse(chunks: string[]): Response {
  const events = chunks
    .map(
      (text) =>
        `data: ${JSON.stringify({ choices: [{ delta: { content: text }, index: 0 }] })}\n\n`,
    )
    .join('')
  return new Response(`${events}data: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function completion(content: string): unknown {
  return { choices: [{ message: { content }, finish_reason: 'stop', index: 0 }] }
}

/** Run a stream to completion for its side effect — used to assert on errors. */
async function drain(stream: AsyncIterable<{ text: string }>): Promise<void> {
  for await (const _delta of stream) void _delta
}

describe('chat', () => {
  it('streams deltas and sends the system prompt as the first message', async () => {
    const { fetchStub, calls } = stub([sse(['Section 3 ', 'argues that ', 'attention scales.'])])
    const provider = createOpenAICompatibleChat({ ...CONFIG, fetch: fetchStub })

    const chunks: string[] = []
    for await (const delta of provider.chat({
      system: 'the document',
      messages: [{ role: 'user', content: 'What does section 3 argue?' }],
    })) {
      chunks.push(delta.text)
    }

    expect(chunks).toEqual(['Section 3 ', 'argues that ', 'attention scales.'])
    expect(calls[0].url).toBe('https://example.test/v1/chat/completions')
    expect(calls[0].headers.get('authorization')).toBe('Bearer test-key')
    expect(calls[0].body).toMatchObject({
      model: 'cheap-model',
      stream: true,
      messages: [
        { role: 'system', content: 'the document' },
        { role: 'user', content: 'What does section 3 argue?' },
      ],
    })
  })

  it('names the endpoint and the fix when the key is rejected', async () => {
    const { fetchStub } = stub([json({ error: { message: 'bad key' } }, 401)])
    const provider = createOpenAICompatibleChat({ ...CONFIG, fetch: fetchStub })

    await expect(
      drain(provider.chat({ messages: [{ role: 'user', content: 'q' }] })),
    ).rejects.toThrow(/example\.test rejected the API key/)
  })

  it('says which model id was wrong on a 404 — the common cost of switching endpoints', async () => {
    const { fetchStub } = stub([json({ error: { message: 'no such model' } }, 404)])
    const provider = createOpenAICompatibleChat({ ...CONFIG, fetch: fetchStub })

    await expect(
      drain(provider.chat({ messages: [{ role: 'user', content: 'q' }] })),
    ).rejects.toThrow(/does not serve "cheap-model"/)
  })
})

describe('structured', () => {
  const schema = z.object({ concepts: z.array(z.object({ canonicalText: z.string() })) })

  it('asks for a schema-checked response and validates what comes back', async () => {
    const { fetchStub, calls } = stub([
      json(completion(JSON.stringify({ concepts: [{ canonicalText: 'self-attention' }] }))),
    ])
    const provider = createOpenAICompatibleChat({ ...CONFIG, fetch: fetchStub })

    const result = await provider.structured({ prompt: 'extract', schema, schemaName: 'concepts' })

    expect(result.concepts[0].canonicalText).toBe('self-attention')
    expect(calls[0].body.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'concepts',
        strict: true,
        // `$schema` is stripped — strict mode rejects unknown top-level keys.
        schema: {
          type: 'object',
          properties: {
            concepts: {
              type: 'array',
              items: {
                type: 'object',
                properties: { canonicalText: { type: 'string' } },
                required: ['canonicalText'],
                additionalProperties: false,
              },
            },
          },
          required: ['concepts'],
          additionalProperties: false,
        },
      },
    })
  })

  it('falls back to plain JSON mode on an endpoint that cannot enforce a schema', async () => {
    const { fetchStub, calls } = stub([
      json({ error: { message: 'response_format json_schema is not supported' } }, 400),
      json(completion(JSON.stringify({ concepts: [{ canonicalText: 'recurrence' }] }))),
    ])
    const provider = createOpenAICompatibleChat({ ...CONFIG, fetch: fetchStub })

    const result = await provider.structured({ prompt: 'extract', schema, schemaName: 'concepts' })

    expect(result.concepts[0].canonicalText).toBe('recurrence')
    expect(calls[1].body.response_format).toEqual({ type: 'json_object' })
    // The schema still reaches the model, just as a prompt rather than a contract.
    const messages = calls[1].body.messages as { content: string }[]
    expect(messages.at(-1)!.content).toContain('canonicalText')
  })

  it('rejects a response that does not match the schema, whatever the endpoint claimed', async () => {
    const { fetchStub } = stub([json(completion(JSON.stringify({ concepts: [{ wrong: 1 }] })))])
    const provider = createOpenAICompatibleChat({ ...CONFIG, fetch: fetchStub })

    await expect(
      provider.structured({ prompt: 'extract', schema, schemaName: 'concepts' }),
    ).rejects.toThrow()
  })
})

describe('embeddings', () => {
  it('returns one Float32Array per input, in input order', async () => {
    const { fetchStub, calls } = stub([
      json({
        data: [
          { index: 1, embedding: [0.3, 0.4] },
          { index: 0, embedding: [0.1, 0.2] },
        ],
      }),
    ])
    const provider = createOpenAICompatibleEmbeddings({
      ...CONFIG,
      model: 'embed-model',
      fetch: fetchStub,
    })

    const vectors = await provider.embed(['first', 'second'])

    expect(vectors[0]).toEqual(Float32Array.from([0.1, 0.2]))
    expect(vectors[1]).toEqual(Float32Array.from([0.3, 0.4]))
    expect(calls[0].url).toBe('https://example.test/v1/embeddings')
    // `encoding_format` must be explicit: the SDK otherwise asks for base64,
    // which many compatible servers don't implement — and the failure mode is
    // silently empty vectors rather than an error.
    expect(calls[0].body).toMatchObject({
      model: 'embed-model',
      input: ['first', 'second'],
      encoding_format: 'float',
    })
  })

  it('does not call the endpoint for an empty batch', async () => {
    const { fetchStub, calls } = stub([])
    const provider = createOpenAICompatibleEmbeddings({ ...CONFIG, fetch: fetchStub })

    expect(await provider.embed([])).toEqual([])
    expect(calls).toHaveLength(0)
  })
})
