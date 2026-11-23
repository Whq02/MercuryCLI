import type {
  BypassedAskRoad,
  PermissionDecisionReason,
  PermissionMode,
  PermissionResult,
} from '../../types/permissions.js'
import { BYPASSED_ASK_ROAD_WORDS } from '../../types/permissions.js'

interface PermissionResultWireV1 {
  [key: string]: unknown
  decisionReason?: DecisionReasonWireV1
}

export type DecisionReasonWireV1 =
  | Exclude<PermissionDecisionReason, { type: 'subcommandResults' | 'bypassedAsk' }>
  | { type: 'subcommandResults'; reasons: Array<[string, PermissionResultWireV1]> }
  | { type: 'bypassedAsk'; mode: PermissionMode; road: BypassedAskRoad; reason: DecisionReasonWireV1 }

const BYPASSED_ASK_ROADS: ReadonlySet<string> = new Set(Object.keys(BYPASSED_ASK_ROAD_WORDS))

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function isBypassedAskRoad(value: unknown): value is BypassedAskRoad {
  return typeof value === 'string' && BYPASSED_ASK_ROADS.has(value)
}

export function encodeDecisionReasonForWire(
  reason: PermissionDecisionReason | undefined,
): DecisionReasonWireV1 | undefined {
  if (!reason) return undefined
  if (reason.type === 'bypassedAsk') {
    const inner = encodeDecisionReasonForWire(reason.reason)
    return inner === undefined ? undefined : { ...reason, reason: inner }
  }
  if (reason.type !== 'subcommandResults') return reason
  const reasons: Array<[string, PermissionResultWireV1]> = []
  for (const [command, result] of reason.reasons) {
    const { decisionReason, ...rest } = result as PermissionResult & {
      decisionReason?: PermissionDecisionReason
    }
    const encoded = encodeDecisionReasonForWire(decisionReason)
    reasons.push([command, { ...rest, ...(encoded !== undefined ? { decisionReason: encoded } : {}) }])
  }
  return { type: 'subcommandResults', reasons }
}

export function decodeDecisionReasonFromWire(value: unknown): PermissionDecisionReason | undefined {
  const record = asRecord(value)
  if (record === undefined || typeof record.type !== 'string') return undefined
  switch (record.type) {
    case 'rule': {
      const rule = asRecord(record.rule)
      const ruleValue = rule ? asRecord(rule.ruleValue) : undefined
      return ruleValue && typeof ruleValue.toolName === 'string'
        ? (value as PermissionDecisionReason)
        : undefined
    }
    case 'mode':
      return typeof record.mode === 'string' ? (value as PermissionDecisionReason) : undefined
    case 'hook':
      return typeof record.hookName === 'string' ? (value as PermissionDecisionReason) : undefined
    case 'asyncAgent':
    case 'workingDir':
    case 'other':
      return typeof record.reason === 'string' ? (value as PermissionDecisionReason) : undefined
    case 'guard':
      return typeof record.reason === 'string' && typeof record.guard === 'string'
        ? (value as PermissionDecisionReason)
        : undefined
    case 'safetyCheck':
      return typeof record.reason === 'string' && typeof record.operatorOnly === 'boolean'
        ? (value as PermissionDecisionReason)
        : undefined
    case 'permissionPromptTool':
      return value as PermissionDecisionReason
    case 'bypassedAsk': {
      if (typeof record.mode !== 'string' || !isBypassedAskRoad(record.road)) return undefined
      const reason = decodeDecisionReasonFromWire(record.reason)
      if (reason === undefined) return undefined
      return {
        type: 'bypassedAsk',
        mode: record.mode as PermissionMode,
        road: record.road,
        reason,
      }
    }
    case 'subcommandResults': {
      if (!Array.isArray(record.reasons)) return undefined
      const reasons = new Map<string, PermissionResult>()
      for (const entry of record.reasons) {
        if (!Array.isArray(entry) || entry.length !== 2) continue
        const [command, rawResult] = entry
        if (typeof command !== 'string') continue
        const resultRecord = asRecord(rawResult)
        if (resultRecord === undefined) continue
        const { decisionReason, ...rest } = resultRecord
        const decoded = decodeDecisionReasonFromWire(decisionReason)
        const next: unknown = decoded !== undefined ? { ...rest, decisionReason: decoded } : rest
        reasons.set(command, next as PermissionResult)
      }
      return { type: 'subcommandResults', reasons }
    }
    default:
      return undefined
  }
}
