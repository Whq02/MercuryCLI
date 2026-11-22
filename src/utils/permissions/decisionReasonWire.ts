import type {
  BypassedAskRoad,
  PermissionDecisionReason,
  PermissionMode,
  PermissionResult,
} from '../../types/permissions.js'
import { BYPASSED_ASK_ROAD_WORDS } from '../../types/permissions.js'
import { notBuilt } from '../../pi/holes.js'

interface PermissionResultWireV1 {
  [key: string]: unknown
  decisionReason?: DecisionReasonWireV1
}

export type DecisionReasonWireV1 =
  | Exclude<PermissionDecisionReason, { type: 'subcommandResults' | 'bypassedAsk' }>
  | { type: 'subcommandResults'; reasons: Array<[string, PermissionResultWireV1]> }
  | { type: 'bypassedAsk'; mode: PermissionMode; road: BypassedAskRoad; reason: DecisionReasonWireV1 }

const BYPASSED_ASK_ROADS: ReadonlySet<string> = new Set(Object.keys(BYPASSED_ASK_ROAD_WORDS))

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
  return notBuilt('src/utils/permissions/decisionReasonWire.ts:41')
}
