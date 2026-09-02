// ============================================================================
//  primitives/evidencePlane — the canonical evidence registry (
//
//
//  ONE spine over the existing observed sources — canonical records
//  REFERENCE authoritative domain storage (receipt ring, verification rows,
//  artifact store), never duplicate it. Wired producers, all riding the
//  domains' own exactly-once seams:
//    · change receipts        → kind 'change'    (subscribeChangeReceipts)
//    · execution settlements  → kind 'execution' (subscribeExecutionEvents)
//    · verification outcomes  → kind 'check'     (subscribeEvidenceRecorded)
//    · service readiness      → kind 'check'     (the service projection)
//    · workshop cell results  → kind 'execution' (recordWorkshopCell)
//    · agent envelopes        → evidenceRefs?    (normalize.ts, additive)
//  Doctor certification rows and artifact identities stay projected on
//  read through their existing resources (mercury://doctor, mercury://
//  artifact) — canonical rows for them would duplicate evidence-backed
//  records that already exist (recorded scope decision).
//
//  The honesty floor is mechanical here: origins are immutable (declared
//  can never become observed — new observation = new record from a
//  chokepoint), derived records must name sources, rings are bounded, and
//  eviction reads as 'expired', never 'absent'.
// ============================================================================

import { randomBytes } from 'node:crypto'
import { registerOwnerScopedStore } from '../run/ownerLifecycle.js'
import type { OwnerKey } from '../run/ownerKey.js'
import { OwnerScopedStore } from '../run/ownerScopedStore.js'
import { subscribeChangeReceipts } from '../changeTransaction/receipts.js'
import { subscribeEvidenceRecorded } from '../../utils/verification/verificationState.js'
import { subscribeExecutionEvents } from './executionPlane.js'
import {
  EVIDENCE_CONTRACT_VERSION,
  evidenceRecordProblems,
  type EvidenceKind,
  type EvidenceOrigin,
  type EvidenceRecord,
} from './evidence.js'

const RING_CAP = 256
const EVICTED_MEMORY = 256

interface OwnerEvidence {
  records: Map<string, EvidenceRecord>
  order: string[]
  dedupe: Map<string, string>
  evicted: string[]
}

const store = new OwnerScopedStore<OwnerEvidence>({
  name: 'evidence-plane',
  create: () => ({ records: new Map(), order: [], dedupe: new Map(), evicted: [] }),
  cap: 64,
})
registerOwnerScopedStore(store)

export class EvidenceIntegrityError extends Error {
  constructor(problems: string[]) {
    super(`invalid evidence record: ${problems.join('; ')}`)
    this.name = 'EvidenceIntegrityError'
  }
}

export interface RecordEvidenceInput {
  owner: OwnerKey
  kind: EvidenceKind
  origin: EvidenceOrigin
  claim: string
  refs?: string[]
  details?: Record<string, unknown>
  /** Stable identity for repeated observations of the same fact — a repeat
   *  SUPERSEDES the previous record (never silently replaces). */
  dedupeKey?: string
  id?: string
}

export function recordCanonicalEvidence(input: RecordEvidenceInput): EvidenceRecord {
  const record: EvidenceRecord = {
    version: EVIDENCE_CONTRACT_VERSION,
    id: input.id ?? `ev-${randomBytes(6).toString('hex')}`,
    owner: input.owner,
    kind: input.kind,
    origin: input.origin,
    claim: input.claim,
    state: 'present',
    observedAt: Date.now(),
    refs: input.refs ?? [],
    ...(input.details !== undefined && { details: input.details }),
  }
  const problems = evidenceRecordProblems(record)
  if (problems.length > 0) throw new EvidenceIntegrityError(problems)
  const owned = store.get(input.owner)
  if (input.dedupeKey) {
    const previous = owned.dedupe.get(input.dedupeKey)
    if (previous) {
      const old = owned.records.get(previous)
      if (old && old.state === 'present') {
        owned.records.set(previous, { ...old, state: 'superseded' })
      }
    }
    owned.dedupe.set(input.dedupeKey, record.id)
  }
  owned.records.set(record.id, record)
  owned.order.push(record.id)
  while (owned.order.length > RING_CAP) {
    const dropped = owned.order.shift()!
    owned.records.delete(dropped)
    owned.evicted.push(dropped)
    if (owned.evicted.length > EVICTED_MEMORY) owned.evicted.shift()
  }
  return record
}

