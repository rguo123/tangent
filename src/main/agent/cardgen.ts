import { z } from 'zod'
import type { Concept } from '@shared/entities'
import type { Storage } from '../db/init'
import { blockquote, truncate } from '../util'
import type { LLMProvider } from './provider'

/**
 * Card generation (spec §5.2): one recall card per concept the reader just
 * added, born as a draft.
 *
 * The input is the concept *and what it came from* — the notes, questions,
 * pinned answers and highlights its mentions point at. A card written from the
 * canonical text alone would be a card about a phrase; a card written from the
 * provenance is a card about the thing the reader was actually working out.
 *
 * Only *new* concepts reach here (spec §2). A concept that already existed and
 * merely gained a mention has its card already, and rewriting it on every
 * re-read is how a card the reader accepted quietly stops being the card they
 * accepted.
 *
 * This module proposes; nothing here writes a row.
 */

/** One run covers the concepts from one extraction, which is a burst of
 *  note-taking rather than a corpus. */
const MAX_CONCEPTS_PER_RUN = 12
const MAX_SOURCES_PER_CONCEPT = 3
const MAX_SOURCE_CHARS = 600
const MAX_FRONT_CHARS = 300
const MAX_BACK_CHARS = 800

const SYSTEM_PROMPT = [
  'You write spaced-repetition flashcards from concepts a reader has just engaged with, and from the notes and passages each concept came from.',
  '',
  'Rules:',
  '- One card per concept, and at most one. Skip a concept rather than padding: a concept too vague to test is a concept with no card.',
  '- Recall cards only: the front asks one question with one answer, the back answers it.',
  '- The front must stand alone. Someone reading it a month from now has no document in front of them, so never write "this passage", "the author", or "the paper" — name the thing.',
  '- The back must be answerable from the sources given. Never add facts they do not contain, and never hedge — write the answer, not a description of where to find it.',
  '- Keep the back to a sentence or two. One fact per card; if a concept holds two, test the one the sources actually engage with.',
  '- conceptRef: the id of the concept the card is for, copied exactly.',
].join('\n')

const ProposalSchema = z.object({
  cards: z.array(
    z.object({
      conceptRef: z.string(),
      front: z.string(),
      back: z.string(),
    }),
  ),
})

/** One card as the model proposes it — derived from the schema, so the offline
 *  fallback and the resolver can't drift from what's actually parsed. */
type ProposedCard = z.infer<typeof ProposalSchema>['cards'][number]

/** A card to write, resolved back to the concept it belongs to. */
export interface CardDraft {
  conceptId: string
  front: string
  back: string
}

/** A concept as the model sees it: the phrase, plus the engagement behind it. */
interface CardgenInput {
  ref: string
  conceptId: string
  canonicalText: string
  sources: string[]
}

/**
 * Draft cards for the concepts a batch just created.
 *
 * Returns an empty list rather than throwing when there's nothing to write —
 * an extraction that only added mentions is the common case, and it costs one
 * early return, not a model call.
 */
export async function planCards(
  storage: Storage,
  provider: LLMProvider,
  conceptIds: string[],
): Promise<CardDraft[]> {
  const inputs = collectInputs(storage, conceptIds)
  if (inputs.length === 0) return []

  const proposal = await provider.structured({
    system: SYSTEM_PROMPT,
    prompt: renderInputs(inputs),
    schema: ProposalSchema,
    schemaName: 'flashcard_drafts',
    // Background work behind a cull pass — the reader is the quality gate.
    effort: 'low',
    offlineFallback: () => ({ cards: inputs.map(offlineCard) }),
  })

  return resolveDrafts(proposal.cards, inputs)
}

/**
 * Concept plus provenance. A concept whose sources have all been deleted still
 * gets a card from its canonical text — thin, but the reader keeping or
 * discarding it is cheaper than silently dropping a concept they just made.
 */
function collectInputs(storage: Storage, conceptIds: string[]): CardgenInput[] {
  const { concepts } = storage.repos
  const inputs: CardgenInput[] = []

  for (const conceptId of conceptIds.slice(0, MAX_CONCEPTS_PER_RUN)) {
    const concept = concepts.getById(conceptId)
    if (!concept) continue
    inputs.push({
      ref: `c${inputs.length + 1}`,
      conceptId,
      canonicalText: concept.canonicalText,
      sources: sourceTextsFor(storage, concept),
    })
  }

  return inputs
}

/** What the reader wrote or highlighted, for every mention of the concept. An
 *  anchored note contributes both its passage and the sentence about it. */
function sourceTextsFor(storage: Storage, concept: Concept): string[] {
  const { concepts, entries, anchors } = storage.repos
  const texts: string[] = []

  for (const mention of concepts.mentionsFor(concept.id)) {
    if (texts.length >= MAX_SOURCES_PER_CONCEPT) break
    const anchor = mention.anchorId ? anchors.getById(mention.anchorId) : null
    const entry = mention.entryId ? entries.getById(mention.entryId) : null
    const parts = [anchor && blockquote(anchor.selector.exact), entry?.body.trim()].filter(Boolean)
    if (parts.length > 0) texts.push(truncate(parts.join('\n'), MAX_SOURCE_CHARS))
  }

  return texts
}

function renderInputs(inputs: CardgenInput[]): string {
  const blocks = inputs.map((input) => {
    const lines = [`## ${input.ref} — ${input.canonicalText}`]
    if (input.sources.length === 0) lines.push('(no sources — write from the concept alone)')
    else lines.push(...input.sources.map((text, i) => `Source ${i + 1}:\n${text}`))
    return lines.join('\n\n')
  })
  return ['Concepts:', '', blocks.join('\n\n')].join('\n')
}

/**
 * Offline dev's stand-in for a model: the concept as a prompt, its first source
 * as the answer. Not a good card — but a real one, attached to a real concept,
 * which is what the cull pass and the review queue need to be exercisable with
 * no model at all.
 */
function offlineCard(input: CardgenInput): ProposedCard {
  return {
    conceptRef: input.ref,
    front: `What did you take away about ${input.canonicalText}?`,
    back: truncate(input.sources[0] ?? input.canonicalText, 300, '…'),
  }
}

/**
 * Keep the cards whose concept we actually asked about, one per concept.
 *
 * A card citing an invented ref has nothing to attach to — `flashcard_concept`
 * is what re-points a card when its concept is later merged, so a card with no
 * real concept is a card that falls out of every later mechanism.
 */
function resolveDrafts(proposed: ProposedCard[], inputs: CardgenInput[]): CardDraft[] {
  const byRef = new Map(inputs.map((i) => [i.ref, i]))
  const used = new Set<string>()
  const drafts: CardDraft[] = []

  for (const card of proposed) {
    const input = byRef.get(card.conceptRef)
    const front = truncate(card.front.trim(), MAX_FRONT_CHARS, '…')
    const back = truncate(card.back.trim(), MAX_BACK_CHARS, '…')
    if (!input) {
      console.warn(`Dropping card for unknown concept ref "${card.conceptRef}": ${front}`)
      continue
    }
    // A blank side is not a card, and a second card for one concept is the
    // model ignoring the one-per-concept rule rather than finding a second idea.
    if (!front || !back || used.has(input.conceptId)) continue
    used.add(input.conceptId)
    drafts.push({ conceptId: input.conceptId, front, back })
  }

  return drafts
}
