// ============================================================================
//  primitives/transactionPlane — the canonical owner-scoped transaction
//  registry.
//
//  ONE lifecycle for intended change. Two feeds:
//    · RECEIPT INGESTION — every ChangeReceipt (minted exactly once at the
//      effectObserver seam) settles a canonical TransactionRecord: the
//      observed truth of a direct mutation, lifecycle compressed along the
//      legal direct-edit path (created→applying→…). The receipt stays the
//      wire truth; the transaction is its lifecycle projection.
//    · EXPLICIT TRANSACTIONS — multi-stage/previewable operations begin a
//      record and walk the graph themselves (prepared → proposed → …).
//
//  Law-4 integrity is MECHANICAL here:
//    · 'applied' (and beyond) requires an observed effect ref;
//    · 'verified' requires observed check evidence refs;
//    · pre-execution refusals (permission denials, anchor-stale typed
//      results) never mint records — the same law that keeps the receipt
//      ring terminal-only.
// ============================================================================

import { randomBytes } from 'node:crypto'
import { registerOwnerScopedStore } from '../run/ownerLifecycle.js'
import type { OwnerKey } from '../run/ownerKey.js'
import { OwnerScopedStore } from '../run/ownerScopedStore.js'
import { subscribeChangeReceipts } from '../changeTransaction/receipts.js'
import type { ChangeReceipt } from '../changeTransaction/contracts.js'
import {
  canTransitionTransaction,
  isTerminalTransactionState,
  TRANSACTION_CONTRACT_VERSION,
  TransactionTransitionError,
  type TransactionFailure,
  type TransactionRecord,
  type TransactionState,
} from './transaction.js'

const RING_CAP = 128

interface OwnerTransactions {
  records: Map<string, TransactionRecord>
  order: string[]
}

const store = new OwnerScopedStore<OwnerTransactions>({
  name: 'transaction-plane',
  create: () => ({ records: new Map(), order: [] }),
  cap: 64,
})
registerOwnerScopedStore(store)

/** Law-4 refusal: a state that requires observation was claimed without it. */
export class TransactionIntegrityError extends Error {
  constructor(id: string, message: string) {
    super(`transaction '${id}': ${message}`)
    this.name = 'TransactionIntegrityError'
  }
}

function remember(owned: OwnerTransactions, record: TransactionRecord): void {
  owned.records.set(record.id, record)
  owned.order.push(record.id)
  while (owned.order.length > RING_CAP) {
    const evicted = owned.order.shift()!
    owned.records.delete(evicted)
  }
}

export interface BeginTransactionInput {
  owner: OwnerKey
  kind: string
  inputRefs?: string[]
  expectedVersions?: string[]
  executionRef?: string
  id?: string
}

export function beginTransaction(input: BeginTransactionInput): TransactionRecord {
  const owned = store.get(input.owner)
  const now = Date.now()
  const record: TransactionRecord = {
    version: TRANSACTION_CONTRACT_VERSION,
    id: input.id ?? `txn-${randomBytes(6).toString('hex')}`,
    owner: input.owner,
    kind: input.kind,
    state: 'created',
    createdAt: now,
    updatedAt: now,
    inputRefs: input.inputRefs ?? [],
    expectedVersions: input.expectedVersions ?? [],
    ...(input.executionRef !== undefined && { executionRef: input.executionRef }),
    evidenceRefs: [],
    resultRefs: [],
  }
  remember(owned, record)
  return record
}

export interface TransactionTransitionOptions {
  effectRef?: string
  evidenceRefs?: string[]
  resultRefs?: string[]
  failure?: TransactionFailure
}

/** States whose claim REQUIRES an observed effect (Law 4). */
const EFFECT_REQUIRED = new Set<TransactionState>(['applied', 'checking', 'verified'])

