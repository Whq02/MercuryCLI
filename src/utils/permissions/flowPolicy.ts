import type { Tool, ToolPermissionContext } from '../../Tool.js'
import { flowAskFor, flowAskSentence, type FlowAsk } from './flowLaw.js'
import type { PermissionAskDecision, PermissionDecision, PermissionDecisionReason } from './PermissionResult.js'

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

function flowFloorOf(tool: Pick<Tool, 'requiresUserInteraction' | 'mcpInfo'>, engineDecision: PermissionAskDecision): FlowFloor | null {
  const reason = engineDecision.decisionReason
  if (reasonCarriesAskRule(reason)) return 'ask-rule'
  if (reason?.type === 'safetyCheck' && reason.operatorOnly) return 'safety'
  if (reason?.type === 'hook') return 'hook'
  if (tool.requiresUserInteraction?.()) return 'interaction'
  if (tool.mcpInfo?.effectiveMaxPermission === 'ask') return 'ask-ceiling'
  return null
}

export async function decideUnderFlow(tool: Tool, input: Record<string, unknown>, engineDecision: PermissionAskDecision, rules: ToolPermissionContext): Promise<FlowVerdict> {
  const floor = flowFloorOf(tool, engineDecision)
  if (floor !== null) return { stage: 'flowFloors', floor, decision: engineDecision }
  let ask: FlowAsk | null = null
  try {
    ask = await flowAskFor(tool, input, rules)
  } catch {
    ask = null
  }
  if (ask !== null) {
    const message = flowAskSentence(ask)
    return {
      stage: 'flowLaw',
      ask,
      decision: {
        behavior: 'ask',
        message,
        decisionReason: { type: 'other', reason: message },
        ...(engineDecision.suggestions !== undefined ? { suggestions: engineDecision.suggestions } : {}),
        ...(engineDecision.updatedInput !== undefined ? { updatedInput: engineDecision.updatedInput } : {}),
      },
    }
  }
  return {
    stage: 'flowAllow',
    decision: { behavior: 'allow', updatedInput: engineDecision.updatedInput ?? input, decisionReason: { type: 'mode', mode: 'flow' } },
  }
}
