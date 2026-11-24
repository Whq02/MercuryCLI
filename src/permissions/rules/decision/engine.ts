import { APIUserAbortError } from '../../../engine/request-parts/sdkErrors.js'
import type { Tool, ToolUseContext } from '../../../tools/kit/tool.js'
import { AbortError } from '../../../platform/errors/errors.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { logError } from '../../../platform/logs/errorLog.js'
import { jsonStringify } from '../../../platform/logs/slowOperations.js'
import { peekLoadedInstructions, type LoadedInstructionEntry } from './loadedInstructionsPeek.js'
import { isToolKilled } from '../capabilityGate.js'
import { noteComposedInstructionImports } from '../filesystem.js'
import { modeBypassesPermissions } from '../permissionMode.js'
import type {
  PermissionAskDecision,
  PermissionDecision,
  PermissionDecisionReason,
  PermissionDenyDecision,
  PermissionResult,
} from '../permissionResult.js'
import type { BypassedAskRoad, DecisionEntry, DecisionStageId, DecisionStageRecord, DecisionTrace } from '../permissions.js'
import { refusalWithReason, ruleSentence, wholeToolDenyRulesCovering, withRuleReason } from '../ruleReason.js'
import { createPermissionRequestMessage, ORG_ASK_REASON } from './requestMessage.js'
import {
  getAskRuleForTool,
  getDenyRuleForTool,
  toolAlwaysAllowedRule,
} from './rules.js'
import { passedOverAs } from '../../../platform/errors/passedOver.js'

type DecisionPorts = {
  isToolKilled: (tool: Tool, agentType?: string) => boolean
  resolveToolVerdict: (
    tool: Tool,
    input: Record<string, unknown>,
    context: ToolUseContext,
  ) => Promise<PermissionResult>
}

export const defaultDecisionPorts: DecisionPorts = {
  isToolKilled,
  resolveToolVerdict: async (tool, input, context) => {
    const parsed = tool.inputSchema.safeParse(input)
    if (parsed.success) {
      return tool.checkPermissions(parsed.data, context)
    }
    const verdict = await tool.checkPermissions(input, context)
    if (verdict.behavior === 'ask' || verdict.behavior === 'deny') {
      return verdict
    }
    throw parsed.error
  },
}

interface DecisionOutcome<D> {
  decision: D
  trace: DecisionTrace
}

type ComposedInstructions = readonly LoadedInstructionEntry[]

let composedFrom: Promise<ComposedInstructions> | undefined
let composing: Promise<void> | undefined

