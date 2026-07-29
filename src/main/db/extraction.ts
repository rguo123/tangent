import type { Database } from 'better-sqlite3'
import type { Repos } from './repos'
import { newId, nowIso } from './util'

/**
 * The commit half of extraction (spec §3: the agent proposes, the app commits).
 *
 * Everything upstream of this file — the model call, the embeddings, the
 * dedup — produces a *plan*: a plain description of which concepts to write and
 * what they came from. This file is the only thing that writes it, in one
 * transaction, and the only thing that can take it back.
 *
 * Undo works off what the batch actually did rather than a diff of the DB: the
 * ids it created and the watermark each input carried before it. Nothing else
 * has to be true for the reversal to be exact.
 */

/** Where a concept was engaged. Both are set when a note is anchored — the note
 *  and the passage it's about are one piece of engagement. Mirrors the nullable
 *  columns on `concept_mention` rather than inventing an optional-field shape. */
export interface ExtractionSource {
  entryId: string | null
  anchorId: string | null
}

export interface PlannedConcept {
  /** Set when the candidate deduped onto a concept that already exists; the
   *  concept then gains a mention rather than a twin. */
  existingConceptId: string | null
  canonicalText: string
  embedding: Float32Array
  sources: ExtractionSource[]
}

export interface ExtractionPlan {
  threadId: string
  fieldId: string
  /** One model embedded every candidate in this run, so it belongs to the plan
   *  rather than to each concept — a plan with mixed models is not a state that
   *  can occur. */
  embeddingModel: string
  concepts: PlannedConcept[]
  /**
   * The inputs whose content went into the call, stamped on commit. Only these:
   * an entry filtered out as un-engaged stays due, so pinning an answer later
   * still brings it in. Anchors appear here only as unnoted highlights — an
   * anchored note is stamped through its entry.
   */
  consumed: { entryIds: string[]; anchorIds: string[] }
}

/** What one commit did, in enough detail to reverse it exactly. Held in memory
 *  by the extraction service for as long as the undo chip is offered. */
export interface ExtractionBatch {
  id: string
  threadId: string
  createdConceptIds: string[]
  createdMentionIds: string[]
  /** The draft cards generated from this batch's new concepts, added by a
   *  second commit after the model has written them. They belong to the batch
   *  because the chip's undo has to take them with it — a card outliving the
   *  concept it cites is a row `flashcard_concept` cannot represent. */
  createdFlashcardIds: string[]
  /** The watermark each consumed input carried *before* this batch — `null`
   *  for one extracted here for the first time. */
  priorWatermarks: { kind: 'entry' | 'anchor'; id: string; extractedAt: string | null }[]
}

export function commitExtraction(
  db: Database,
  repos: Repos,
  plan: ExtractionPlan,
): ExtractionBatch {
  const run = db.transaction((): ExtractionBatch => {
    const batch: ExtractionBatch = {
      id: newId(),
      threadId: plan.threadId,
      createdConceptIds: [],
      createdMentionIds: [],
      createdFlashcardIds: [],
      priorWatermarks: [],
    }

    for (const planned of plan.concepts) {
      let conceptId = planned.existingConceptId
      if (!conceptId) {
        const concept = repos.concepts.create({
          fieldId: plan.fieldId,
          canonicalText: planned.canonicalText,
          embedding: planned.embedding,
          embeddingModel: plan.embeddingModel,
        })
        conceptId = concept.id
        batch.createdConceptIds.push(concept.id)
      }

      for (const source of planned.sources) {
        if (repos.concepts.findMention(conceptId, source.entryId, source.anchorId)) continue
        const mention = repos.concepts.addMention({ conceptId, ...source })
        batch.createdMentionIds.push(mention.id)
      }
    }

    stampWatermarks(repos, plan, batch)
    return batch
  })
  return run()
}

function stampWatermarks(repos: Repos, plan: ExtractionPlan, batch: ExtractionBatch): void {
  const at = nowIso()
  const entryIds: string[] = []

  for (const id of plan.consumed.entryIds) {
    const entry = repos.entries.getById(id)
    if (!entry) continue
    batch.priorWatermarks.push({ kind: 'entry', id, extractedAt: entry.extractedAt })
    entryIds.push(id)
  }
  repos.entries.markExtracted(entryIds, at)

  for (const id of plan.consumed.anchorIds) {
    const anchor = repos.anchors.getById(id)
    if (!anchor) continue
    batch.priorWatermarks.push({ kind: 'anchor', id, extractedAt: anchor.extractedAt })
    repos.anchors.setExtractedAt(id, at)
  }
}

/**
 * Write the cards a batch's new concepts produced, and return their ids for the
 * batch to record.
 *
 * Separate from `commitExtraction` because it happens after a second model
 * call: the concepts are on disk (and the watermarks stamped) before card
 * generation is even attempted, so a cardgen failure costs the cards, never the
 * extraction.
 */
export function commitCards(
  db: Database,
  repos: Repos,
  fieldId: string,
  drafts: { conceptId: string; front: string; back: string }[],
): string[] {
  const run = db.transaction(() =>
    drafts.map(
      (draft) =>
        repos.flashcards.create({
          fieldId,
          conceptIds: [draft.conceptId],
          front: draft.front,
          back: draft.back,
          // Recall-type only in the MVP (spec §0); relationship cards need the
          // concept graph a later phase builds.
          cardType: 'recall',
        }).id,
    ),
  )
  return run()
}

/**
 * Reverse a commit: drop what it created and put the watermarks back, so the
 * next run sees exactly the work it saw before. Undone inputs are due again,
 * which is the point — undo means "you read that wrong", not "never look at it
 * again".
 *
 * Refused outright once a card from the batch has been accepted: that card has
 * scheduling state and possibly review history, and there is no version of
 * "undo the extraction" that also leaves it standing, since its concept is
 * going away. Better to say so than to half-reverse.
 */
export function undoExtraction(db: Database, repos: Repos, batch: ExtractionBatch): void {
  // A card the user already discarded is gone and reverses fine; one they kept
  // (accepted, then possibly suspended) is the case this refuses.
  const kept = batch.createdFlashcardIds.some((id) => {
    const lifecycle = repos.flashcards.getById(id)?.lifecycle
    return lifecycle !== undefined && lifecycle !== 'draft'
  })
  if (kept) throw new Error('Those cards are already in review — nothing was undone.')

  const run = db.transaction(() => {
    // Cards before mentions before concepts: each of the three is what the FK
    // on the next one points at.
    for (const id of batch.createdFlashcardIds) repos.flashcards.remove(id)
    for (const id of batch.createdMentionIds) repos.concepts.deleteMention(id)
    for (const id of batch.createdConceptIds) repos.concepts.delete(id)
    for (const { kind, id, extractedAt } of batch.priorWatermarks) {
      if (kind === 'entry') repos.entries.setExtractedAt(id, extractedAt)
      else repos.anchors.setExtractedAt(id, extractedAt)
    }
  })
  run()
}
