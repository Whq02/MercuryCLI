import { APIUserAbortError } from '../../../services/api/sdkErrors.js'
import type { Tool, ToolUseContext } from '../../../Tool.js'
import { shouldUseSandbox } from '../../../tools/BashTool/shouldUseSandbox.js'
import { BASH_TOOL_NAME } from '../../../tools/BashTool/toolName.js'
import { AbortError } from '../../errors.js'
import { logForDebugging } from '../../debug.js'
import { logError } from '../../log.js'
import { SandboxManager } from '../../sandbox/sandbox-adapter.js'
import { jsonStringify } from '../../slowOperations.js'
import { isToolKilled } from '../capabilityGate.js'
import { modeBypassesPermissions } from '../PermissionMode.js'
import type {
  PermissionAskDecision,
  PermissionDecision,
  PermissionDecisionReason,
  PermissionDenyDecision,
  PermissionResult,
} from '../PermissionResult.js'
import type { BypassedAskRoad, PermissionMode } from '../../../types/permissions.js'
import { createPermissionRequestMessage, ORG_ASK_REASON } from './requestMessage.js'
import {
  getAskRuleForTool,
  getDenyRuleForTool,
  toolAlwaysAllowedRule,
} from './rules.js'
import type {
  DecisionEntry,
  DecisionStageId,
  DecisionStageRecord,
  DecisionTrace,
} from './trace.js'

export interface DecisionPorts {
  isToolKilled(tool: Tool, agentType: string | undefined): boolean
  sandboxAutoAllows(tool: Tool, input: Record<string, unknown>): boolean
  resolveToolVerdict(
    tool: Tool,
    input: Record<string, unknown>,
    context: ToolUseContext,
  ): Promise<PermissionResult>
}

export const defaultDecisionPorts: DecisionPorts = {
  isToolKilled: (tool, agentType) => isToolKilled(tool, agentType),
  sandboxAutoAllows: (tool, input) =>
    tool.name === BASH_TOOL_NAME &&
    SandboxManager.isSandboxingEnabled() &&
    SandboxManager.isAutoAllowBashIfSandboxedEnabled() &&
    shouldUseSandbox(input),
  resolveToolVerdict: async (tool, input, context) =>
    tool.checkPermissions(tool.inputSchema.parse(input), context),
}

export interface DecisionOutcome<D> {
  decision: D
  trace: DecisionTrace
}

export function postureBypassesAsks(permissionContext: {
  mode: PermissionMode
  isBypassPermissionsModeAvailable?: boolean
}): boolean {
  return (
    modeBypassesPermissions(permissionContext.mode) ||
    (permissionContext.mode === 'strategy' && permissionContext.isBypassPermissionsModeAvailable === true)
  )
}

export async function decideToolPermission(
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
  ports: DecisionPorts = defaultDecisionPorts,
): Promise<DecisionOutcome<PermissionDecision>> {
  const { decision, trace } = await runDecisionChain(
    'full',
    tool,
    input,
    context,
    ports,
  )
  return { decision: decision as PermissionDecision, trace }
}

export async function decideRuleBasedPermissions(
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
  ports: DecisionPorts = defaultDecisionPorts,
): Promise<
  DecisionOutcome<PermissionAskDecision | PermissionDenyDecision | null>
> {
  const { decision, trace } = await runDecisionChain(
    'ruleSubset',
    tool,
    input,
    context,
    ports,
  )
  return {
    decision: decision as PermissionAskDecision | PermissionDenyDecision | null,
    trace,
  }
}

