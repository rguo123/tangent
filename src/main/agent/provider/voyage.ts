/**
 * Voyage AI embeddings — the other half of the default provider.
 *
 * One endpoint, one response shape, so this is a typed `fetch` rather than the
 * `voyageai` SDK: no extra dependency to keep ABI-compatible with Electron, and
 * nothing here leaks past `LLMProvider.embed` anyway. Swapping in OpenAI's
 * `text-embedding-3-small` is a sibling file, not a change upstream.
 */

const ENDPOINT = 'https://api.voyageai.com/v1/embeddings'

interface EmbeddingsResponse {
  data: { index: number; embedding: number[] }[]
}

export interface VoyageConfig {
  apiKey: string
  model: string
}

export function createVoyageEmbeddings({ apiKey, model }: VoyageConfig) {
  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return []

      let response: Response
      try {
        response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          // 'document' is right for concept text: these vectors are compared
          // against each other, not against a short search query.
          body: JSON.stringify({ model, input: texts, input_type: 'document' }),
        })
      } catch (err) {
        throw new Error(`Could not reach Voyage AI: ${err instanceof Error ? err.message : err}`)
      }

      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 300)
        throw new Error(`Voyage AI error ${response.status}: ${detail || response.statusText}`)
      }

      const body = (await response.json()) as EmbeddingsResponse
      if (!Array.isArray(body.data) || body.data.length !== texts.length) {
        throw new Error('Voyage AI returned an unexpected number of embeddings.')
      }
      // The API documents index-ordered results; sort anyway so a reordered
      // response can never silently mis-pair a vector with its text.
      return [...body.data]
        .sort((a, b) => a.index - b.index)
        .map((d) => Float32Array.from(d.embedding))
    },
  }
}
