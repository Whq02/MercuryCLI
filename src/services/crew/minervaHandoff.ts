
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
  conversationId: CrewConversationId
  originalText: string
  refinedText: string
  provenance: { source: string; noteRef?: string; refinedBy: string }
  targetAgentId?: CrewAgentId
  state: StagedDraftState
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
  parentConversationId?: CrewConversationId
  dir?: string
}

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
    })
    await appendConversationEvent(conversationId, { kind: 'completion', label: 'dispatched' }, opts).catch(
      () => {},
    )
  }
  return updated
}

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
    await appendConversationEvent(conversationId, { kind: 'completion', label: 'dismissed' }, opts).catch(
      () => {},
    )
  }
  return dismissed
}