async function runDecisionChain(
  entry: DecisionEntry,
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
  ports: DecisionPorts,
): Promise<{ decision: PermissionDecision | null; trace: DecisionTrace }> {
  const appState = context.getAppState()
  const entryMode = appState.toolPermissionContext.mode
  const stages: DecisionStageRecord[] = []
  const pass = (stage: DecisionStageId, note?: string): void => {
    stages.push(note ? { stage, outcome: 'pass', note } : { stage, outcome: 'pass' })
  }
  const decided = (
    stage: DecisionStageId,
    decision: PermissionDecision,
    note?: string,
  ): { decision: PermissionDecision; trace: DecisionTrace } => {
    stages.push(
      note ? { stage, outcome: 'decided', note } : { stage, outcome: 'decided' },
    )
    return {
      decision,
      trace: { entry, toolName: tool.name, mode: entryMode, stages, decidedBy: stage },
    }
  }

  if (entry === 'full') {
    if (context.abortController.signal.aborted) {
      throw new AbortError()
    }

    if (ports.isToolKilled(tool, context.agentType)) {
      return decided('killSwitch', {
        behavior: 'deny',
        decisionReason: {
          type: 'other',
          reason: `Capability '${tool.name}' has been switched off for this agent by the operator.`,
        },
        message: `Permission to use ${tool.name} has been denied: capability switched off by operator.`,
      })
    }
    pass('killSwitch')
  }

  const permissionContext = appState.toolPermissionContext

  const denyRule = getDenyRuleForTool(permissionContext, tool)
  if (denyRule) {
    return decided('toolDenyRule', {
      behavior: 'deny',
      decisionReason: { type: 'rule', rule: denyRule },
      message: `Permission to use ${tool.name} has been denied.`,
    })
  }
  pass('toolDenyRule')

  const askRule = getAskRuleForTool(permissionContext, tool)
  let carriedAskRule: typeof askRule | null = null
  if (askRule) {
    if (!ports.sandboxAutoAllows(tool, input)) {
      if (postureBypassesAsks(permissionContext)) {
        carriedAskRule = askRule
        pass('toolAskRule', `mode: ${permissionContext.mode} — carried past the tool verdict; the ask stands down`)
      } else {
        return decided('toolAskRule', {
          behavior: 'ask',
          decisionReason: { type: 'rule', rule: askRule },
          message: createPermissionRequestMessage(tool.name),
        })
      }
    } else {
      pass('toolAskRule', 'sandbox-auto-allow fallthrough')
    }
  } else {
    pass('toolAskRule')
  }

  let toolVerdict: PermissionResult = {
    behavior: 'passthrough',
    message: createPermissionRequestMessage(tool.name),
  }
  let verdictFailed = false
  try {
    toolVerdict = await ports.resolveToolVerdict(tool, input, context)
  } catch (e) {
    if (e instanceof AbortError || e instanceof APIUserAbortError) {
      throw e
    }
    logError(e)
    verdictFailed = true
  }
  pass(
    'toolVerdict',
    verdictFailed
      ? 'resolution failed — degraded to passthrough'
      : `verdict: ${toolVerdict?.behavior}`,
  )

  if (toolVerdict?.behavior === 'deny') {
    return decided('toolVerdictDeny', toolVerdict)
  }
  pass('toolVerdictDeny')

  if (entry === 'full') {
    if (tool.requiresUserInteraction?.() && toolVerdict?.behavior === 'ask') {
      return decided('userInteractionAsk', toolVerdict)
    }
    pass('userInteractionAsk')
  }

  const latestContext = context.getAppState().toolPermissionContext
  const shouldBypassPermissions = postureBypassesAsks(latestContext)

  const roadUnderPosture = (
    stage: DecisionStageId,
    road: BypassedAskRoad,
    reason: PermissionDecisionReason,
  ): { decision: PermissionDecision; trace: DecisionTrace } | null => {
    const note = `mode: ${latestContext.mode} — the ask stands down`
    if (entry === 'ruleSubset') {
      pass(stage, note)
      return null
    }
    return decided(
      stage,
      {
        behavior: 'allow',
        updatedInput: getUpdatedInputOrFallback(toolVerdict, input),
        decisionReason: { type: 'bypassedAsk', mode: latestContext.mode, road, reason },
      },
      note,
    )
  }

  if (carriedAskRule) {
    if (shouldBypassPermissions) {
      const carried = roadUnderPosture('toolAskRuleCarried', 'toolAskRule', { type: 'rule', rule: carriedAskRule })
      if (carried !== null) return carried
    } else {
      return decided('toolAskRuleCarried', {
        behavior: 'ask',
        decisionReason: { type: 'rule', rule: carriedAskRule },
        message: createPermissionRequestMessage(tool.name),
      })
    }
  } else {
    pass('toolAskRuleCarried')
  }

  if (
    toolVerdict?.behavior === 'ask' &&
    toolVerdict.decisionReason?.type === 'rule' &&
    toolVerdict.decisionReason.rule.ruleBehavior === 'ask'
  ) {
    if (!shouldBypassPermissions) return decided('contentAskRule', toolVerdict)
    const stoodDown = roadUnderPosture('contentAskRule', 'contentAskRule', toolVerdict.decisionReason)
    if (stoodDown !== null) return stoodDown
  } else {
    pass('contentAskRule')
  }

  if (tool.mcpInfo?.effectiveMaxPermission === 'ask') {
    const reason: PermissionDecisionReason = {
      type: 'other',
      reason: ORG_ASK_REASON,
    }
    if (!shouldBypassPermissions) {
      return decided('orgAskCeiling', {
        behavior: 'ask',
        message: createPermissionRequestMessage(tool.name, reason),
        decisionReason: reason,
      })
    }
    const stoodDown = roadUnderPosture('orgAskCeiling', 'orgAskCeiling', reason)
    if (stoodDown !== null) return stoodDown
  } else {
    pass('orgAskCeiling')
  }

  if (
    toolVerdict?.behavior === 'ask' &&
    toolVerdict.decisionReason?.type === 'safetyCheck'
  ) {
    if (!shouldBypassPermissions) return decided('safetyCheckAsk', toolVerdict)
    const stoodDown = roadUnderPosture('safetyCheckAsk', 'safetyCheckAsk', toolVerdict.decisionReason)
    if (stoodDown !== null) return stoodDown
  } else {
    pass('safetyCheckAsk')
  }

  if (entry === 'ruleSubset') {
    return {
      decision: null,
      trace: { entry, toolName: tool.name, mode: entryMode, stages, decidedBy: 'none' },
    }
  }

  if (shouldBypassPermissions) {
    return decided(
      'bypassPosture',
      {
        behavior: 'allow',
        updatedInput: getUpdatedInputOrFallback(toolVerdict, input),
        decisionReason: { type: 'mode', mode: latestContext.mode },
      },
      `mode: ${latestContext.mode}`,
    )
  }
  pass('bypassPosture')

  const alwaysAllowedRule = toolAlwaysAllowedRule(latestContext, tool)
  if (alwaysAllowedRule) {
    return decided('toolAllowRule', {
      behavior: 'allow',
      updatedInput: getUpdatedInputOrFallback(toolVerdict, input),
      decisionReason: { type: 'rule', rule: alwaysAllowedRule },
    })
  }
  pass('toolAllowRule')

  const resolved: PermissionDecision =
    toolVerdict.behavior === 'passthrough'
      ? {
          ...toolVerdict,
          behavior: 'ask' as const,
          message: createPermissionRequestMessage(
            tool.name,
            toolVerdict.decisionReason,
          ),
        }
      : toolVerdict

  if (resolved.behavior === 'ask' && resolved.suggestions) {
    logForDebugging(
      `Permission suggestions for ${tool.name}: ${jsonStringify(resolved.suggestions, null, 2)}`,
    )
  }

  return decided('resolution', resolved, `verdict: ${toolVerdict.behavior}`)
}

function getUpdatedInputOrFallback(
  permissionResult: PermissionResult,
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  return (
    ('updatedInput' in permissionResult
      ? permissionResult.updatedInput
      : undefined) ?? fallback
  )
}
