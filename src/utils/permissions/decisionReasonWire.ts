// ============================================================================
//  src/utils/permissions/decisionReasonWire.ts — the decision reason across
//  the doorway.
//
//  A session hosted by the daemon raises its consent asks over the
//  permission-prompt-tool control protocol. WHY it asks — the matched rule,
//  the mode, a hook, a safety check, a compound command's per-part verdicts
//  — is what the consent card explains on screen ("The rule Bash(rm:*)
//  requires confirmation for this command"), so the hopped-into session's
//  card reads exactly as the card of the session started at boot. The
//  reason type carries a Map (subcommandResults) that JSON cannot; this
//  codec is the ONE spelling of the reason on the wire: Maps become entry
//  lists on the way out and Maps again on the way in, every other member
//  crosses as it is. A value that is not a well-formed reason decodes to
//  nothing — never a fabricated explanation line.
// ============================================================================
import type { PermissionDecisionReason, PermissionResult } from '../../types/permissions.js'

/** A per-part verdict on the wire: the result with its own reason encoded. */
export interface PermissionResultWireV1 {
  [key: string]: unknown
  decisionReason?: DecisionReasonWireV1
}

/** The wire form: the reason with every Map spelled as an entry list. */
export type DecisionReasonWireV1 =
  | Exclude<PermissionDecisionReason, { type: 'subcommandResults' }>
  | { type: 'subcommandResults'; reasons: Array<[string, PermissionResultWireV1]> }

/** The reason as the child sends it: JSON-safe, nothing dropped. */
export function encodeDecisionReasonForWire(
  reason: PermissionDecisionReason | undefined,
): DecisionReasonWireV1 | undefined {
  if (!reason) return undefined
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

/** The reason as the host reads it back: the card's own type, or nothing
 *  when the value is not a well-formed reason (the card then explains
 *  nothing rather than something made up). */
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
