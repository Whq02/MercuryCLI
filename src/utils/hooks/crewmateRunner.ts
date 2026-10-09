import { randomUUID } from 'node:crypto'
import { toolMatchesName, type ToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import { ALL_AGENT_DISALLOWED_TOOLS } from '../../constants/tools.js'
import { clearGuards } from '../../guards/guards.js'
import { registerStructuredOutputGuard } from '../../guards/structuredOutput.js'
import { query } from '../../query.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../../tools/SyntheticOutputTool/constants.js'
import { createSyntheticOutputTool } from '../../tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { createAbortController } from '../abortController.js'
import { createCombinedAbortSignal } from '../combinedAbortSignal.js'
import { errorMessage } from '../errors.js'
import { createUserMessage, handleMessageFromStream } from '../messages.js'
import { stripExplicitNulls } from '../messages/structuredOutputDialect.js'
import { sessionLightModel } from '../model/providerFrontier.js'
import { hasPermissionsToUseTool } from '../permissions/permissions.js'
import { asSystemPrompt } from '../systemPromptType.js'
import { hookAnswerJsonSchema, hookBrief, type ModelHookEnd, type ModelHookRun } from './questionRunner.js'

export const CREWMATE_HOOK_TURN_CAP = 50

function readToolsOf(context: ToolUseContext): ToolUseContext['options']['tools'] {
  return (context.options.tools ?? []).filter(tool => {
    if (toolMatchesName(tool, SYNTHETIC_OUTPUT_TOOL_NAME) || ALL_AGENT_DISALLOWED_TOOLS.has(tool.name)) return false
    try {
      return tool.isReadOnly({})
    } catch {
      return false
    }
  })
}

export async function runCrewmateHook(run: ModelHookRun): Promise<ModelHookEnd> {
  const startedAt = Date.now()
  const combined = createCombinedAbortSignal(run.signal, { timeoutMs: run.timeoutMs })
  const agentAbortController = createAbortController()
  const onCombinedAbort = (): void => agentAbortController.abort()
  combined.signal.addEventListener('abort', onCombinedAbort)
  const hookAgentId = `hook-agent-${randomUUID()}`
  const settle = (end: ModelHookEnd): ModelHookEnd => {
    combined.signal.removeEventListener('abort', onCombinedAbort)
    combined.cleanup()
    clearGuards(hookAgentId)
    return end
  }
  const cutEnd = (): ModelHookEnd => (run.signal?.aborted ? { kind: 'cancelled', durationMs: Date.now() - startedAt } : { kind: 'timed_out', durationMs: Date.now() - startedAt })
  try {
    const verdictTool = createSyntheticOutputTool(hookAnswerJsonSchema(run.answerSchema))
    if ('error' in verdictTool) return settle({ kind: 'failed', detail: `the answer shape of ${run.event} cannot bind the verdict tool: ${verdictTool.error}`, durationMs: Date.now() - startedAt })
    const tools = [...readToolsOf(run.toolUseContext), verdictTool.tool]
    const systemPrompt = asSystemPrompt([
      `You are a crewmate checking a hook in Mercury at the moment ${run.event}. The brief follows, with the moment's facts as JSON.`,
      'Use the read tools you have to check what the brief asks, in as few steps as possible.',
      `When done, answer through the ${SYNTHETIC_OUTPUT_TOOL_NAME} tool with one object of the hook answer shape; an empty object means you have nothing to say.`,
    ])
    const getAppState = (): ReturnType<ToolUseContext['getAppState']> => {
      const state = run.toolUseContext.getAppState()
      const permissionContext = state.toolPermissionContext as ToolPermissionContext
      return { ...state, toolPermissionContext: { ...permissionContext, mode: 'dontAsk' } }
    }
    const childContext = {
      ...run.toolUseContext,
      agentId: hookAgentId,
      abortController: agentAbortController,
      getAppState,
      options: {
        ...run.toolUseContext.options,
        tools,
        engineModel: run.model ?? sessionLightModel(),
        isNonInteractiveSession: true,
        thinkingConfig: { type: 'disabled' },
      },
      setInProgressToolUseIDs: () => {},
    } as unknown as ToolUseContext
    registerStructuredOutputGuard(hookAgentId)
    let assistantTurns = 0
    let answer: unknown
    const stream = query({
      messages: [createUserMessage({ content: hookBrief(run.text, run.payloadJson) })],
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
        run.toolUseContext.setStreamMode ?? (() => {}),
        newContent => run.toolUseContext.setResponseLength?.(prev => prev + newContent.length),
        () => {},
        () => {},
      )
      if (!('type' in streamed)) continue
      if (streamed.type === 'assistant') {
        assistantTurns += 1
        if (assistantTurns >= CREWMATE_HOOK_TURN_CAP) {
          agentAbortController.abort()
          break
        }
        continue
      }
      if (streamed.type !== 'attachment') continue
      const attachment = (streamed as { attachment?: { type?: string; data?: unknown } }).attachment
      if (attachment?.type === 'structured_output') {
        answer = stripExplicitNulls(attachment.data)
        agentAbortController.abort()
        break
      }
    }
    const durationMs = Date.now() - startedAt
    if (answer !== undefined) return settle({ kind: 'answered', answer, durationMs })
    if (combined.signal.aborted) return settle(cutEnd())
    return settle({ kind: 'failed', detail: assistantTurns >= CREWMATE_HOOK_TURN_CAP ? `the crewmate used its ${CREWMATE_HOOK_TURN_CAP} turns without answering` : 'the crewmate ended without answering', durationMs })
  } catch (error) {
    if (combined.signal.aborted) return settle(cutEnd())
    return settle({ kind: 'failed', detail: errorMessage(error), durationMs: Date.now() - startedAt })
  }
}