/** Mark one record superseded (a newer observation replaced its claim). */
export function supersedeEvidence(owner: OwnerKey, id: string): boolean {
  const owned = store.peek(owner)
  const record = owned?.records.get(id)
  if (!owned || !record || record.state !== 'present') return false
  owned.records.set(id, { ...record, state: 'superseded' })
  return true
}

export function evidenceFor(owner: OwnerKey): readonly EvidenceRecord[] {
  const owned = store.peek(owner)
  if (!owned) return []
  return owned.order
    .map(id => owned.records.get(id))
    .filter((r): r is EvidenceRecord => r !== undefined)
}

export function evidenceById(owner: OwnerKey, id: string): EvidenceRecord | undefined {
  return store.peek(owner)?.records.get(id)
}

/** True when the bounded ring dropped this id (expired ≠ absent, Law 7). */
export function evidenceEvicted(owner: OwnerKey, id: string): boolean {
  return store.peek(owner)?.evicted.includes(id) ?? false
}

// ── wired producers (the domains' own exactly-once seams) ───────────────────

let installed = false
export function installEvidenceProducers(): void {
  if (installed) return
  installed = true

  subscribeChangeReceipts(receipt => {
    try {
      recordCanonicalEvidence({
        owner: receipt.owner,
        kind: 'change',
        origin: 'observed',
        claim:
          `${receipt.effect.operation} ${receipt.effect.outcome}` +
          (receipt.effect.changedPaths.length > 0
            ? ` — ${receipt.effect.changedPaths.length} path(s)`
            : ' — no paths'),
        refs: [
          `mercury://receipt/${receipt.id}`,
          `mercury://transaction/txn-${receipt.id}`,
        ],
        details: { outcome: receipt.effect.outcome, tool: receipt.toolName },
      })
    } catch {
      /* producers never break the source seam */
    }
  })

  subscribeExecutionEvents(event => {
    try {
      if (event.event.type !== 'transition') return
      const record = event.event.record
      if (event.event.to === 'stopped' && record.spec.kind.startsWith('workshop')) {
        return // workshop kills are already evidenced by their cell records
      }
      if (!['succeeded', 'failed', 'stopped', 'unavailable', 'indeterminate', 'cancelled'].includes(event.event.to)) {
        return
      }
      recordCanonicalEvidence({
        owner: event.owner,
        kind: 'execution',
        origin: 'observed',
        claim:
          `${record.spec.label} settled ${event.event.to}` +
          (record.outcome?.reason ? ` — ${record.outcome.reason.slice(0, 120)}` : ''),
        refs: [`mercury://execution/${record.spec.id}`],
        details: {
          kind: record.spec.kind,
          generation: record.generation,
          ...(event.event.reconciled !== undefined && { reconciled: event.event.reconciled }),
        },
      })
    } catch {
      /* producers never break the source seam */
    }
  })

  subscribeEvidenceRecorded((owner, row) => {
    try {
      recordCanonicalEvidence({
        owner,
        kind: 'check',
        origin: 'observed',
        claim: `${row.scope}: ${row.coverage} — ${row.ok ? 'green' : 'RED'}`,
        refs: [],
        details: {
          command: row.command.slice(0, 200),
          ok: row.ok,
          seq: row.seq,
          treeDigest: row.treeDigest,
        },
        dedupeKey: `check:${row.scope}:${row.coverage}`,
      })
    } catch {
      /* producers never break the source seam */
    }
  })
}
installEvidenceProducers()

/** TEST-ONLY: reset (proof harnesses). */
export function _resetEvidencePlaneForTesting(): void {
  store.clearAllForShutdown()
}
