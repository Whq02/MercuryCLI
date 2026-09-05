import { APIUserAbortError } from '../../../services/api/sdkErrors.js'
import type { Tool, ToolPermissionContext, ToolUseContext } from '../../../Tool.js'
import { AGENT_TOOL_NAME } from '../../../tools/AgentTool/constants.js'
import { POWERSHELL_TOOL_NAME } from '../../../tools/PowerShellTool/toolName.js'
import { REPL_TOOL_NAME } from '../../../tools/REPLTool/constants.js'
import type { AssistantMessage } from '../../../types/message.js'
import { logForDebugging } from '../../debug.js'
import { AbortError, toError } from '../../errors.js'
import { logError } from '../../log.js'

const classifierDecisionModule =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('../classifierDecision.js') as typeof import('../classifierDecision.js'))
const autoModeStateModule =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('../autoModeState.js') as typeof import('../autoModeState.js'))
const workflowModule = {
  WORKFLOW_TOOL_NAME: (
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../../../tools/WorkflowTool/constants.js') as typeof import('../../../tools/WorkflowTool/constants.js')
  ).WORKFLOW_TOOL_NAME,
  dynamicWorkflowsEnabled: (
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../../../tools/WorkflowTool/workflowEnablement.js') as typeof import('../../../tools/WorkflowTool/workflowEnablement.js')
  ).dynamicWorkflowsEnabled,
}
const permissionSetupModule =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('../permissionSetup.js') as typeof import('../permissionSetup.js'))
const permissionRuleParserModule =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('../permissionRuleParser.js') as typeof import('../permissionRuleParser.js'))

import { addToTurnClassifierDuration } from '../../../bootstrap/state.js'
import { getFeatureValue_CACHED_WITH_REFRESH } from '../../../services/analytics/featureGates.js'
import {
  clearClassifierChecking,
  setClassifierChecking,
} from '../../classifierApprovals.js'
import { executePermissionRequestHooks } from '../../hooks.js'
import {
  AUTO_REJECT_MESSAGE,
  buildClassifierUnavailableMessage,
  buildClassifierUnreadableMessage,
  buildFlowBlockDeclinedMessage,
  buildYoloRejectionMessage,
  DONT_ASK_REJECT_MESSAGE,
} from '../../messages.js'
import {
  createDenialTrackingState,
  DENIAL_LIMITS,
  type DenialTrackingState,
  recordDenial,
  recordSuccess,
  shouldFallbackToPrompting,
} from '../denialTracking.js'
import {
  operatorDeclinedFlowBlockThisTurn,
  writeDenialState,
} from '../flowBlockReview.js'
import type {
  PermissionAskDecision,
  PermissionDecision,
  PermissionDecisionReason,
  PermissionDenyDecision,
  PermissionResult,
} from '../PermissionResult.js'
import {
  applyPermissionUpdates,
  persistPermissionUpdates,
} from '../PermissionUpdate.js'
import type { PermissionUpdate } from '../PermissionUpdateSchema.js'
import {
  classifyYoloActionWithFallback,
  formatActionForClassifier,
  type TranscriptEntry,
} from '../yoloClassifier.js'
import { decideRuleBasedPermissions, decideToolPermission } from './engine.js'
import type {
  DecisionTrace,
  WrapperStageId,
  WrapperStageRecord,
  WrapperTrace,
} from './trace.js'

const IRON_GATE_REFRESH_MS = 30 * 60 * 1000


function reasonCarriesAskRule(
  reason: PermissionDecisionReason | undefined,
): boolean {
  if (reason === undefined) return false
  if (reason.type === 'rule') return reason.rule.ruleBehavior === 'ask'
  if (reason.type !== 'subcommandResults') return false
  for (const sub of reason.reasons.values()) {
    if (sub.behavior === 'ask' && reasonCarriesAskRule(sub.decisionReason)) {
      return true
    }
  }
  return false
}

