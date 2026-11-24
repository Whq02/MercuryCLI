import { randomUUID } from 'node:crypto'
import { toolMatchesName, type ToolPermissionContext, type ToolUseContext } from '../../tools/kit/tool.js'
import { asAgentId } from '../../sessions/transcripts/ids.js'
import { ALL_CREWMATE_DISALLOWED_TOOLS } from '../../tools/kit/crewmateBarredTools.js'
import { clearGuards } from '../../permissions/guards/guards.js'
import { registerStructuredOutputGuard } from '../../permissions/guards/structuredOutput.js'
import { readCatalogueIfPending } from '../../models/roads/catalogueOnDemand.js'
import { declaredRouteOf } from '../../models/roads/routeLaw.js'
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../../tools/kit/names/syntheticOutput.js'
import { getSchemaBoundStructuredOutputTool } from '../../tools/structured-output/SyntheticOutputTool.js'
import { createAbortController } from '../../platform/async/abortController.js'
import { createCombinedAbortSignal } from '../../platform/async/combinedAbortSignal.js'
import { errorMessage } from '../../platform/errors/errors.js'
import { createUserMessage, handleMessageFromStream } from '../../engine/messages/messages.js'
import { stripExplicitNulls } from '../../engine/message-shapes/structuredOutputDialect.js'
import { forgetCrewmateEffortWord, noteCrewmateEffortWord } from '../../models/effort/effort.js'
import { getEngineModel } from '../../models/catalogue/engineModel.js'
import { utilityCallFor } from '../../models/catalogue/utilityModel.js'
import { asSystemPrompt } from '../../engine/system-prompt/systemPromptType.js'
import { hookAnswerJsonSchema, hookBrief, type ModelHookEnd, type ModelHookRun } from './questionRunner.js'
import { toolPermissionForHooks } from '../event-hooks/toolPermission.js'
import { passedOver } from '../../platform/errors/passedOver.js'

const CREWMATE_HOOK_TURN_CAP = 50

function readToolsOf(context: ToolUseContext): ToolUseContext['options']['tools'] {
  return (context.options.tools ?? []).filter(tool => {
    if (toolMatchesName(tool, STRUCTURED_OUTPUT_TOOL_NAME) || ALL_CREWMATE_DISALLOWED_TOOLS.has(tool.name)) return false
    try {
      return tool.isReadOnly({})
    } catch (error) {
      passedOver(error)
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
    forgetCrewmateEffortWord(hookAgentId)
    return end
  }
  const cutEnd = (): ModelHookEnd => (run.signal?.aborted ? { kind: 'cancelled', durationMs: Date.now() - startedAt } : { kind: 'timed_out', durationMs: Date.now() - startedAt })
  try {
    const verdictTool = getSchemaBoundStructuredOutputTool(hookAnswerJsonSchema(run.answerSchema))
    if ('error' in verdictTool) return settle({ kind: 'failed', detail: `the answer shape of ${run.event} cannot bind the verdict tool: ${verdictTool.error}`, durationMs: Date.now() - startedAt })
    const tools = [...readToolsOf(run.toolUseContext), verdictTool.tool]
    const systemPrompt = asSystemPrompt([
      `You are a crewmate checking a hook in Mercury at the moment ${run.event}. The brief follows, with the moment's facts as JSON.`,
      'Use the read tools you have to check what the brief asks, in as few steps as possible.',
      `When done, answer through the ${STRUCTURED_OUTPUT_TOOL_NAME} tool with one object of the hook answer shape; an empty object means you have nothing to say.`,
    ])
    await readCatalogueIfPending(declaredRouteOf(run.model ?? getEngineModel()) ?? '')
    const call = run.model === undefined ? utilityCallFor() : utilityCallFor(run.model, { named: true })
    noteCrewmateEffortWord(hookAgentId, call.effortValue)
    const getAppState = (): ReturnType<ToolUseContext['getAppState']> => {
      const state = run.toolUseContext.getAppState()
      const permissionContext = state.toolPermissionContext as ToolPermissionContext
      return { ...state, toolPermissionContext: { ...permissionContext, mode: 'dontAsk' }, effortValue: call.effortValue }
    }
    const childContext: ToolUseContext = {
      ...run.toolUseContext,
      agentId: asAgentId(hookAgentId),
      abortController: agentAbortController,
      getAppState,
      options: {
        ...run.toolUseContext.options,
        tools,
        engineModel: call.model,
        isNonInteractiveSession: true,
        thinkingConfig: call.thinkingConfig,
      },
      setInProgressToolUseIDs: () => {},
    }
    registerStructuredOutputGuard(hookAgentId)
    let assistantTurns = 0
    let answer: unknown
    const stream = run.toolUseContext.startTurn({
      messages: [createUserMessage({ content: hookBrief(run.text, run.payloadJson) })],
      systemPrompt,
      userContext: {},
      systemContext: {},
      toolUseContext: childContext,
      canUseTool: toolPermissionForHooks,
      querySource: 'hook_agent',
    })
    for await (const streamed of stream) {
      handleMessageFromStream(
        streamed,
        () => {},
        newContent => run.toolUseContext.setResponseLength?.(prev => prev + newContent.length),
        run.toolUseContext.setStreamMode ?? (() => {}),
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
