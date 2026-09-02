// ============================================================================
//  services/concourse/coordinatorConversation — the G wave's DURABLE
//  coordinator conversation ("make Coordinator a persistent
//  conversational surface"). ONE bounded store under the config home: the
//  operator's messages and the coordinator's replies (with the kernel
//  receipts a reply executed) survive routing, restart and model switches —
//  the conversation is the surface's memory, not a per-mount scrollback.
//
//  Bounded by design (CONVERSATION_CAP newest entries survive a write);
//  readers are lock-free (fileStore atomic publish); the UI subscribes for
//  repaints exactly like the concourse draft store.
// ============================================================================

import { join } from 'node:path'
import { defineStore } from '../../substrate/fileStore.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { decodeManagerAsk, decodeManagerPlan, type ManagerAskV1, type ManagerPlanV1 } from './managerMode.js'

export interface CoordinatorConversationReceiptV1 {
  verb: string
  outcome: string
  /** Human line for the transcript row ('paused Fix OAuth callback', …). */
  label: string
}

export interface CoordinatorConversationEntryV1 {
  id: string
  role: 'operator' | 'coordinator'
  text: string
  ts: number
  /** Kernel receipts a coordinator reply EXECUTED (operator parity: the
   *  conversation shows what actually happened, not just prose). */
  receipts?: CoordinatorConversationReceiptV1[]
  /** THE HARNESS VOICE: this row is Mercury reporting on the lane — a
   *  refusal, a turn that did not run, the off hint — and NOT the
   *  coordinator's own words. Stored on the entry so every reader of the
   *  conversation (the pane, the next turn's replay) speaks it as the
   *  harness: a notice the model never said can never come back as
   *  something it did say. */
  harness?: true
  /** THE COMPACT SUMMARY ROW (chat-relief): this harness-voiced entry IS a
   *  compaction boundary — its text carries the fold sentence plus the
   *  summary that replaced the folded turns. The replay lets it ride WHOLE
   *  (its own cap, not the per-row clip): a clipped summary would amputate
   *  exactly the memory the fold exists to preserve. */
  summary?: true
  /** MANAGER MODE (ledger T7+T8): the interview question card this reply
   *  landed — the UI shape of the model's own question (options 1–4; the
   *  card adds 5, the custom input). Present only on manager-mode replies. */
  ask?: ManagerAskV1
  /** MANAGER MODE: the plan card — the lane split as draft contracts with
   *  their territories (the harmony fences), plus its consent state. */
  plan?: ManagerPlanV1
}

/** THE CONTEXT GAUGE (chat-relief): the LAST assisted turn's real context
 *  size, in the provider's own usage words — input + cache-read +
 *  cache-creation tokens of the largest round, stamped beside the model the
 *  turn ran on. ONE writer (the assisted-turn road, after each model turn);
 *  readers derive — the pane's warning line and the door's auto-compact
 *  decision both read THIS fact, never a parallel estimate (the
 *  gauge-reads-a-different-source class). Cleared by /clear and by every
 *  compaction: accurate counts are unavailable until the next turn answers,
 *  exactly the main chat's post-compaction warning suppression. */
export interface CoordinatorContextGaugeV1 {
  /** input_tokens + cache_read_input_tokens + cache_creation_input_tokens
   *  of the turn's largest round — the canonical disjoint usage envelope
   *  every provider runtime normalizes to. */
  contextTokens: number
  /** The model the turn ran on (its window prices the thresholds). */
  modelId: string
  ts: number
}

interface CoordinatorConversationFileV1 {
  entries: CoordinatorConversationEntryV1[]
  gauge?: CoordinatorContextGaugeV1
}

/** Newest entries kept on write — the conversation is a working surface,
 *  not an archive (the receipts feed owns the durable audit trail). */
export const CONVERSATION_CAP = 200

const decodeEntry = (raw: unknown): CoordinatorConversationEntryV1 | null => {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<CoordinatorConversationEntryV1>
  if (typeof r.id !== 'string' || r.id.length === 0) return null
  if (r.role !== 'operator' && r.role !== 'coordinator') return null
  if (typeof r.text !== 'string') return null
  if (typeof r.ts !== 'number' || !Number.isFinite(r.ts)) return null
  const receipts = Array.isArray(r.receipts)
    ? r.receipts
        .filter(
          (x): x is CoordinatorConversationReceiptV1 =>
            !!x &&
            typeof x === 'object' &&
            typeof (x as CoordinatorConversationReceiptV1).verb === 'string' &&
            typeof (x as CoordinatorConversationReceiptV1).outcome === 'string' &&
            typeof (x as CoordinatorConversationReceiptV1).label === 'string',
        )
        .slice(0, 24)
    : undefined
  const ask = r.ask !== undefined ? decodeManagerAsk(r.ask) : null
  const plan = r.plan !== undefined ? decodeManagerPlan(r.plan) : null
  return {
    id: r.id.slice(0, 128),
    role: r.role,
    text: r.text.slice(0, 8000),
    ts: r.ts,
    ...(receipts !== undefined && receipts.length > 0 ? { receipts } : {}),
    ...(r.harness === true ? { harness: true as const } : {}),
    ...(r.summary === true ? { summary: true as const } : {}),
    ...(ask !== null ? { ask } : {}),
    ...(plan !== null ? { plan } : {}),
  }
}

