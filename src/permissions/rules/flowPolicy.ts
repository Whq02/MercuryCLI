import type { Tool, ToolPermissionContext } from '../../tools/kit/tool.js'
import type { PermissionUpdate } from './permissions.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { flowAskFor, flowAskSentence, type FlowAsk } from './flowLaw.js'
import type { PermissionAskDecision, PermissionDecision, PermissionDecisionReason } from './permissionResult.js'

type FlowFloor = 'ask-rule' | 'safety' | 'interaction' | 'ask-ceiling' | 'hook'

type FlowVerdict =
  | { stage: 'flowFloors'; floor: FlowFloor; decision: PermissionAskDecision }
  | { stage: 'flowLaw'; ask: FlowAsk; decision: PermissionAskDecision }
  | { stage: 'flowAllow'; decision: PermissionDecision }

function reasonCarriesAskRule(reason: PermissionDecisionReason | undefined): boolean {
  if (reason === undefined) return false
  if (reason.type === 'rule') return reason.rule.ruleBehavior === 'ask'
  if (reason.type !== 'subcommandResults') return false
  for (const sub of reason.reasons.values()) {
    if (sub.behavior === 'ask' && reasonCarriesAskRule(sub.decisionReason)) return true
  }
  return false
}

function reasonCarriesOperatorSafety(reason: PermissionDecisionReason | undefined): boolean {
  if (reason === undefined) return false
  if (reason.type === 'safetyCheck') return reason.operatorOnly
  if (reason.type !== 'subcommandResults') return false
  for (const sub of reason.reasons.values()) {
    if (sub.behavior === 'ask' && reasonCarriesOperatorSafety(sub.decisionReason)) return true
  }
  return false
}

function flowFloorOf(tool: Pick<Tool, 'requiresUserInteraction' | 'mcpInfo'>, engineDecision: PermissionAskDecision): FlowFloor | null {
  const reason = engineDecision.decisionReason
  if (reasonCarriesAskRule(reason)) return 'ask-rule'
  if (reasonCarriesOperatorSafety(reason)) return 'safety'
  if (reason?.type === 'hook') return 'hook'
  if (tool.requiresUserInteraction?.()) return 'interaction'
  if (tool.mcpInfo?.effectiveMaxPermission === 'ask') return 'ask-ceiling'
  return null
}

export async function decideUnderFlow(
  tool: Tool,
  input: Record<string, unknown>,
  engineDecision: PermissionAskDecision,
  rules: ToolPermissionContext,
  suggestionsAllowCall?: (suggestions: PermissionUpdate[]) => Promise<boolean>,
): Promise<FlowVerdict> {
  const floor = flowFloorOf(tool, engineDecision)
  if (floor !== null) return { stage: 'flowFloors', floor, decision: engineDecision }
  let ask: FlowAsk | null = null
  try {
    ask = await flowAskFor(tool, input, rules)
  } catch (error) {
    logForDebugging(`flow: the ${tool.name} call could not be checked (${error instanceof Error ? error.message : String(error)}), so it goes on unasked`, { level: 'warn' })
    ask = null
  }
  if (ask !== null) {
    const message = flowAskSentence(ask)
    const rawSuggestions = engineDecision.suggestions
    let keepSuggestions = rawSuggestions !== undefined && rawSuggestions.length > 0
    if (keepSuggestions && suggestionsAllowCall !== undefined) {
      try {
        keepSuggestions = await suggestionsAllowCall(rawSuggestions!)
      } catch {
        keepSuggestions = false
      }
    }
    return {
      stage: 'flowLaw',
      ask,
      decision: {
        behavior: 'ask',
        message,
        decisionReason: { type: 'other', reason: message },
        ...(keepSuggestions ? { suggestions: rawSuggestions } : {}),
        ...(engineDecision.updatedInput !== undefined ? { updatedInput: engineDecision.updatedInput } : {}),
      },
    }
  }
  return {
    stage: 'flowAllow',
    decision: { behavior: 'allow', updatedInput: engineDecision.updatedInput ?? input, decisionReason: { type: 'mode', mode: 'flow' } },
  }
}
