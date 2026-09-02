// ============================================================================
//  crew/minervaHandoff — Minerva's staged refined-draft handoff
//
//
//  Minerva refines; the OPERATOR dispatches. This owner is the staging area
//  between those two facts:
//    · a refinement STAGES — original and refined text side by side, with
//      note/refinement provenance; refinement completion alone never
//      dispatches anything and never marks the source note complete;
//    · each staged draft mints its OWN minerva-refinement conversation
//      (parent lineage to the thread it refines for) — a new id, never the
//      main id;
//    · the operator's explicit disposition (hold-next / start-turn / …) rides
//      the ONE dispatch transaction elsewhere; THIS owner only records the
//      exact receipt ref against the staged draft afterwards;
//    · dismissing a staged draft dismisses the DRAFT — the source note and
//      the main agent are untouched by construction.
//
//  Storage: one bounded per-project store (the crew substrate discipline —
//  fileStore atomic publish/locking; proof isolation via the dir seam).
// ============================================================================

import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { defineStore } from '../../substrate/fileStore.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { getCwd } from '../../utils/cwd.js'
import {
  appendConversationEvent,
  mintConversation,
  MAIN_CONVERSATION_ID,
  type CrewConversationId,
} from './conversations.js'
import { crewStoreRoot, type CrewAgentId } from './identity.js'

export type StagedDraftId = string & { readonly __brand: 'StagedDraftId' }

export const STAGED_DRAFT_STATES = ['staged', 'dispatched', 'dismissed'] as const
export type StagedDraftState = (typeof STAGED_DRAFT_STATES)[number]

export interface StagedRefinedDraftV1 {
  schema: 1
  stagedId: StagedDraftId
  /** The refinement's own conversation (minerva-refinement kind, parented). */
  conversationId: CrewConversationId
  /** BOTH texts — the side-by-side law (the UI shows original vs refined
   *  before any dispatch; neither is ever silently substituted). */
  originalText: string
  refinedText: string
  /** Provenance: where the original came from (tabula note ref, operator
   *  draft) and what refined it. */
  provenance: { source: string; noteRef?: string; refinedBy: string }
  /** The operator's chosen destination — presentation state, re-chosen at
   *  dispatch time; never auto-resolved. */
  targetAgentId?: CrewAgentId
  state: StagedDraftState
  /** The exact delivery receipt (clientMessageId) once dispatched. */
  deliveryReceiptRef?: string
  stagedAt: number
  updatedAt: number
}

interface StagedDraftFile {
  drafts: Record<string, StagedRefinedDraftV1>
}

const MAX_STAGED = 100

function projectKey(): string {
  return createHash('sha256').update(getCwd()).digest('hex').slice(0, 16)
}

const stagedStore = defineStore<StagedDraftFile, [dir?: string]>({
  name: 'crew-minerva-staged',
  path: (dir?: string) =>
    join(crewStoreRoot(dir), `minerva-staged-${projectKey()}.json`),
  schemaVersion: 1,
  decode: raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const r = raw as { drafts?: unknown }
    const out: StagedDraftFile = { drafts: {} }
    if (r.drafts && typeof r.drafts === 'object' && !Array.isArray(r.drafts)) {
      for (const [id, d] of Object.entries(r.drafts)) {
        if (d && typeof d === 'object' && typeof (d as StagedRefinedDraftV1).refinedText === 'string') {
          out.drafts[id] = d as StagedRefinedDraftV1
        }
      }
    }
    return out
  },
  empty: () => ({ drafts: {} }),
  onReadFailure: 'empty',
})

export interface StageRefinedDraftArgs {
  originalText: string
  refinedText: string
  provenance: { source: string; noteRef?: string; refinedBy: string }
  targetAgentId?: CrewAgentId
  /** The thread the refinement serves (default: the main thread). */
  parentConversationId?: CrewConversationId
  dir?: string
}

/** Stage a refinement: mint its conversation (NEW id, parent lineage) and
 *  persist both texts. Nothing is dispatched; nothing is marked complete. */