function reasonIsPlanFloor(
  reason: PermissionDecisionReason | undefined,
): boolean {
  return reason?.type === 'mode' && reason.mode === 'strategy'
}

function workflowRequiresConsent(toolName: string): boolean {
  return (
    workflowModule != null &&
    toolName === workflowModule.WORKFLOW_TOOL_NAME &&
    workflowModule.dynamicWorkflowsEnabled()
  )
}


export function guardHookUpdatedInput(
  recheckedDecision:
    | PermissionAskDecision
    | PermissionDenyDecision
    | PermissionDecision
    | null,
  toolName: string,
): PermissionAskDecision | PermissionDenyDecision | null {
  if (
    recheckedDecision?.behavior === 'deny' ||
    recheckedDecision?.behavior === 'ask'
  ) {
    logError(
      new Error(
        `PermissionRequest hook allowed ${toolName} with updatedInput, but a ${recheckedDecision.behavior} rule overrides: ${recheckedDecision.message}`,
      ),
    )
    return recheckedDecision
  }
  return null
}


async function consultHeadlessPermissionHooks(
  tool: Tool,
  input: { [key: string]: unknown },
  toolUseID: string,
  context: ToolUseContext,
  permissionMode: string | undefined,
  suggestions: PermissionUpdate[] | undefined,
): Promise<PermissionDecision | null> {
  try {
    for await (const hookResult of executePermissionRequestHooks(
      tool.name,
      toolUseID,
      input,
      context,
      permissionMode,
      suggestions,
      context.abortController.signal,
    )) {
      const verdict = hookResult.permissionRequestResult
      if (verdict === undefined) continue

      if (verdict.behavior === 'deny') {
        if (verdict.interrupt) {
          logForDebugging(
            `Hook interrupt: tool=${tool.name} hookMessage=${verdict.message}`,
          )
          context.abortController.abort()
        }
        return {
          behavior: 'deny',
          message: verdict.message || 'A PermissionRequest hook denied this action',
          decisionReason: {
            type: 'hook',
            hookName: 'PermissionRequest',
            reason: verdict.message,
          },
        }
      }

      if (verdict.behavior !== 'allow') continue

      const finalInput = verdict.updatedInput ?? input

      if (verdict.updatedInput) {
        const recheck = await decideRuleBasedPermissions(tool, finalInput, context)
        const override = guardHookUpdatedInput(recheck.decision, tool.name)
        if (override) {
          if (override.behavior === 'ask') {
            return {
              behavior: 'deny',
              message: override.message,
              decisionReason: override.decisionReason ?? {
                type: 'other',
                reason: 'ask rule on hook-rewritten input',
              },
            }
          }
          return override
        }
      }

      if (verdict.updatedPermissions?.length) {
        persistPermissionUpdates(verdict.updatedPermissions)
        context.setAppState(prev => ({
          ...prev,
          toolPermissionContext: applyPermissionUpdates(
            prev.toolPermissionContext,
            verdict.updatedPermissions!,
          ),
        }))
      }
      return {
        behavior: 'allow',
        updatedInput: finalInput,
        decisionReason: {
          type: 'hook',
          hookName: 'PermissionRequest',
        },
      }
    }
  } catch (error) {
    logError(
      new Error('PermissionRequest hook machinery failed in a prompt-less session', {
        cause: toError(error),
      }),
    )
  }
  return null
}


function ledgerReviewWarning(denialState: DenialTrackingState): string {
  const hitTotalLimit = denialState.totalDenials >= DENIAL_LIMITS.maxTotal
  return hitTotalLimit
    ? `${denialState.totalDenials} actions were blocked this session — review the transcript before continuing.`
    : `${denialState.consecutiveDenials} consecutive actions were blocked — review the transcript before continuing.`
}

function settleLedgerAtLimit(
  denialState: DenialTrackingState,
  context: ToolUseContext,
): void {
  if (denialState.totalDenials >= DENIAL_LIMITS.maxTotal) {
    writeDenialState(context, {
      ...denialState,
      totalDenials: 0,
      consecutiveDenials: 0,
    })
  }
}

