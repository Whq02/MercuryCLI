// ============================================================================
//  primitives/evidence — the Evidence primitive contract.
//
//  ONE spine for proved fact. Existing sources (verification evidence rows,
//  change receipts, service readiness, workshop cell results, envelope
//  checks, doctor rows) project INTO this vocabulary without losing their
//  domain detail — canonical evidence REFERENCES authoritative domain
//  storage, it never duplicates artifacts or transcripts.
//
//  The honesty floor (Law 4):
//    · 'declared'  — something SAID it happened (an agent's tail, a model's
//                    prose). Preserved, NEVER promoted to observed.
//    · 'observed'  — the effect/runtime chokepoint saw it happen.
//    · 'derived'   — computed from other evidence; must name its sources.
//
//  Types + pure guards only — the registry lives in evidencePlane.ts
//
// ============================================================================

import type { OwnerKey } from '../run/ownerKey.js'

export const EVIDENCE_CONTRACT_VERSION = 1

export const EVIDENCE_KINDS = [
  'change', // a mutation happened (receipt-backed)
  'check', // a verification command/condition ran (exit truth)
  'diagnostic', // IDE diagnostic observation/stabilization
  'execution', // an execution reached a state (settlement, readiness)
  'artifact', // a durable artifact exists with this identity
  'observation', // a direct observation not covered above
] as const

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]

export const EVIDENCE_ORIGINS = ['observed', 'derived', 'declared'] as const

export type EvidenceOrigin = (typeof EVIDENCE_ORIGINS)[number]

/** Retention honesty (Law 7 applied to proof): present is the only state a
 *  consumer may treat as standing evidence. */
export const EVIDENCE_STATES = ['present', 'expired', 'unavailable', 'superseded'] as const

export type EvidenceState = (typeof EVIDENCE_STATES)[number]

export interface EvidenceRecord {
  version: typeof EVIDENCE_CONTRACT_VERSION
  id: string
  owner: OwnerKey
  kind: EvidenceKind
  origin: EvidenceOrigin
  /** The one-sentence claim this record supports. */
  claim: string
  state: EvidenceState
  observedAt: number
  /** Source/related refs (mercury://). REQUIRED non-empty for 'derived' —
   *  derived evidence must name what it derives from. */
  refs: string[]
  /** Small typed domain payload — bounded, never dumps. */
  details?: Record<string, unknown>
}

/**
 * Origin promotion law: there is NO legal origin promotion. A declared claim
 * stays declared forever; observation happens by a NEW record from the
 * chokepoint, never by editing an origin. (Total function so the doctor row
 * and proofs can assert the whole matrix.)
 */
export function canPromoteEvidenceOrigin(from: EvidenceOrigin, to: EvidenceOrigin): boolean {
  return from === to
}

/** Structural validity of one record (the plane refuses invalid writes). */
export function evidenceRecordProblems(record: EvidenceRecord): string[] {
  const problems: string[] = []
  if (record.version !== EVIDENCE_CONTRACT_VERSION) problems.push('unknown version')
  if (!record.id) problems.push('missing id')
  if (!record.claim) problems.push('missing claim')
  if (!EVIDENCE_KINDS.includes(record.kind)) problems.push(`unknown kind '${record.kind}'`)
  if (!EVIDENCE_ORIGINS.includes(record.origin)) problems.push(`unknown origin '${record.origin}'`)
  if (!EVIDENCE_STATES.includes(record.state)) problems.push(`unknown state '${record.state}'`)
  if (record.origin === 'derived' && record.refs.length === 0) {
    problems.push('derived evidence must name its source refs')
  }
  return problems
}
