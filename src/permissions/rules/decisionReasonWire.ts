import type {
  BypassedAskRoad,
  PermissionDecisionReason,
  PermissionMode,
  PermissionResult,
} from './permissions.js'
import { BYPASSED_ASK_ROAD_WORDS } from './permissions.js'
import { isRecord } from '../../platform/primitives/isRecord.js'

interface PermissionResultWireV1 {
  [key: string]: unknown
  decisionReason?: DecisionReasonWireV1
}

export type DecisionReasonWireV1 =
  | Exclude<PermissionDecisionReason, { type: 'subcommandResults' | 'bypassedAsk' }>
  | { type: 'subcommandResults'; reasons: Array<[string, PermissionResultWireV1]> }
  | { type: 'bypassedAsk'; mode: PermissionMode; road: BypassedAskRoad; reason: DecisionReasonWireV1 }

const BYPASSED_ASK_ROADS: ReadonlySet<string> = new Set(Object.keys(BYPASSED_ASK_ROAD_WORDS))

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

function untouchedWhen(minimumHolds: boolean, value: unknown): PermissionDecisionReason | undefined {
  return minimumHolds ? (value as PermissionDecisionReason) : undefined
}

export function decodeDecisionReasonFromWire(value: unknown): PermissionDecisionReason | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined
  switch (value.type) {
    case 'rule': {
      const ruleValue = isRecord(value.rule) ? value.rule.ruleValue : undefined
      return untouchedWhen(isRecord(ruleValue) && typeof ruleValue.toolName === 'string', value)
    }
    case 'mode':
      return untouchedWhen(typeof value.mode === 'string', value)
    case 'hook':
      return untouchedWhen(typeof value.hookName === 'string', value)
    case 'asyncAgent':
    case 'workingDir':
    case 'other':
      return untouchedWhen(typeof value.reason === 'string', value)
    case 'guard':
      return untouchedWhen(typeof value.reason === 'string' && typeof value.guard === 'string', value)
    case 'safetyCheck':
      return untouchedWhen(typeof value.reason === 'string' && typeof value.operatorOnly === 'boolean', value)
    case 'permissionPromptTool':
      return untouchedWhen(true, value)
    case 'bypassedAsk': {
      if (typeof value.mode !== 'string' || !isBypassedAskRoad(value.road)) return undefined
      const reason = decodeDecisionReasonFromWire(value.reason)
      if (reason === undefined) return undefined
      return {
        type: 'bypassedAsk',
        mode: value.mode as PermissionMode,
        road: value.road,
        reason,
      }
    }
    case 'subcommandResults': {
      if (!Array.isArray(value.reasons)) return undefined
      const reasons = new Map<string, PermissionResult>()
      for (const entry of value.reasons) {
        if (!Array.isArray(entry) || entry.length !== 2) continue
        const [command, rawResult] = entry
        if (typeof command !== 'string') continue
        if (!isRecord(rawResult)) continue
        const { decisionReason, ...rest } = rawResult
        const decoded = decodeDecisionReasonFromWire(decisionReason)
        const next: object = decoded !== undefined ? { ...rest, decisionReason: decoded } : rest
        reasons.set(command, next as PermissionResult)
      }
      return { type: 'subcommandResults', reasons }
    }
    default:
      return undefined
  }
}
