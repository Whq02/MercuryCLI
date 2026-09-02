
import type { OwnerKey } from '../run/ownerKey.js'

export const EVIDENCE_CONTRACT_VERSION = 1

export const EVIDENCE_KINDS = [
  'change',
  'check',
  'diagnostic',
  'execution',
  'artifact',
  'observation',
] as const

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]

export const EVIDENCE_ORIGINS = ['observed', 'derived', 'declared'] as const

export type EvidenceOrigin = (typeof EVIDENCE_ORIGINS)[number]

export const EVIDENCE_STATES = ['present', 'expired', 'unavailable', 'superseded'] as const

export type EvidenceState = (typeof EVIDENCE_STATES)[number]

export interface EvidenceRecord {
  version: typeof EVIDENCE_CONTRACT_VERSION
  id: string
  owner: OwnerKey
  kind: EvidenceKind
  origin: EvidenceOrigin
  claim: string
  state: EvidenceState
  observedAt: number
  refs: string[]
  details?: Record<string, unknown>
}

export function canPromoteEvidenceOrigin(from: EvidenceOrigin, to: EvidenceOrigin): boolean {
  return from === to
}

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