export async function stageRefinedDraft(args: StageRefinedDraftArgs): Promise<StagedRefinedDraftV1> {
  const conversation = await mintConversation({
    kind: 'minerva-refinement',
    title: args.refinedText.slice(0, 60) || 'refined draft',
    participants: [],
    parentConversationId: args.parentConversationId ?? MAIN_CONVERSATION_ID,
    ...(args.dir !== undefined ? { dir: args.dir } : {}),
  })
  const now = Date.now()
  const draft: StagedRefinedDraftV1 = {
    schema: 1,
    stagedId: `sd-${randomUUID().replace(/-/g, '').slice(0, 12)}` as StagedDraftId,
    conversationId: conversation.conversationId,
    originalText: args.originalText,
    refinedText: args.refinedText,
    provenance: args.provenance,
    ...(args.targetAgentId !== undefined ? { targetAgentId: args.targetAgentId } : {}),
    state: 'staged',
    stagedAt: now,
    updatedAt: now,
  }
  await stagedStore(args.dir).mutate(current => {
    let drafts = { ...current.drafts, [draft.stagedId]: draft }
    const ids = Object.keys(drafts)
    if (ids.length > MAX_STAGED) {
      // Evict SETTLED drafts first (dispatched/dismissed, oldest first); a
      // staged draft the operator has not decided on drops only last.
      const byAge = Object.values(drafts).sort((a, b) => a.stagedAt - b.stagedAt)
      let toDrop = byAge.length - MAX_STAGED
      const dropSet = new Set<StagedRefinedDraftV1>()
      for (const d of byAge) {
        if (toDrop === 0) break
        if (d.state !== 'staged') {
          dropSet.add(d)
          toDrop--
        }
      }
      for (const d of byAge) {
        if (toDrop === 0) break
        if (d.stagedId !== draft.stagedId && !dropSet.has(d)) {
          dropSet.add(d)
          toDrop--
        }
      }
      drafts = {}
      for (const d of byAge) {
        if (!dropSet.has(d)) drafts[d.stagedId] = d
      }
      drafts[draft.stagedId] = draft
    }
    return { drafts }
  })
  await appendConversationEvent(
    conversation.conversationId,
    {
      kind: 'activity',
      label: `refined from ${args.provenance.source}${args.provenance.noteRef ? ` (${args.provenance.noteRef})` : ''}`,
    },
    args.dir !== undefined ? { dir: args.dir } : undefined,
  )
  return draft
}

/** BOTH texts + provenance for one staged draft (the side-by-side law). */
export async function stagedDraftOf(
  stagedId: string,
  opts?: { dir?: string },
): Promise<StagedRefinedDraftV1 | null> {
  const file = await stagedStore(opts?.dir).read()
  return file.drafts[stagedId] ?? null
}

export async function listStagedDrafts(opts?: { dir?: string }): Promise<StagedRefinedDraftV1[]> {
  const file = await stagedStore(opts?.dir).read()
  return Object.values(file.drafts).sort((a, b) => b.stagedAt - a.stagedAt)
}

/** Record the exact delivery receipt against a staged draft AFTER the
 *  operator's explicit dispatch settled positively. The refinement
 *  conversation gains the delivery event; the source note stays whatever it
 *  was (completion is never inferred from dispatch). */
export async function markStagedDispatched(
  stagedId: string,
  deliveryReceiptRef: string,
  opts?: { dir?: string },
): Promise<boolean> {
  let conversationId: CrewConversationId | null = null
  const updated = await stagedStore(opts?.dir).update<boolean>(current => {
    const d = current.drafts[stagedId]
    if (!d || d.state !== 'staged') return { next: current, result: false }
    conversationId = d.conversationId
    return {
      next: {
        drafts: {
          ...current.drafts,
          [stagedId]: { ...d, state: 'dispatched', deliveryReceiptRef, updatedAt: Date.now() },
        },
      },
      result: true,
    }
  })
  if (updated && conversationId) {
    await appendConversationEvent(
      conversationId,
      { kind: 'delivery', ref: `receipt:${deliveryReceiptRef}`, label: 'dispatched by the operator' },
      opts,
    ).catch(() => {
      // the receipt store is the delivery truth
    })
    // The refinement thread's work is DONE (the console analog's law:
    // recordSideOutcome completes its thread) — without this the cv- row
    // read 'working' forever after its dispatch (final audit).
    await appendConversationEvent(conversationId, { kind: 'completion', label: 'dispatched' }, opts).catch(
      () => {},
    )
  }
  return updated
}

/** Dismiss the DRAFT — the source note and every agent stay untouched. */
export async function dismissStagedDraft(
  stagedId: string,
  opts?: { dir?: string },
): Promise<boolean> {
  let conversationId: CrewConversationId | null = null
  const dismissed = await stagedStore(opts?.dir).update<boolean>(current => {
    const d = current.drafts[stagedId]
    if (!d || d.state !== 'staged') return { next: current, result: false }
    conversationId = d.conversationId
    return {
      next: {
        drafts: { ...current.drafts, [stagedId]: { ...d, state: 'dismissed', updatedAt: Date.now() } },
      },
      result: true,
    }
  })
  if (dismissed && conversationId) {
    // Same completion law as the dispatch path — a dismissed refinement
    // thread settles instead of reading 'working' until cap eviction.
    await appendConversationEvent(conversationId, { kind: 'completion', label: 'dismissed' }, opts).catch(
      () => {},
    )
  }
  return dismissed
}
