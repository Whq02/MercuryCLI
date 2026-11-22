import { APIUserAbortError } from '../../api/sdkErrors.js'
import type { Tool, ToolUseContext } from '../../../Tool.js'
import { AbortError } from '../../errors.js'
import { logForDebugging } from '../../debug.js'
import { logError } from '../../log.js'
import { jsonStringify } from '../../slowOperations.js'
import { peekLoadedInstructions, type LoadedInstructionEntry } from './loadedInstructionsPeek.js'
import { isToolKilled } from '../capabilityGate.js'
import { noteComposedInstructionImports } from '../filesystem.js'
import { modeBypassesPermissions } from '../PermissionMode.js'
import type {
  PermissionAskDecision,
  PermissionDecision,
  PermissionDecisionReason,
  PermissionDenyDecision,
  PermissionResult,
} from '../PermissionResult.js'
import type { BypassedAskRoad, DecisionEntry, DecisionStageId, DecisionStageRecord, DecisionTrace, PermissionMode } from '../../../types/permissions.js'
import { refusalWithReason, ruleSentence, wholeToolDenyRulesCovering, withRuleReason } from '../ruleReason.js'
import { createPermissionRequestMessage, ORG_ASK_REASON } from './requestMessage.js'
import {
  getAskRuleForTool,
  getDenyRuleForTool,
  toolAlwaysAllowedRule,
} from './rules.js'
import { passedOverAs } from '../../passedOver.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../../pi/holes.js'

type DecisionPorts = Unbuilt

export const defaultDecisionPorts: DecisionPorts = unbuilt('src/utils/permissions/decision/engine.ts:37')

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

export function postureBypassesAsks(permissionContext: {
  mode: PermissionMode
  isBypassPermissionsModeAvailable?: boolean
}): boolean {
  return notBuilt('src/utils/permissions/decision/engine.ts:74')
}

export async function decideToolPermission(
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
  ports?: DecisionPorts,
): Promise<DecisionOutcome<PermissionDecision>> {
  return notBuilt('src/utils/permissions/decision/engine.ts:81')
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
  return notBuilt('src/utils/permissions/decision/engine.ts:118')
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
