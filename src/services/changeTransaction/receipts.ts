// ============================================================================
//  changeTransaction/receipts — the owner-scoped ChangeReceipt ring
//
//
//  Fed EXACTLY ONCE per mutation-shaped tool call from the effectObserver
//  seam (the same single-fire chokepoint the run coordinator and
//  verification state consume — no second observation path, no duplicate
//  ledger). Receipts are bounded conversation-lifetime state: the durable
//  record stays the run kernel sidecar; this ring exists so Counsel
// the resource plane, the doctor circuit,
//  and tool cards can read "what changed, in order, with intent" without
//  replaying transcripts.
//
//  Cancellation law (proved in scripts/project-services/prove-change-receipts.ts):
//  pre-execution refusals and aborts never reach observeToolTerminal, so a
//  cancelled call can never mint a partial receipt — the ring only ever
//  holds terminal observations.
// ============================================================================

import { randomBytes } from 'node:crypto'
import { subscribeToolTerminal, type ToolTerminalEvent } from '../run/effectObserver.js'
import { registerOwnerScopedStore } from '../run/ownerLifecycle.js'
import type { OwnerKey } from '../run/ownerKey.js'
import { OwnerScopedStore } from '../run/ownerScopedStore.js'
import {
  CHANGE_CONTRACT_VERSION,
  type ChangeIntent,
  type ChangeReceipt,
  changeTransactionEnabled,
  isReceiptShaped,
} from './contracts.js'

/** Bounded per-owner retention — old receipts fall off, never grow context. */
const RING_CAP = 256

interface ReceiptRing {
  receipts: ChangeReceipt[]
  nextSeq: number
}

const store = new OwnerScopedStore<ReceiptRing>({
  name: 'change-receipts',
  create: () => ({ receipts: [], nextSeq: 1 }),
  cap: 64,
})
registerOwnerScopedStore(store)

/** Derive the recorded intent from the observed event (bounded, no dumps).
 * a tool-provided typed projection WINS; the input-shape
 *  extraction below stays as the legacy fallback so existing tools keep
 *  their exact recorded intents. */
function intentFrom(event: ToolTerminalEvent): ChangeIntent {
  if (event.intentProjection) {
    const p = event.intentProjection
    return {
      source: `tool:${event.toolName}`,
      operation: event.effect?.operation ?? event.toolName,
      targetPaths: p.targetPaths.slice(0, 32),
      ...(p.expectedAnchor !== undefined && { expectedAnchor: p.expectedAnchor }),
      ...(p.targetVersions !== undefined && {
        targetVersions: p.targetVersions.slice(0, 32),
      }),
    }
  }
  const input = (event.input ?? {}) as Record<string, unknown>
  const targetPaths: string[] = []
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const v = input[key]
    if (typeof v === 'string' && v.length > 0) targetPaths.push(v)
  }
  if (targetPaths.length === 0 && event.effect) {
    targetPaths.push(...event.effect.changedPaths.slice(0, 16))
  }
  const expectedAnchor =
    typeof input.expected_anchor === 'string' ? input.expected_anchor : undefined
  return {
    source: `tool:${event.toolName}`,
    operation: event.effect?.operation ?? event.toolName,
    targetPaths,
    ...(expectedAnchor !== undefined && { expectedAnchor }),
  }
}

// downstream consumers (the transaction plane) ride the
// receipt mint itself — the SAME exactly-once observation, one hop later.
type ReceiptSubscriber = (receipt: ChangeReceipt) => void
const receiptSubscribers = new Set<ReceiptSubscriber>()

export function subscribeChangeReceipts(cb: ReceiptSubscriber): () => void {
  receiptSubscribers.add(cb)
  return () => {
    receiptSubscribers.delete(cb)
  }
}

function record(event: ToolTerminalEvent): void {
  if (!changeTransactionEnabled()) return
  const effect = event.effect
  if (!effect || !isReceiptShaped(effect)) return
  const ring = store.get(event.owner)
  const receipt: ChangeReceipt = {
    version: CHANGE_CONTRACT_VERSION,
    seq: ring.nextSeq++,
    id: `rcpt-${randomBytes(6).toString('hex')}`,
    owner: event.owner,
    toolName: event.toolName,
    toolUseId: event.toolUseId,
    startedAt: effect.startedAt,
    completedAt: effect.completedAt,
    intent: intentFrom(event),
    effect,
  }
  ring.receipts.push(receipt)
  if (ring.receipts.length > RING_CAP) {
    ring.receipts.splice(0, ring.receipts.length - RING_CAP)
  }
  for (const cb of receiptSubscribers) {
    try {
      cb(receipt)
    } catch {
      /* subscriber errors never break the mint */
    }
  }
}

// Self-install at module scope — the same idiom as the run coordinator's
// effectObserver subscription. The gate is re-read per event, so the flag
// stays live; the subscription itself is inert when the module is unloaded.
let installed = false
export function installChangeReceiptObserver(): void {
  if (installed) return
  installed = true
  subscribeToolTerminal(record)
}
installChangeReceiptObserver()

/** All retained receipts for an owner, oldest first. */
export function receiptsFor(owner: OwnerKey): readonly ChangeReceipt[] {
  return store.peek(owner)?.receipts ?? []
}

/** Receipts with seq > sinceSeq (the Counsel/resource cursor read). */
export function receiptsSince(
  owner: OwnerKey,
  sinceSeq: number,
): readonly ChangeReceipt[] {
  return receiptsFor(owner).filter(r => r.seq > sinceSeq)
}

/** The high-water sequence for an owner (0 when none recorded). */
export function receiptCursor(owner: OwnerKey): number {
  const ring = store.peek(owner)
  return ring ? ring.nextSeq - 1 : 0
}

/** Find one retained receipt by id (resource plane reads). */
export function receiptById(
  owner: OwnerKey,
  id: string,
): ChangeReceipt | undefined {
  return receiptsFor(owner).find(r => r.id === id)
}

/** TEST-ONLY: reset the ring store (proof harnesses). */
export function _resetChangeReceiptsForTesting(): void {
  store.clearAllForShutdown()
}