function denialLedgerReview(
  denialState: DenialTrackingState,
  context: ToolUseContext,
): string | null {
  if (!shouldFallbackToPrompting(denialState)) return null
  const warning = ledgerReviewWarning(denialState)
  settleLedgerAtLimit(denialState, context)
  return warning
}

function denialCapFallback(
  denialState: DenialTrackingState,
  appState: {
    toolPermissionContext: { shouldAvoidPermissionPrompts?: boolean }
  },
  blockedReason: string,
  engineAsk: PermissionDecision,
  context: ToolUseContext,
): PermissionDecision | null {
  if (!shouldFallbackToPrompting(denialState)) {
    return null
  }

  if (appState.toolPermissionContext.shouldAvoidPermissionPrompts) {
    throw new AbortError(
      'Run aborted: flow-classifier denial limit reached with no prompt available',
    )
  }

  const warning = ledgerReviewWarning(denialState)
  logForDebugging(
    `Flow-classifier denial limit tripped — handing the next decision to the operator: ${warning}`,
    { level: 'warn' },
  )
  settleLedgerAtLimit(denialState, context)

  const originalClassifier =
    engineAsk.decisionReason?.type === 'classifier'
      ? engineAsk.decisionReason.classifier
      : 'auto-mode'

  return {
    ...engineAsk,
    decisionReason: {
      type: 'classifier',
      classifier: originalClassifier,
      reason: `${warning}\n\nLatest blocked action: ${blockedReason}`,
    },
  }
}


function hideDangerousAllowsFromView(context: ToolUseContext): {
  viewContext: ToolUseContext
  hiddenCount: number
} {
  const allowLayers = context.getAppState().toolPermissionContext.alwaysAllowRules
  if (!allowLayers) return { viewContext: context, hiddenCount: 0 }

  const isDangerousEntry = (entry: string): boolean => {
    const { toolName, ruleContent } =
      permissionRuleParserModule.permissionRuleValueFromString(entry)
    return (
      permissionSetupModule.isDangerousBashPermission(toolName, ruleContent) ||
      permissionSetupModule.isDangerousPowerShellPermission(toolName, ruleContent) ||
      permissionSetupModule.isDangerousTaskPermission(toolName, ruleContent)
    )
  }

  let hiddenCount = 0
  const trimmedLayers: {
    -readonly [K in keyof typeof allowLayers]?: (typeof allowLayers)[K]
  } = {}
  for (const source of Object.keys(allowLayers) as Array<keyof typeof allowLayers>) {
    const entries = allowLayers[source]
    if (!entries) continue
    const kept = entries.filter(entry => {
      if (!isDangerousEntry(entry)) return true
      hiddenCount++
      return false
    })
    if (kept.length !== entries.length) trimmedLayers[source] = kept
  }
  if (hiddenCount === 0) return { viewContext: context, hiddenCount: 0 }

  const viewContext: ToolUseContext = {
    ...context,
    getAppState: () => {
      const live = context.getAppState()
      return {
        ...live,
        toolPermissionContext: {
          ...live.toolPermissionContext,
          alwaysAllowRules: { ...allowLayers, ...trimmedLayers },
        },
      }
    },
  }
  return { viewContext, hiddenCount }
}


export type WrapperClassifierResult = Awaited<
  ReturnType<typeof classifyYoloActionWithFallback>
>

export interface WrapperPorts {
  isAutoModeActive(): boolean
  isAllowlistedTool(
    toolName: string,
    input: { action?: unknown; actions?: unknown } | null,
  ): boolean
  resolveAcceptEditsVerdict(
    tool: Tool,
    input: Record<string, unknown>,
    context: ToolUseContext,
  ): Promise<PermissionResult>
  classify(
    context: ToolUseContext,
    action: TranscriptEntry,
    permissionContext: ToolPermissionContext,
    signal: AbortSignal,
  ): Promise<WrapperClassifierResult>
  ironGateClosed(): boolean
  runHeadlessHooks(
    tool: Tool,
    input: { [key: string]: unknown },
    toolUseID: string,
    context: ToolUseContext,
    permissionMode: string | undefined,
    suggestions: PermissionUpdate[] | undefined,
  ): Promise<PermissionDecision | null>
}