const decodeGauge = (raw: unknown): CoordinatorContextGaugeV1 | undefined => {
  if (!raw || typeof raw !== 'object') return undefined
  const g = raw as Partial<CoordinatorContextGaugeV1>
  if (typeof g.contextTokens !== 'number' || !Number.isFinite(g.contextTokens) || g.contextTokens < 0) return undefined
  if (typeof g.modelId !== 'string' || g.modelId.length === 0) return undefined
  if (typeof g.ts !== 'number' || !Number.isFinite(g.ts)) return undefined
  return { contextTokens: Math.floor(g.contextTokens), modelId: g.modelId.slice(0, 128), ts: g.ts }
}

const conversationStore = defineStore<CoordinatorConversationFileV1, [dir?: string]>({
  name: 'coordinator-conversation',
  path: (dir?: string) => join(dir ?? getMercuryHome(), 'coordinator-conversation.json'),
  schemaVersion: 1,
  decode: raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const r = raw as Partial<CoordinatorConversationFileV1>
    const entries = Array.isArray(r.entries)
      ? r.entries.map(decodeEntry).filter((e): e is CoordinatorConversationEntryV1 => e !== null)
      : []
    const gauge = decodeGauge(r.gauge)
    return { entries: entries.slice(-CONVERSATION_CAP), ...(gauge !== undefined ? { gauge } : {}) }
  },
  empty: () => ({ entries: [] }),
  onReadFailure: 'empty',
})

export async function readCoordinatorConversation(dir?: string): Promise<CoordinatorConversationEntryV1[]> {
  return (await conversationStore(dir).read()).entries
}

export async function appendCoordinatorConversation(
  entry: CoordinatorConversationEntryV1,
  dir?: string,
): Promise<void> {
  await conversationStore(dir).mutate(prev => ({
    ...prev,
    entries: [...prev.entries.filter(e => e.id !== entry.id), entry].slice(-CONVERSATION_CAP),
  }))
}

/** The gauge's ONE writer road (the assisted-turn stamp). */
export async function stampCoordinatorGauge(gauge: CoordinatorContextGaugeV1, dir?: string): Promise<void> {
  await conversationStore(dir).mutate(prev => ({ ...prev, gauge }))
}

export async function readCoordinatorGauge(dir?: string): Promise<CoordinatorContextGaugeV1 | undefined> {
  return (await conversationStore(dir).read()).gauge
}

/** /clear is a REAL command
 *  — the conversation store empties client-side; the model never sees it,
 *  so it can never fabricate a "Cleared" it did not perform. */
export async function clearCoordinatorConversation(dir?: string): Promise<void> {
  const store = conversationStore(dir)
  await store.update(() => ({ next: { entries: [] }, result: undefined }))
}

/** THE FOLD SWAP (chat-relief — the store half of summarize-in-place;
 *  coordinatorCompact owns the summary call and the marker's grammar): drop
 *  exactly the summarized ids, seat the harness-voiced summary marker before
 *  the surviving tail, and clear the context gauge — accurate counts are
 *  unavailable until the next turn answers (the main chat's post-compaction
 *  warning suppression, spoken through the store). Entries appended while
 *  the summary call ran are newer than the fold and survive untouched.
 *  The v1 drop-with-marker (compactCoordinatorConversation) retired with
 *  this: a fold that discards content instead of summarizing it is not
 *  compaction, and no road may fall back to it silently. */
export async function applyCoordinatorFold(
  marker: CoordinatorConversationEntryV1,
  foldedIds: ReadonlySet<string>,
  dir?: string,
): Promise<void> {
  const store = conversationStore(dir)
  await store.mutate(current => ({
    entries: [marker, ...current.entries.filter(e => !foldedIds.has(e.id))].slice(-CONVERSATION_CAP),
  }))
}

export function subscribeCoordinatorConversation(cb: () => void, dir?: string): () => void {
  return conversationStore(dir).subscribe(() => cb(), { immediate: false })
}
