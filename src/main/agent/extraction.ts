import { z } from 'zod'
import type { Entry } from '@shared/entities'
import type { ExtractionPlan, ExtractionSource, PlannedConcept } from '../db/extraction'
import type { Storage } from '../db/init'
import { truncate } from '../util'
import type { LLMProvider } from './provider'

/**
 * Concept extraction (spec §5.1): read the user's *engagement*, not the
 * document.
 *
 * The document is not an input here, and that is the whole design. A paper has
 * hundreds of concepts in it; the four the reader wrote a note about are the
 * ones worth remembering. So the inputs are notes, questions, pinned answers,
 * and highlighted passages — the things the reader chose — and nothing else.
 *
 * This module proposes; `commitExtraction` (src/main/db/extraction.ts) writes.
 * Everything below returns a plan and touches no rows.
 */

/**
 * Cosine above which a candidate is the *same* concept as one already in the
 * Field, and gains a mention instead of a row. One constant, one place — the
 * spec's starting point is 0.85, to be tuned against real data (Phase 7).
 */
export const DEDUP_THRESHOLD = 0.85

/** A run reads one thread's unextracted engagement, so these bound a burst of
 *  note-taking, not a corpus. */
const MAX_INPUTS = 40
const MAX_INPUT_CHARS = 2_000
const MAX_CONCEPTS_PER_RUN = 12

const SYSTEM_PROMPT = [
  'You extract the concepts a reader is actively engaging with, from their own notes, questions, pinned answers, and highlighted passages.',
  'A concept is one idea they are grappling with: a term, a claim, a mechanism, a distinction.',
  '',
  'Rules:',
  '- Only propose what the inputs themselves engage with. Never add background knowledge, and never cover parts of the source they did not touch.',
  '- canonicalText: a short, self-contained noun phrase or claim, under 100 characters, phrased the way it would read in any note — not as a reference to "this passage".',
  '- One concept per idea. Fold restatements of the same idea into a single concept that cites every input it came from.',
  '- sourceRefs: the ids of the inputs the concept came from, copied exactly.',
  '- If the inputs are too thin to carry an idea, return an empty list. That is a valid answer.',
].join('\n')

const ProposalSchema = z.object({
  concepts: z.array(
    z.object({
      canonicalText: z.string(),
      sourceRefs: z.array(z.string()),
    }),
  ),
})

const INPUT_LABEL = {
  note: 'note',
  question: 'question',
  answer: 'pinned answer',
  highlight: 'highlighted passage',
} as const

/** One piece of engagement, as the model sees it. `ref` is what it cites. */
export interface ExtractionInput {
  ref: string
  kind: keyof typeof INPUT_LABEL
  /** The anchored passage, when there is one. */
  quote: string | null
  /** What the user wrote. Empty for a bare highlight. */
  body: string
  source: ExtractionSource
}

/**
 * The engaged material due for extraction in one thread.
 *
 * Two filters, both load-bearing. Unpinned AI responses are excluded: the model
 * talking is not the user learning, and pinning is the gesture that says
 * otherwise. And entries that *are* excluded are never stamped by the caller,
 * so pinning an old answer still brings it in later — which matters because
 * pinning doesn't bump `updated_at`.
 */
export function collectInputs(storage: Storage, threadId: string): ExtractionInput[] {
  const { entries, anchors } = storage.repos
  const inputs: ExtractionInput[] = []

  for (const entry of entries.dueForExtraction(threadId)) {
    if (!isEngaged(entry)) continue
    const anchor = entry.anchorId ? anchors.getById(entry.anchorId) : null
    inputs.push({
      ref: `i${inputs.length + 1}`,
      kind: entry.kind === 'ai_response' ? 'answer' : entry.kind,
      quote: anchor ? anchor.selector.exact : null,
      body: truncate(entry.body, MAX_INPUT_CHARS),
      // An anchored note is one act of engagement with two handles on it; the
      // mention records both so a concept traces back to the passage as well
      // as the sentence about it.
      source: { entryId: entry.id, anchorId: anchor?.id ?? null },
    })
  }

  for (const anchor of anchors.dueForExtraction(threadId)) {
    inputs.push({
      ref: `i${inputs.length + 1}`,
      kind: 'highlight',
      quote: truncate(anchor.selector.exact, MAX_INPUT_CHARS),
      body: '',
      source: { entryId: null, anchorId: anchor.id },
    })
  }

  // Oldest first is how they were written; if there are more than a run should
  // carry, the recent ones are the ones still being thought about.
  return inputs.length <= MAX_INPUTS ? inputs : inputs.slice(-MAX_INPUTS)
}

function isEngaged(entry: Entry): boolean {
  if (!entry.body.trim() && entry.kind !== 'ai_response') return false
  if (entry.kind !== 'ai_response') return true
  return entry.pinned && entry.body.trim() !== ''
}

/**
 * Propose concepts for one thread and resolve each against the Field.
 *
 * Returns null when there is nothing to do — no engaged material, or a model
 * that proposed nothing. Both are ordinary: this runs on a timer, and most
 * firings should cost one query and stop.
 */