export const defaultWrapperPorts: WrapperPorts = {
  isAutoModeActive: () => autoModeStateModule?.isAutoModeActive() ?? false,
  isAllowlistedTool: (toolName, input) =>
    classifierDecisionModule!.isAutoModeAllowlistedTool(toolName, input),
  resolveAcceptEditsVerdict: async (tool, input, context) => {
    const parsedInput = tool.inputSchema.parse(input)
    const probeContext: ToolUseContext = {
      ...context,
      getAppState: () => {
        const live = context.getAppState()
        return {
          ...live,
          toolPermissionContext: {
            ...live.toolPermissionContext,
            mode: 'implement' as const,
          },
        }
      },
    }
    return tool.checkPermissions(parsedInput, probeContext)
  },
  classify: (context, action, permissionContext, signal) =>
    classifyYoloActionWithFallback(
      context.messages,
      action,
      context.options.tools,
      permissionContext,
      signal,
    ),
  ironGateClosed: () =>
    getFeatureValue_CACHED_WITH_REFRESH(
      'mercury_iron_gate_closed',
      true,
      IRON_GATE_REFRESH_MS,
    ),
  runHeadlessHooks: consultHeadlessPermissionHooks,
}

export interface FullDecisionOutcome {
  decision: PermissionDecision
  engineTrace: DecisionTrace
  wrapper: WrapperTrace
}


