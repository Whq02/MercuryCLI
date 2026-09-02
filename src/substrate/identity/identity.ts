
import { createHash } from 'crypto'
import { getMercuryHome, rawConfigHomePinSpelling } from '../../utils/envUtils.js'
import { operatorKeyId } from './operatorKey.js'
import type { Principal } from './principal.js'

export function operatorPrincipal(): Principal {
  return { id: operatorKeyId(), kind: 'operator', name: process.env.USER || 'operator' }
}

export function legacyOperatorPrincipalId(): string {
  const seed = `${getMercuryHome()}|${process.env.USER || 'operator'}`
  return `op-${createHash('sha256').update(seed).digest('hex').slice(0, 12)}`
}

export function rawPinOperatorPrincipalId(): string | null {
  const raw = rawConfigHomePinSpelling()
  if (raw === null || raw === getMercuryHome()) return null
  const seed = `${raw}|${process.env.USER || 'operator'}`
  return `op-${createHash('sha256').update(seed).digest('hex').slice(0, 12)}`
}

export function legacyOperatorPrincipalIds(): string[] {
  const raw = rawPinOperatorPrincipalId()
  const legacy = legacyOperatorPrincipalId()
  return raw !== null && raw !== legacy ? [legacy, raw] : [legacy]
}

export function isLegacyOperatorPrincipalId(id: string): boolean {
  return legacyOperatorPrincipalIds().includes(id)
}

export function principalIdOwnsRecord(callerId: string, recordOwner: string | null): boolean {
  if (recordOwner === null) return false
  if (callerId === recordOwner) return true
  return callerId === operatorPrincipal().id && isLegacyOperatorPrincipalId(recordOwner)
}

export function assistantPrincipal(): Principal {
  return { id: 'agent-mercury', kind: 'agent', name: 'Mercury' }
}