export async function planExtraction(
  storage: Storage,
  provider: LLMProvider,
  threadId: string,
): Promise<ExtractionPlan | null> {
  const thread = storage.repos.threads.getById(threadId)
  if (!thread) throw new Error(`No such thread: ${threadId}`)

  const inputs = collectInputs(storage, threadId)
  if (inputs.length === 0) return null

  const proposal = await provider.structured({
    system: SYSTEM_PROMPT,
    prompt: renderInputs(inputs),
    schema: ProposalSchema,
    schemaName: 'extracted_concepts',
    // Background work behind a draft-and-cull safety net — it runs cheap.
    effort: 'low',
    offlineFallback: () => ({ concepts: inputs.map(offlineConcept) }),
  })

  const candidates = resolveCandidates(proposal.concepts, inputs)
  if (candidates.length === 0) return null

  return {
    threadId,
    fieldId: thread.fieldId,
    embeddingModel: provider.embeddingModel,
    concepts: await dedupe(storage, provider, thread.fieldId, candidates),
    consumed: {
      entryIds: unique(inputs.map((i) => i.source.entryId)),
      // Only unnoted highlights reach here as their own input; an anchored note
      // is stamped through its entry, so its anchor must not be stamped too.
      anchorIds: unique(inputs.filter((i) => i.kind === 'highlight').map((i) => i.source.anchorId)),
    },
  }
}

function unique(ids: (string | null)[]): string[] {
  return [...new Set(ids.filter((id): id is string => id !== null))]
}

/**
 * Offline dev's stand-in for a model: one concept per input, clipped to a
 * phrase. Not extraction — but it is grounded in real inputs, which is enough
 * for dedup, the chip, and undo to behave the way they will against a live
 * model.
 */
function offlineConcept(input: ExtractionInput): { canonicalText: string; sourceRefs: string[] } {
  // First sentence, not the first 100 characters: a phrase is what a real
  // proposal looks like, and it's what lets two notes about the same thing land
  // close enough for the dedup path to actually fire offline.
  const [sentence] = (input.body || input.quote || '').trim().split(/(?<=[.?!])\s/)
  return { canonicalText: truncate(sentence, 100, '') || 'untitled', sourceRefs: [input.ref] }
}

function renderInputs(inputs: ExtractionInput[]): string {
  const blocks = inputs.map((input) => {
    const lines = [`## ${input.ref} — ${INPUT_LABEL[input.kind]}`]
    if (input.quote) lines.push(`> ${input.quote.replace(/\n/g, '\n> ')}`)
    if (input.body) lines.push(input.body)
    return lines.join('\n')
  })
  return ['Inputs:', '', blocks.join('\n\n')].join('\n')
}

interface Candidate {
  canonicalText: string
  sources: ExtractionSource[]
}

/**
 * Turn the model's answer into candidates whose provenance is real: every
 * source is an input we actually sent. A concept whose refs are all invented
 * is dropped rather than pinned to an arbitrary entry — a mention that lies
 * about where a concept came from is worse than a concept we didn't keep.
 */
function resolveCandidates(
  proposed: { canonicalText: string; sourceRefs: string[] }[],
  inputs: ExtractionInput[],
): Candidate[] {
  const byRef = new Map(inputs.map((i) => [i.ref, i]))
  const candidates: Candidate[] = []

  for (const concept of proposed.slice(0, MAX_CONCEPTS_PER_RUN)) {
    const canonicalText = concept.canonicalText.trim()
    if (!canonicalText) continue
    const sources = [...new Set(concept.sourceRefs)]
      .map((ref) => byRef.get(ref)?.source)
      .filter((source): source is ExtractionSource => source !== undefined)
    if (sources.length === 0) {
      console.warn(`Dropping concept with no traceable source: ${canonicalText}`)
      continue
    }
    candidates.push({ canonicalText, sources })
  }

  return candidates
}

/**
 * Resolve candidates against the Field: fold near-duplicates within the batch
 * together, then match what survives against existing concepts.
 *
 * Brute-force cosine over every active concept, per the spec — at a Field's
 * scale that's a few thousand dot products over 1k-dimension vectors, which is
 * sub-10ms and needs no vector extension.
 */
async function dedupe(
  storage: Storage,
  provider: LLMProvider,
  fieldId: string,
  candidates: Candidate[],
): Promise<PlannedConcept[]> {
  const vectors = await provider.embed(candidates.map((c) => c.canonicalText))
  if (vectors.length !== candidates.length) {
    throw new Error(`Expected ${candidates.length} embeddings, got ${vectors.length}.`)
  }

  // Vectors from a different model aren't comparable to these, so a model
  // switch degrades to "everything looks new" rather than to nonsense matches.
  // flatMap rather than filter: it narrows away the nullable embedding, which a
  // predicate can't.
  const existing = storage.repos.concepts
    .listActiveByField(fieldId)
    .flatMap((c) =>
      c.embedding && c.embeddingModel === provider.embeddingModel
        ? [{ id: c.id, embedding: c.embedding }]
        : [],
    )

  const planned: PlannedConcept[] = []
  for (const [index, candidate] of candidates.entries()) {
    const embedding = vectors[index]

    const twin = planned.find((p) => cosine(p.embedding, embedding) >= DEDUP_THRESHOLD)
    if (twin) {
      twin.sources.push(...candidate.sources)
      continue
    }

    planned.push({
      existingConceptId: bestMatchId(existing, embedding),
      canonicalText: candidate.canonicalText,
      embedding,
      sources: [...candidate.sources],
    })
  }
  return planned
}

function bestMatchId(
  concepts: { id: string; embedding: Float32Array }[],
  embedding: Float32Array,
): string | null {
  let best: string | null = null
  let bestScore = DEDUP_THRESHOLD
  for (const concept of concepts) {
    const score = cosine(concept.embedding, embedding)
    if (score >= bestScore) {
      best = concept.id
      bestScore = score
    }
  }
  return best
}

/** Providers return normalized vectors, but not all of them promise to, so
 *  divide by the norms rather than trusting the dot product alone. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / Math.sqrt(normA * normB)
}