export async function decideToolPermissionWithModes(
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
  assistantMessage: AssistantMessage,
  toolUseID: string,
  ports: WrapperPorts = defaultWrapperPorts,
): Promise<FullDecisionOutcome> {
  void assistantMessage
  const engineOutcome = await decideToolPermission(tool, input, context)
  const engineDecision = engineOutcome.decision
  const engineTrace = engineOutcome.trace

  const stageLog: WrapperStageRecord[] = []
  const recordPass = (stage: WrapperStageId, note?: string): void => {
    stageLog.push(
      note ? { stage, outcome: 'pass', note } : { stage, outcome: 'pass' },
    )
  }
  const decide = (
    stage: WrapperStageId,
    decision: PermissionDecision,
    note?: string,
  ): FullDecisionOutcome => {
    stageLog.push(
      note ? { stage, outcome: 'decided', note } : { stage, outcome: 'decided' },
    )
    return { decision, engineTrace, wrapper: { stages: stageLog, decidedBy: stage } }
  }
  const passThrough = (decision: PermissionDecision): FullDecisionOutcome => ({
    decision,
    engineTrace,
    wrapper: { stages: stageLog, decidedBy: 'engine' },
  })

  if (engineDecision.behavior === 'allow') {
    const appState = context.getAppState()
    const currentDenialState =
      context.localDenialTracking ?? appState.denialTracking
    if (
      appState.toolPermissionContext.mode === 'flow' &&
      currentDenialState &&
      currentDenialState.consecutiveDenials > 0
    ) {
      writeDenialState(context, recordSuccess(currentDenialState))
      recordPass('allowDenialReset', 'denial streak reset on allow')
    }
    return passThrough(engineDecision)
  }

  if (engineDecision.behavior === 'ask') {
    const appState = context.getAppState()

    if (appState.toolPermissionContext.mode === 'dontAsk') {
      return decide('dontAskConversion', {
        behavior: 'deny',
        decisionReason: {
          type: 'mode',
          mode: 'dontAsk',
        },
        message: DONT_ASK_REJECT_MESSAGE(tool.name),
      })
    }

    if (
      appState.toolPermissionContext.mode === 'flow' ||
      (appState.toolPermissionContext.mode === 'strategy' &&
        ports.isAutoModeActive())
    ) {
      const headless =
        appState.toolPermissionContext.shouldAvoidPermissionPrompts
      const cardAvailable =
        !headless && context.options.isNonInteractiveSession !== true

      if (
        engineDecision.decisionReason?.type === 'safetyCheck' &&
        !engineDecision.decisionReason.classifierApprovable
      ) {
        if (headless) {
          return decide(
            'autoSafetyImmunity',
            {
              behavior: 'deny',
              message: engineDecision.message,
              decisionReason: {
                type: 'asyncAgent',
                reason:
                  'This safety check needs interactive approval, and this session cannot present a prompt',
              },
            },
            'headless — structured deny',
          )
        }
        return decide('autoSafetyImmunity', engineDecision, 'human ask stands')
      }
      recordPass('autoSafetyImmunity')

      if (tool.requiresUserInteraction?.()) {
        return decide('autoUserInteraction', engineDecision)
      }
      recordPass('autoUserInteraction')

      const floorTags: string[] = []
      if (reasonCarriesAskRule(engineDecision.decisionReason)) {
        floorTags.push('ask-rule')
      }
      if (tool.mcpInfo?.effectiveMaxPermission === 'ask') {
        floorTags.push('org-ceiling')
      }
      if (reasonIsPlanFloor(engineDecision.decisionReason)) {
        floorTags.push('plan-floor')
      }
      if (workflowRequiresConsent(tool.name)) {
        floorTags.push('workflow-consent')
      }
      if (floorTags.length > 0) {
        if (headless) {
          return decide(
            'autoFloors',
            {
              behavior: 'deny',
              message: engineDecision.message,
              decisionReason: {
                type: 'asyncAgent',
                reason:
                  'This action needs interactive approval, and this session cannot present a prompt',
              },
            },
            'headless — structured deny',
          )
        }
        return decide('autoFloors', engineDecision, floorTags.join('+'))
      }
      recordPass('autoFloors')

      const denialState =
        context.localDenialTracking ??
        appState.denialTracking ??
        createDenialTrackingState()

      if (tool.name === POWERSHELL_TOOL_NAME) {
        if (headless) {
          return decide(
            'powershellGuard',
            {
              behavior: 'deny',
              message: 'PowerShell runs only with interactive approval',
              decisionReason: {
                type: 'asyncAgent',
                reason:
                  'PowerShell runs only with interactive approval, and this session cannot present a prompt',
              },
            },
            'headless — structured deny',
          )
        }
        logForDebugging(
          `Flow classifier not consulted for ${tool.name}: its asks are reserved for the operator`,
        )
        return decide('powershellGuard', engineDecision, 'human ask stands')
      }
      recordPass('powershellGuard')

      if (tool.name !== AGENT_TOOL_NAME && tool.name !== REPL_TOOL_NAME) {
        let probeContext: ToolUseContext | null = context
        try {
          const view = hideDangerousAllowsFromView(context)
          probeContext = view.viewContext
          recordPass(
            'fastPathDangerFilter',
            view.hiddenCount > 0
              ? `${view.hiddenCount} dangerous prefix-allow rule(s) hidden from fast-path view`
              : undefined,
          )
        } catch {
          if (ports.ironGateClosed()) {
            recordPass(
              'fastPathDangerFilter',
              'danger classifier outage — fail closed; fast-path skipped',
            )
            probeContext = null
          } else {
            recordPass(
              'fastPathDangerFilter',
              'danger classifier outage — fail open; unfiltered view',
            )
            probeContext = context
          }
        }

        if (probeContext !== null) {
          try {
            const acceptEditsVerdict = await ports.resolveAcceptEditsVerdict(
              tool,
              input,
              probeContext,
            )
            if (acceptEditsVerdict.behavior === 'allow') {
              writeDenialState(context, recordSuccess(denialState))
              logForDebugging(
                `Flow classifier skipped for ${tool.name}: implement mode would allow this outright`,
              )
              return decide('acceptEditsFastPath', {
                behavior: 'allow',
                updatedInput: acceptEditsVerdict.updatedInput ?? input,
                decisionReason: {
                  type: 'mode',
                  mode: 'flow',
                },
              })
            }
          } catch (e) {
            if (e instanceof AbortError || e instanceof APIUserAbortError) {
              throw e
            }
          }
          recordPass('acceptEditsFastPath')
        } else {
          recordPass('acceptEditsFastPath', 'skipped — danger filter outage')
        }
      } else {
        recordPass('acceptEditsFastPath')
      }

      if (
        ports.isAllowlistedTool(
          tool.name,
          input as { action?: unknown; actions?: unknown } | null,
        )
      ) {
        writeDenialState(context, recordSuccess(denialState))
        logForDebugging(
          `Flow classifier skipped for ${tool.name}: always-safe tool set membership`,
        )
        return decide('allowlistFastPath', {
          behavior: 'allow',
          updatedInput: input,
          decisionReason: {
            type: 'mode',
            mode: 'flow',
          },
        })
      }
      recordPass('allowlistFastPath')

      const action = formatActionForClassifier(tool.name, input)
      setClassifierChecking(toolUseID)
      let classifierResult
      try {
        classifierResult = await ports.classify(
          context,
          action,
          appState.toolPermissionContext,
          context.abortController.signal,
        )
      } finally {
        clearClassifierChecking(toolUseID)
      }

      if (classifierResult.durationMs !== undefined) {
        addToTurnClassifierDuration(classifierResult.durationMs)
      }

      if (classifierResult.shouldBlock) {
        if (classifierResult.transcriptTooLong) {
          if (appState.toolPermissionContext.shouldAvoidPermissionPrompts) {
            throw new AbortError(
              "Run aborted: the flow classifier's transcript outgrew its context window with no prompt available",
            )
          }
          logForDebugging(
            'Flow classifier transcript over the window — handing the ask back to the operator path',
            { level: 'warn' },
          )
          return decide(
            'classifier',
            {
              ...engineDecision,
              decisionReason: {
                type: 'other',
                reason:
                  "The flow classifier's transcript outgrew its context window — this approval returns to you",
              },
            },
            'transcript too long — manual fallback',
          )
        }

        if (classifierResult.unavailable) {
          if (!headless) {
            logForDebugging(
              'Flow classifier unavailable, falling back to the human ask (interactive)',
              { level: 'warn' },
            )
            return decide(
              'classifier',
              {
                ...engineDecision,
                decisionReason: {
                  type: 'other',
                  reason:
                    'Flow classifier unavailable — falling back to manual approval',
                },
              },
              'unavailable — human ask',
            )
          }
          if (ports.ironGateClosed()) {
            logForDebugging(
              'Flow classifier unreachable — iron gate closed; denying with retry guidance',
              { level: 'warn' },
            )
            return decide(
              'classifier',
              {
                behavior: 'deny',
                decisionReason: {
                  type: 'classifier',
                  classifier: 'auto-mode',
                  reason: 'Classifier unavailable',
                },
                message: buildClassifierUnavailableMessage(
                  tool.name,
                  classifierResult.model,
                ),
              },
              'unavailable — fail closed',
            )
          }
          logForDebugging(
            'Flow classifier unreachable — iron gate open; the ask returns to the operator path',
            { level: 'warn' },
          )
          return decide('classifier', engineDecision, 'unavailable — fail open')
        }

        if (classifierResult.unreadable) {
          const model = classifierResult.model
          const detail = classifierResult.verdictIssues?.join('; ')
          if (cardAvailable) {
            logForDebugging(
              `Flow classifier verdict unreadable (${model}) — handing the ask to the operator`,
              { level: 'warn' },
            )
            return decide(
              'classifier',
              {
                ...engineDecision,
                decisionReason: {
                  type: 'other',
                  reason: `Flow's safety check could not read its verdict from ${model}${detail ? ` (${detail})` : ''} — this approval returns to you`,
                },
              },
              'unreadable verdict — human ask',
            )
          }
          if (ports.ironGateClosed()) {
            logForDebugging(
              `Flow classifier verdict unreadable (${model}) — iron gate closed; denying without a policy verdict`,
              { level: 'warn' },
            )
            return decide(
              'classifier',
              {
                behavior: 'deny',
                decisionReason: {
                  type: 'classifier',
                  classifier: 'auto-mode',
                  reason: `Classifier verdict unreadable (${model})`,
                },
                message: buildClassifierUnreadableMessage(tool.name, model, detail),
              },
              'unreadable verdict — fail closed',
            )
          }
          logForDebugging(
            `Flow classifier verdict unreadable (${model}) — iron gate open; the ask returns to the operator path`,
            { level: 'warn' },
          )
          return decide('classifier', engineDecision, 'unreadable verdict — fail open')
        }

        const afterDenial = recordDenial(denialState)
        writeDenialState(context, afterDenial)

        logForDebugging(
          `Flow classifier verdict: blocked — ${classifierResult.reason}`,
          { level: 'warn' },
        )

        if (!cardAvailable) {
          const capFallback = denialCapFallback(
            afterDenial,
            appState,
            classifierResult.reason,
            engineDecision,
            context,
          )
          if (capFallback) {
            recordPass('classifier', 'blocked — denial limit reached')
            return decide('denialLimit', capFallback, 'fall back to prompting')
          }

          return decide(
            'classifier',
            {
              behavior: 'deny',
              decisionReason: {
                type: 'classifier',
                classifier: 'auto-mode',
                reason: classifierResult.reason,
              },
              message: buildYoloRejectionMessage(classifierResult.reason),
            },
            'blocked — no consent card in this session',
          )
        }

        if (operatorDeclinedFlowBlockThisTurn(context, tool.name, input)) {
          return decide(
            'classifier',
            {
              behavior: 'deny',
              decisionReason: {
                type: 'classifier',
                classifier: 'auto-mode',
                reason: classifierResult.reason,
              },
              message: buildFlowBlockDeclinedMessage(classifierResult.reason),
            },
            'blocked — the operator declined this action earlier this turn',
          )
        }

        const review = denialLedgerReview(afterDenial, context)
        const askForOperator: PermissionDecision = {
          ...engineDecision,
          decisionReason: {
            type: 'classifier',
            classifier: 'auto-mode',
            reason: review
              ? `${classifierResult.reason}\n\n${review}`
              : classifierResult.reason,
          },
        }
        if (review) {
          recordPass('classifier', 'blocked — denial limit reached')
          return decide(
            'denialLimit',
            askForOperator,
            'the operator is asked, with the review warning',
          )
        }
        return decide('classifier', askForOperator, 'blocked — the operator is asked')
      }

      writeDenialState(context, recordSuccess(denialState))

      return decide(
        'classifier',
        {
          behavior: 'allow',
          updatedInput: input,
          decisionReason: {
            type: 'classifier',
            classifier: 'auto-mode',
            reason: classifierResult.reason,
          },
        },
        'allowed',
      )
    }

    if (appState.toolPermissionContext.shouldAvoidPermissionPrompts) {
      const hookDecision = await ports.runHeadlessHooks(
        tool,
        input,
        toolUseID,
        context,
        appState.toolPermissionContext.mode,
        engineDecision.suggestions,
      )
      if (hookDecision) {
        return decide('headlessHooks', hookDecision)
      }
      recordPass('headlessHooks')
      return decide('headlessAutoDeny', {
        behavior: 'deny',
        decisionReason: {
          type: 'asyncAgent',
          reason: 'This session cannot present a permission prompt',
        },
        message: AUTO_REJECT_MESSAGE(tool.name),
      })
    }
  }

  return passThrough(engineDecision)
}
