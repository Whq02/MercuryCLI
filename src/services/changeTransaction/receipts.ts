
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
    }
  }
}

let installed = false
export function installChangeReceiptObserver(): void {
  if (installed) return
  installed = true
  subscribeToolTerminal(record)
}
installChangeReceiptObserver()

export function receiptsFor(owner: OwnerKey): readonly ChangeReceipt[] {
  return store.peek(owner)?.receipts ?? []
}

export function receiptsSince(
  owner: OwnerKey,
  sinceSeq: number,
): readonly ChangeReceipt[] {
  return receiptsFor(owner).filter(r => r.seq > sinceSeq)
}

export function receiptCursor(owner: OwnerKey): number {
  const ring = store.peek(owner)
  return ring ? ring.nextSeq - 1 : 0
}

export function receiptById(
  owner: OwnerKey,
  id: string,
): ChangeReceipt | undefined {
  return receiptsFor(owner).find(r => r.id === id)
}

export function _resetChangeReceiptsForTesting(): void {
  store.clearAllForShutdown()
}