function composedInstructionImportsRead(): Promise<void> | undefined {
  const loaded = peekLoadedInstructions()
  if (loaded === undefined || loaded === composedFrom) return composing
  composedFrom = loaded
  const reading: Promise<void> = loaded
    .then(
      entries => noteComposedInstructionImports(entries.filter(entry => entry.parent !== undefined).map(entry => entry.path)),
      passedOverAs(undefined),
    )
    .finally(() => {
      if (composing === reading) composing = undefined
    })
  composing = reading
  return reading
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
  return {
    decision: decision!,
    trace,
  }
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
  const initialAppState = context.getAppState()
  const initialPermissionContext = initialAppState.toolPermissionContext
  const initialMode = initialPermissionContext.mode
  const stages: DecisionStageRecord[] = []

  const recordPass = (stage: DecisionStageId, note?: string): void => {
    stages.push(note ? { stage, outcome: 'pass', note } : { stage, outcome: 'pass' })
  }

  const decideAt = (
    stage: DecisionStageId,
    decision: PermissionDecision,
    note?: string,
  ): { decision: PermissionDecision; trace: DecisionTrace } => {
    stages.push(note ? { stage, outcome: 'decided', note } : { stage, outcome: 'decided' })
    return {
      decision,
      trace: {
        entry,
        toolName: tool.name,
        mode: initialMode,
        stages,
        decidedBy: stage,
      },
    }
  }

  if (entry === 'full') {
    if (context.abortController.signal.aborted) {
      throw new AbortError()
    }
    if (ports.isToolKilled(tool, context.agentType)) {
      return decideAt('killSwitch', {
        behavior: 'deny',
        message: `Permission to use ${tool.name} has been denied: capability switched off by operator.`,
        decisionReason: {
          type: 'other',
          reason: `Capability '${tool.name}' has been switched off for this agent by the operator.`,
        },
      })
    }
    recordPass('killSwitch')
  }

  const denyRule = getDenyRuleForTool(initialPermissionContext, tool)
  if (denyRule) {
    const said = withRuleReason(initialPermissionContext, denyRule, () =>
      wholeToolDenyRulesCovering(initialPermissionContext, tool),
    )
    return decideAt('toolDenyRule', {
      behavior: 'deny',
      decisionReason: { type: 'rule', rule: said },
      message: refusalWithReason(
        ruleSentence(`Using ${tool.name}`, 'deny', said),
        said.ruleValue.reason,
      ),
    })
  }
  recordPass('toolDenyRule')

  const askRule = getAskRuleForTool(initialPermissionContext, tool)
  recordPass(
    'toolAskRule',
    askRule ? `mode: ${initialMode} — carried past the tool verdict` : undefined,
  )

  let permissionResult: PermissionResult = {
    behavior: 'passthrough',
    message: createPermissionRequestMessage(tool.name),
  }
  let verdictFailed = false
  try {
    const importsReady = composedInstructionImportsRead()
    if (importsReady !== undefined) {
      await importsReady
    }
    permissionResult = await ports.resolveToolVerdict(tool, input, context)
  } catch (error) {
    if (error instanceof AbortError || error instanceof APIUserAbortError) {
      throw error
    }
    logError(error)
    verdictFailed = true
  }
  recordPass(
    'toolVerdict',
    verdictFailed
      ? 'resolution failed — degraded to passthrough'
      : `verdict: ${permissionResult.behavior}`,
  )

  if (permissionResult.behavior === 'deny') {
    return decideAt('toolVerdictDeny', permissionResult)
  }
  recordPass('toolVerdictDeny')

  const freshAppState = context.getAppState()
  const freshPermissionContext = freshAppState.toolPermissionContext
  const freshMode = freshPermissionContext.mode
  const postureBypasses = modeBypassesPermissions(freshMode)

  if (entry === 'full') {
    if (
      tool.requiresUserInteraction?.(input) &&
      permissionResult.behavior === 'ask' &&
      !(postureBypasses && asksThePostureAnswers(permissionResult))
    ) {
      return decideAt('userInteractionAsk', permissionResult)
    }
    recordPass('userInteractionAsk')
  }

  const standDownNote = (): string => `mode: ${freshMode} — the ask stands down`

  const standDownOrPass = (
    stage: DecisionStageId,
    road: BypassedAskRoad,
    reason: PermissionDecisionReason,
  ): { decision: PermissionDecision; trace: DecisionTrace } | null => {
    if (entry === 'full') {
      return decideAt(
        stage,
        {
          behavior: 'allow',
          updatedInput: getUpdatedInputOrFallback(permissionResult, input),
          decisionReason: {
            type: 'bypassedAsk',
            mode: freshMode,
            road,
            reason,
          },
        },
        standDownNote(),
      )
    }
    recordPass(stage, standDownNote())
    return null
  }

  if (askRule) {
    const reason: PermissionDecisionReason = { type: 'rule', rule: askRule }
    if (!postureBypasses) {
      return decideAt('toolAskRuleCarried', {
        behavior: 'ask',
        decisionReason: reason,
        message: ruleSentence(`Using ${tool.name}`, 'ask', askRule),
      })
    }
    const stood = standDownOrPass('toolAskRuleCarried', 'toolAskRule', reason)
    if (stood !== null) return stood
  } else {
    recordPass('toolAskRuleCarried')
  }

  if (
    permissionResult.behavior === 'ask' &&
    permissionResult.decisionReason?.type === 'rule' &&
    permissionResult.decisionReason.rule.ruleBehavior === 'ask'
  ) {
    if (!postureBypasses) {
      return decideAt('contentAskRule', permissionResult)
    }
    const stood = standDownOrPass(
      'contentAskRule',
      'contentAskRule',
      permissionResult.decisionReason,
    )
    if (stood !== null) return stood
  } else {
    recordPass('contentAskRule')
  }

  if (tool.mcpInfo?.effectiveMaxPermission === 'ask') {
    const reason: PermissionDecisionReason = {
      type: 'other',
      reason: ORG_ASK_REASON,
    }
    if (!postureBypasses) {
      return decideAt('orgAskCeiling', {
        behavior: 'ask',
        decisionReason: reason,
        message: createPermissionRequestMessage(tool.name, reason),
      })
    }
    const stood = standDownOrPass('orgAskCeiling', 'orgAskCeiling', reason)
    if (stood !== null) return stood
  } else {
    recordPass('orgAskCeiling')
  }

  if (
    permissionResult.behavior === 'ask' &&
    permissionResult.decisionReason?.type === 'safetyCheck'
  ) {
    if (!postureBypasses) {
      return decideAt('safetyCheckAsk', permissionResult)
    }
    const stood = standDownOrPass(
      'safetyCheckAsk',
      'safetyCheckAsk',
      permissionResult.decisionReason,
    )
    if (stood !== null) return stood
  } else {
    recordPass('safetyCheckAsk')
  }

  if (entry === 'ruleSubset') {
    return {
      decision: null,
      trace: {
        entry,
        toolName: tool.name,
        mode: initialMode,
        stages,
        decidedBy: 'none',
      },
    }
  }

  if (postureBypasses) {
    return decideAt(
      'bypassPosture',
      {
        behavior: 'allow',
        updatedInput: getUpdatedInputOrFallback(permissionResult, input),
        decisionReason: { type: 'mode', mode: freshMode },
      },
      `mode: ${freshMode}`,
    )
  }
  recordPass('bypassPosture')

  const allowRule = toolAlwaysAllowedRule(freshPermissionContext, tool)
  if (allowRule) {
    return decideAt('toolAllowRule', {
      behavior: 'allow',
      updatedInput: getUpdatedInputOrFallback(permissionResult, input),
      decisionReason: { type: 'rule', rule: allowRule },
    })
  }
  recordPass('toolAllowRule')

  const finalDecision: PermissionDecision =
    permissionResult.behavior === 'passthrough'
      ? {
          ...permissionResult,
          behavior: 'ask',
          message: createPermissionRequestMessage(tool.name, permissionResult.decisionReason),
        }
      : permissionResult

  if (finalDecision.behavior === 'ask' && finalDecision.suggestions?.length) {
    logForDebugging(
      `Permission suggestions for ${tool.name}: ${jsonStringify(finalDecision.suggestions, null, 2)}`,
    )
  }

  return decideAt('resolution', finalDecision, `verdict: ${permissionResult.behavior}`)
}

function asksThePostureAnswers(verdict: PermissionAskDecision): boolean {
  const reason = verdict.decisionReason
  return reason?.type === 'safetyCheck' || (reason?.type === 'rule' && reason.rule.ruleBehavior === 'ask')
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
