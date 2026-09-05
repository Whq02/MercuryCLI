import type {
  BypassedAskRoad,
  PermissionDecisionReason,
  PermissionMode,
  PermissionResult,
} from '../../types/permissions.js'

export interface PermissionResultWireV1 {
  [key: string]: unknown
  decisionReason?: DecisionReasonWireV1
}

export type DecisionReasonWireV1 =
  | Exclude<PermissionDecisionReason, { type: 'subcommandResults' | 'bypassedAsk' }>
  | { type: 'subcommandResults'; reasons: Array<[string, PermissionResultWireV1]> }
  | { type: 'bypassedAsk'; mode: PermissionMode; road: BypassedAskRoad; reason: DecisionReasonWireV1 }

const BYPASSED_ASK_ROADS: ReadonlySet<string> = new Set(['contentAskRule', 'orgAskCeiling', 'safetyCheckAsk'])

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
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  switch (v.type) {
    case 'rule': {
      const rule = v.rule as { ruleValue?: { toolName?: unknown } } | undefined
      return rule && typeof rule === 'object' && typeof rule.ruleValue?.toolName === 'string'
        ? (value as PermissionDecisionReason)
        : undefined
    }
    case 'mode':
      return typeof v.mode === 'string' ? (value as PermissionDecisionReason) : undefined
    case 'hook':
      return typeof v.hookName === 'string' ? (value as PermissionDecisionReason) : undefined
    case 'classifier':
      return typeof v.classifier === 'string' ? (value as PermissionDecisionReason) : undefined
    case 'asyncAgent':
    case 'sandboxOverride':
    case 'workingDir':
    case 'other':
      return typeof v.reason === 'string' ? (value as PermissionDecisionReason) : undefined
    case 'safetyCheck':
      return typeof v.reason === 'string' && typeof v.classifierApprovable === 'boolean'
        ? (value as PermissionDecisionReason)
        : undefined
    case 'permissionPromptTool':
      return value as PermissionDecisionReason
    case 'bypassedAsk': {
      const inner = decodeDecisionReasonFromWire(v.reason)
      return typeof v.mode === 'string' && typeof v.road === 'string' && BYPASSED_ASK_ROADS.has(v.road) && inner !== undefined
        ? { type: 'bypassedAsk', mode: v.mode as PermissionMode, road: v.road as BypassedAskRoad, reason: inner }
        : undefined
    }
    case 'subcommandResults': {
      if (!Array.isArray(v.reasons)) return undefined
      const reasons = new Map<string, PermissionResult>()
      for (const entry of v.reasons as unknown[]) {
        if (!Array.isArray(entry) || entry.length !== 2) continue
        const [command, result] = entry as [unknown, unknown]
        if (typeof command !== 'string' || !result || typeof result !== 'object') continue
        const { decisionReason, ...rest } = result as PermissionResultWireV1
        const decoded = decodeDecisionReasonFromWire(decisionReason)
        reasons.set(command, {
          ...rest,
          ...(decoded !== undefined ? { decisionReason: decoded } : {}),
        } as PermissionResult)
      }
      return { type: 'subcommandResults', reasons }
    }
    default:
      return undefined
  }
}
