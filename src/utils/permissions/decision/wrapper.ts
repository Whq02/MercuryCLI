import { APIUserAbortError } from '../../../services/api/sdkErrors.js'
import type { Tool, ToolUseContext } from '../../../Tool.js'
import { AGENT_TOOL_NAME } from '../../../tools/AgentTool/constants.js'
import { POWERSHELL_TOOL_NAME } from '../../../tools/PowerShellTool/toolName.js'
import type { AssistantMessage } from '../../../types/message.js'
import { logForDebugging } from '../../debug.js'
import { AbortError, toError } from '../../errors.js'
import { logError } from '../../log.js'

const readOnlyAllowlistModule =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('../readOnlyAllowlist.js') as typeof import('../readOnlyAllowlist.js'))
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

import { executePermissionRequestHooks } from '../../hooks.js'
import { AUTO_REJECT_MESSAGE, DONT_ASK_REJECT_MESSAGE } from '../../messages.js'
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
import { decideRuleBasedPermissions, decideToolPermission } from './engine.js'
import type {
  DecisionTrace,
  WrapperStageId,
  WrapperStageRecord,
  WrapperTrace,
} from './trace.js'


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


export interface WrapperPorts {
  isAllowlistedTool(
    toolName: string,
    input: { action?: unknown; actions?: unknown } | null,
  ): boolean
  resolveAcceptEditsVerdict(
    tool: Tool,
    input: Record<string, unknown>,
    context: ToolUseContext,
  ): Promise<PermissionResult>
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
  isAllowlistedTool: (toolName, input) =>
    readOnlyAllowlistModule!.isReadOnlyAllowlistedTool(toolName, input),
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

    if (appState.toolPermissionContext.mode === 'flow') {
      const headless =
        appState.toolPermissionContext.shouldAvoidPermissionPrompts

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
          `Flow keeps the ask for ${tool.name}: its asks are reserved for the operator`,
        )
        return decide('powershellGuard', engineDecision, 'human ask stands')
      }
      recordPass('powershellGuard')

      if (tool.name !== AGENT_TOOL_NAME) {
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
          recordPass(
            'fastPathDangerFilter',
            'danger filter outage — fail closed; fast-path skipped',
          )
          probeContext = null
        }

        if (probeContext !== null) {
          try {
            const acceptEditsVerdict = await ports.resolveAcceptEditsVerdict(
              tool,
              input,
              probeContext,
            )
            if (acceptEditsVerdict.behavior === 'allow') {
              logForDebugging(
                `Flow allows ${tool.name}: implement mode would allow this outright`,
              )
              return decide('implementFastPath', {
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
          recordPass('implementFastPath')
        } else {
          recordPass('implementFastPath', 'skipped — danger filter outage')
        }
      } else {
        recordPass('implementFastPath')
      }

      if (
        ports.isAllowlistedTool(
          tool.name,
          input as { action?: unknown; actions?: unknown } | null,
        )
      ) {
        logForDebugging(
          `Flow allows ${tool.name}: the read-only tool set`,
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
