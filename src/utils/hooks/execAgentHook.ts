import { randomUUID } from 'node:crypto'

import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import type { Message } from '../../types/message.js'
import { toolMatchesName, type ToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import { ALL_AGENT_DISALLOWED_TOOLS } from '../../constants/tools.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../../tools/SyntheticOutputTool/constants.js'
import { query } from '../../query.js'
import { getSessionId } from '../../bootstrap/state.js'
import { createAttachmentMessage } from '../attachments.js'
import { createAbortController } from '../abortController.js'
import { createCombinedAbortSignal } from '../combinedAbortSignal.js'
import { createUserMessage, handleMessageFromStream } from '../messages.js'
import { hasPermissionsToUseTool } from '../permissions/permissions.js'
import { sessionLightModel } from '../model/providerFrontier.js'
import { enforceSubagentModelFloor } from '../model/modelFloor.js'
import { logForDebugging } from '../debug.js'
import { asSystemPrompt } from '../systemPromptType.js'
import { getAgentTranscriptPath, getTranscriptPathForSession } from '../sessionStorage.js'
import type { HookCommand } from '../settings/types.js'
import {
  addArgumentsToPrompt,
  createStructuredOutputTool,
  hookResponseSchema,
  registerStructuredOutputEnforcement,
} from './hookHelpers.js'
import { clearSessionHooks } from './sessionHooks.js'
import type { HookResult } from './types.js'

type AgentHook = Extract<HookCommand, { type: 'agent' }>

const DEFAULT_AGENT_HOOK_TIMEOUT_MS = 60_000
const AGENT_HOOK_TURN_CAP = 50

export async function execAgentHook(
  hook: AgentHook,
  hookName: string,
  hookEvent: HookEvent,
  jsonInput: string,
  signal: AbortSignal,
  toolUseContext: ToolUseContext,
  toolUseID: string | undefined,
  messages: Message[],
  agentName?: string,
): Promise<HookResult> {
  void messages
  void agentName

  const timeoutMs = hook.timeout ? hook.timeout * 1000 : DEFAULT_AGENT_HOOK_TIMEOUT_MS
  const { signal: combinedSignal, cleanup } = createCombinedAbortSignal(signal, { timeoutMs })
  const agentAbortController = createAbortController()
  const onCombinedAbort = (): void => agentAbortController.abort()
  combinedSignal.addEventListener('abort', onCombinedAbort)
  const finish = (): void => {
    combinedSignal.removeEventListener('abort', onCombinedAbort)
    cleanup()
  }

  const resolvedToolUseId = toolUseID ?? `hook-${randomUUID()}`
  const transcriptPath = toolUseContext.agentId
    ? getAgentTranscriptPath(toolUseContext.agentId)
    : getTranscriptPathForSession(getSessionId())

  const hookAgentId = `hook-agent-${randomUUID()}`

  try {
    const tools = [
      ...(toolUseContext.options.tools ?? []).filter(
        tool =>
          !toolMatchesName(tool, SYNTHETIC_OUTPUT_TOOL_NAME) &&
          !ALL_AGENT_DISALLOWED_TOOLS.has(tool.name),
      ),
      createStructuredOutputTool(),
    ]

    const model = enforceSubagentModelFloor(hook.model ?? sessionLightModel(), 'hook-agent')

    const prompt = addArgumentsToPrompt(hook.prompt, jsonInput)
    const systemPrompt = asSystemPrompt([
      'You are verifying a stop condition in Mercury. Your task is to verify that the agent completed the given plan.',
      `The conversation transcript is available at ${transcriptPath}; read it if you need to analyse the history.`,
      'Use the available tools to inspect the codebase and verify the condition, in as few steps as possible.',
      `When done, return your result through the ${SYNTHETIC_OUTPUT_TOOL_NAME} tool: set ok to true when the condition is met, or ok to false with a reason when it is not.`,
    ])

    const transcriptReadRule = `Read(/${transcriptPath})`

    const getAppState = (): ReturnType<ToolUseContext['getAppState']> => {
      const state = toolUseContext.getAppState()
      const permissionContext = state.toolPermissionContext as ToolPermissionContext
      const layered: ToolPermissionContext = {
        ...permissionContext,
        mode: 'dontAsk',
        alwaysAllowRules: {
          ...permissionContext.alwaysAllowRules,
          session: [...(permissionContext.alwaysAllowRules.session ?? []), transcriptReadRule],
        },
      }
      return { ...state, toolPermissionContext: layered }
    }

    const childContext = {
      ...toolUseContext,
      agentId: hookAgentId,
      abortController: agentAbortController,
      getAppState,
      options: {
        ...toolUseContext.options,
        tools,
        mainLoopModel: model,
        isNonInteractiveSession: true,
        thinkingConfig: { type: 'disabled' },
      },
      setInProgressToolUseIDs: () => {},
    } as unknown as ToolUseContext

    registerStructuredOutputEnforcement(toolUseContext.setAppState, hookAgentId)

    let assistantTurns = 0
    let verdict: { ok: boolean; reason?: string } | undefined

    const stream = query({
      messages: [createUserMessage({ content: prompt })],
      systemPrompt,
      userContext: {},
      systemContext: {},
      toolUseContext: childContext,
      canUseTool: hasPermissionsToUseTool,
      querySource: 'hook_agent',
    })

    for await (const streamed of stream) {
      handleMessageFromStream(
        streamed,
        toolUseContext.setStreamMode ?? (() => {}),
        newContent => toolUseContext.setResponseLength?.(prev => prev + newContent.length),
        () => {},
        () => {},
      )
      if (!('type' in streamed) || (streamed.type !== 'assistant' && streamed.type !== 'attachment')) continue

      if (streamed.type === 'assistant') {
        assistantTurns += 1
        if (assistantTurns >= AGENT_HOOK_TURN_CAP) {
          agentAbortController.abort()
          break
        }
        continue
      }

      const attachment = (streamed as { attachment?: { type?: string; data?: unknown } }).attachment
      if (attachment?.type === 'structured_output') {
        const parsed = hookResponseSchema().safeParse(attachment.data)
        if (parsed.success) {
          verdict = parsed.data
          agentAbortController.abort()
          break
        }
      }
    }

    clearSessionHooks(toolUseContext.setAppState, hookAgentId)

    if (!verdict) {
      logForDebugging(`agent hook ${hookName} produced no structured output — cancelled`)
      finish()
      return { outcome: 'cancelled', hook }
    }

    if (!verdict.ok) {
      finish()
      return {
        blockingError: {
          blockingError: `Agent hook condition was not met: ${verdict.reason}`,
          command: hook.prompt,
        },
        outcome: 'blocking',
        hook,
      }
    }

    finish()
    return {
      message: createAttachmentMessage({
        type: 'hook_success',
        hookName,
        toolUseID: resolvedToolUseId,
        hookEvent,
        content: '',
      }),
      outcome: 'success',
      hook,
    }
  } catch (error) {
    finish()
    if (combinedSignal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      return { outcome: 'cancelled', hook }
    }
    return {
      message: createAttachmentMessage({
        type: 'hook_non_blocking_error',
        hookName,
        toolUseID: resolvedToolUseId,
        hookEvent,
        stderr: `Error executing agent hook: ${error instanceof Error ? error.message : String(error)}`,
        stdout: '',
        exitCode: 1,
      }),
      outcome: 'non_blocking_error',
      hook,
    }
  }
}
