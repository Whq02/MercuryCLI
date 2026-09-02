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

/**
 * Executor for `agent`-type hooks: a bounded, multi-turn, tool-using
 * subagent that returns a met / not-met verdict through the structured
 * output tool.
 *
 * The `messages` parameter is retained for signature stability with the
 * sibling executors and is unused; `agentName` likewise.
 */
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
  // The combined timeout aborts a DEDICATED controller so the agent's own
  // abort path stays distinct from the caller's.
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

  // A hook-agent-prefixed id keeps this agent identifiable in logs and
  // transcripts, and scopes its session hooks away from the caller's.
  const hookAgentId = `hook-agent-${randomUUID()}`

  try {
    // The session's tools, minus any pre-existing synthetic structured-output
    // tool (two same-named tools with different schemas otherwise, when the
    // parent already carries one from a schema flag), minus the tools
    // disallowed for agents (a stop-hook agent must not spawn further
    // subagents or enter plan mode), plus the fresh verdict tool.
    const tools = [
      ...(toolUseContext.options.tools ?? []).filter(
        tool =>
          !toolMatchesName(tool, SYNTHETIC_OUTPUT_TOOL_NAME) &&
          !ALL_AGENT_DISALLOWED_TOOLS.has(tool.name),
      ),
      createStructuredOutputTool(),
    ]

    // This path calls the query engine directly, so the never-lightweight
    // subagent floor must be applied here at the seam rather than inherited.
    // The default is the SESSION FAMILY's light tier (trust-combo
    // census): the old getSmallFastModel() default was a decoy — the
    // floor rewrote it to the Anthropic mid tier on every family, so a
    // non-Anthropic session's hook agent dialled a wire it may hold no
    // credential for. sessionLightModel answers the same Anthropic id the
    // floor named (unchanged there) and the family's own light tier — or
    // the session's model — elsewhere; the query engine routes it to its
    // own provider runtime. The floor stays armed for explicit hook.model
    // picks.
    const model = enforceSubagentModelFloor(hook.model ?? sessionLightModel(), 'hook-agent')

    const prompt = addArgumentsToPrompt(hook.prompt, jsonInput)
    const systemPrompt = asSystemPrompt([
      'You are verifying a stop condition in Mercury. Your task is to verify that the agent completed the given plan.',
      `The conversation transcript is available at ${transcriptPath}; read it if you need to analyse the history.`,
      'Use the available tools to inspect the codebase and verify the condition, in as few steps as possible.',
      `When done, return your result through the ${SYNTHETIC_OUTPUT_TOOL_NAME} tool: set ok to true when the condition is met, or ok to false with a reason when it is not.`,
    ])

    // The self-granted transcript read: a literal `/` immediately followed
    // by the absolute path (two leading slashes total) — the matcher strips
    // one and the residual absolute pattern matches the transcript file.
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
      // The standard permission checker: the agent hook drives the engine
      // directly with the same checker the main transaction uses.
      canUseTool: hasPermissionsToUseTool,
      querySource: 'hook_agent',
    })

    for await (const streamed of stream) {
      // Forward everything to the shared stream handler so the spinner's
      // response length advances; stream events and request-start markers
      // are skipped for further processing.
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
        // The cap aborts the moment it is reached, so the 50th turn is the
        // last one that starts. Cancelled with only a debug log — no
        // user-visible error.
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

    // Normal completion clears the hook agent's WHOLE session-hook entry
    // (keyed by the hook agent id); the throwing path deliberately does not.
    clearSessionHooks(toolUseContext.setAppState, hookAgentId)

    if (!verdict) {
      // Whether the cause was the turn cap or the agent finishing without
      // calling the tool.
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