export function transitionTransaction(
  owner: OwnerKey,
  id: string,
  to: TransactionState,
  opts: TransactionTransitionOptions = {},
): TransactionRecord | undefined {
  const owned = store.peek(owner)
  const record = owned?.records.get(id)
  if (!owned || !record) return undefined
  const from = record.state
  if (from === to && isTerminalTransactionState(to)) return record // idempotent
  if (!canTransitionTransaction(from, to)) {
    throw new TransactionTransitionError(id, from, to)
  }
  const effectRef = opts.effectRef ?? record.effectRef
  if (EFFECT_REQUIRED.has(to) && effectRef === undefined) {
    throw new TransactionIntegrityError(
      id,
      `cannot claim '${to}' without an observed effect ref — no prose claim mints observation`,
    )
  }
  const evidenceRefs = [...record.evidenceRefs, ...(opts.evidenceRefs ?? [])]
  if (to === 'verified' && evidenceRefs.length === 0) {
    throw new TransactionIntegrityError(
      id,
      `cannot claim 'verified' without observed check evidence refs`,
    )
  }
  // 'settled' from 'verified'/'checking' keeps its checks; a direct
  // applied→settled records an UNCHECKED settlement honestly (no evidence).
  const next: TransactionRecord = {
    ...record,
    state: to,
    updatedAt: Date.now(),
    ...(effectRef !== undefined && { effectRef }),
    evidenceRefs,
    resultRefs: [...record.resultRefs, ...(opts.resultRefs ?? [])],
    ...(opts.failure !== undefined && { failure: opts.failure }),
  }
  owned.records.set(id, next)
  return next
}

// ── receipt ingestion (the exactly-once observed feed) ──────────────────────

function fileRef(path: string): string {
  return `mercury://file/${path.replace(/^\//, '')}`
}

function ingestReceipt(receipt: ChangeReceipt): void {
  try {
    // multi-target receipts carry EVERY path/version pair; the
    // single-anchor form stays byte-compatible for existing receipts.
    const expectedVersions =
      receipt.intent.targetVersions !== undefined
        ? receipt.intent.targetVersions.map(v => `${v.path}@${v.version}`)
        : receipt.intent.expectedAnchor !== undefined
          ? [receipt.intent.expectedAnchor]
          : undefined
    const record = beginTransaction({
      owner: receipt.owner,
      kind: receipt.effect.operation,
      id: `txn-${receipt.id}`,
      inputRefs: receipt.intent.targetPaths.map(fileRef),
      ...(expectedVersions !== undefined && { expectedVersions }),
    })
    const effectRef = `mercury://receipt/${receipt.id}`
    transitionTransaction(receipt.owner, record.id, 'applying')
    switch (receipt.effect.outcome) {
      case 'succeeded':
      case 'no-change':
        transitionTransaction(receipt.owner, record.id, 'applied', {
          effectRef,
          resultRefs: receipt.effect.changedPaths.map(fileRef),
        })
        transitionTransaction(receipt.owner, record.id, 'settled')
        break
      case 'failed':
        transitionTransaction(receipt.owner, record.id, 'failed', {
          // A failed effect that still changed paths records them — partial
          // application is truth, not embarrassment.
          effectRef,
          resultRefs: receipt.effect.changedPaths.map(fileRef),
          failure: {
            code: 'effect-failed',
            message: receipt.effect.evidence.slice(0, 300),
            recoverable: true,
          },
        })
        break
      case 'indeterminate':
        // Not proven done: 'failed' with the indeterminate code — a settled
        // claim here would promote uncertainty to success.
        transitionTransaction(receipt.owner, record.id, 'failed', {
          effectRef,
          resultRefs: receipt.effect.changedPaths.map(fileRef),
          failure: {
            code: 'indeterminate',
            message: receipt.effect.evidence.slice(0, 300),
            recoverable: true,
          },
        })
        break
    }
  } catch {
    /* ingestion never breaks the receipt mint */
  }
}

let installed = false
export function installTransactionIngestion(): void {
  if (installed) return
  installed = true
  subscribeChangeReceipts(ingestReceipt)
}
installTransactionIngestion()

// ── reads ───────────────────────────────────────────────────────────────────

export function transactionsFor(owner: OwnerKey): readonly TransactionRecord[] {
  const owned = store.peek(owner)
  if (!owned) return []
  return owned.order
    .map(id => owned.records.get(id))
    .filter((r): r is TransactionRecord => r !== undefined)
}

export function transactionById(owner: OwnerKey, id: string): TransactionRecord | undefined {
  return store.peek(owner)?.records.get(id)
}

/** TEST-ONLY: reset (proof harnesses). */
export function _resetTransactionPlaneForTesting(): void {
  store.clearAllForShutdown()
}
