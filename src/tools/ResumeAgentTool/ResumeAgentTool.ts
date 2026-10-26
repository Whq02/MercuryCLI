import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { AssistantMessage } from '../../types/message.js'
import { AGENT_INTERRUPT_BY_OPERATOR, isLocalAgentTask, queuePendingMessage, speakAgentMessageFrame } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { errorMessage } from '../../utils/errors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { liveAgentOwner } from '../AgentTool/resumeAgent.js'
import { endedWords, mapMessageResult, messageNoticeFor, messageWorkflowWorker, resolveCrewAddress, selfAddressRefusalText, senderAgentTask, unknownAgentRefusal, validateCrewMessage, type CrewMessageInput, type MessageOutput } from '../SendMessageTool/crewAddress.js'
import { renderToolResultMessage, renderToolUseMessage } from '../SendMessageTool/UI.js'
import { RESUME_AGENT_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'
import { EFFORT_LEVELS, type EffortLevel } from '../../utils/effort.js'
import { stopAgentByOperator } from '../../services/agents/operatorStop.js'
import { flushSessionStorage } from '../../utils/sessionStorage.js'

type ResumeAgentToolOutput = MessageOutput
type Input = CrewMessageInput & { model?: string; effort?: EffortLevel; interrupt?: boolean }
const inputSchema = lazySchema(() => z.object({
  to: z.string().describe('The crewmate to resume: the id its launch receipt names or the name its launch gave it'),
  message: z.string().describe('Its next turn: what to do, written as you would brief it'),
  model: z.string().optional().describe('Model for the resumed turn of a finished crewmate; omitted, its recorded model stays. Read mercury://models for available ids.'),
  effort: z.enum(EFFORT_LEVELS).optional().describe('Effort for the resumed turn; omitted, its recorded effort stays. Max is admitted; an unsupported lower tier is refused, not clamped.'),
  interrupt: z.boolean().optional().describe('Interrupt a running turn and start this message as its next turn; omitted or false, deliver it at the next tool boundary.'),
}))
type InputSchema = ReturnType<typeof inputSchema>
const outputSchema = lazySchema(() => z.object({ success: z.boolean(), message: z.string() }))

export const ResumeAgentTool = buildTool({
  name: RESUME_AGENT_TOOL_NAME,
  searchHint: 'give a crewmate of this session a new turn, resuming it from its transcript if it has finished',
  shouldDefer: true,
  maxResultSizeChars: 100_000,
  get inputSchema() { return inputSchema() },
  get outputSchema() { return outputSchema() },
  isReadOnly: () => true,
  async description() { return DESCRIPTION },
  async prompt() { return getPrompt() },
  async checkPermissions(input: Input) { return { behavior: 'allow' as const, updatedInput: input } },
  validateInput: validateCrewMessage,
  async call(input: Input, context: ToolUseContext, canUseTool: CanUseToolFn, parentAssistantMessage: AssistantMessage) {
    const to = input.to.trim()
    const self = selfAddressRefusalText(to, context, 'resume')
    if (self !== null) return { data: { success: false, message: self } }
    const address = await resolveCrewAddress(to, context)
    if (address.kind === 'main') return { data: { success: false, message: 'Cannot resume "main": the main agent is not a crewmate. A background crewmate reaches it with SendMessage to "main".' } }
    if (address.kind === 'unknown') return { data: { success: false, message: await unknownAgentRefusal(to, context, 'resume') } }
    const resolvedSelf = selfAddressRefusalText(to, context, 'resume', address.agentId)
    if (resolvedSelf !== null) return { data: { success: false, message: resolvedSelf } }
    const overrides = [input.model !== undefined ? `model ${input.model}` : null, input.effort !== undefined ? `effort ${input.effort}` : null].filter((word): word is string => word !== null)
    if (overrides.length > 0 && address.task?.status !== 'running') {
      const owner = liveAgentOwner(address.agentId, context.getAppState().tasks)
      if (owner !== null) return { data: { success: false, message: `${owner.words} Model and effort overrides apply only to a finished crewmate; nothing was queued.` } }
    }
    if (address.task?.status === 'running') {
      if (!input.interrupt) {
        const ahead = address.task.pendingMessages?.length ?? 0
        queuePendingMessage(address.agentId, messageNoticeFor(address.agentId, input.message, context), context.setAppStateForTasks ?? context.setAppState)
        const queue = ahead === 0 ? 'it reads it at its next tool boundary, or as its next turn when the current one ends' : `${ahead} earlier ${ahead === 1 ? 'message is' : 'messages are'} queued ahead of it; it reads them in order at its next tool boundary, or as its next turn when the current one ends`
        const kept = overrides.length === 0 ? '' : ` Its ${overrides.join(' and ')} ${overrides.length === 1 ? 'was' : 'were'} not applied: a running crewmate keeps its model and effort; name them again on ResumeCrewmate once it has finished.`
        return { data: { success: true, message: `Crewmate ${address.who} is still running, so nothing was resumed: the message was queued and ${queue}.${kept}` } }
      }
      const stopped = await stopAgentByOperator(address.agentId, {
        getAppState: context.getAppState,
        setAppState: context.setAppStateForTasks ?? context.setAppState,
      }, { reason: AGENT_INTERRUPT_BY_OPERATOR })
      if (stopped.outcome === 'refused') return { data: { success: false, message: stopped.reason } }
      await flushSessionStorage()
      context.abortController.signal.throwIfAborted()
      const task = context.getAppState().tasks[address.agentId]
      if (isLocalAgentTask(task)) address.task = task
      else delete address.task
    }
    const workflow = await messageWorkflowWorker(address, input.message)
    if (workflow !== undefined) return { data: workflow }
    if (address.task === undefined && address.transcriptPath === null) return { data: { success: false, message: `Cannot resume ${address.who}: no running task by that id in this session and no transcript on disk to resume from — the crewmate may belong to another process, or its record was cleaned up. Launch a new crewmate with Crewmate if the work is still wanted.` } }
    const ended = await endedWords(address)
    try {
      const notice = messageNoticeFor(address.agentId, input.message, context)
      const resumed = await (await import('../AgentTool/resumeAgent.js')).resumeAgentBackground({
        agentId: address.agentId, prompt: notice, toolUseContext: context, canUseTool, invokingRequestId: parentAssistantMessage.requestId,
        model: input.model, effort: input.effort,
      })
      speakAgentMessageFrame(address.agentId, notice)
      const completion = senderAgentTask(context) === undefined
        ? ', and its completion notice will come to you.'
        : '. Its completion notice goes to the main agent, not to you.'
      return { data: { success: true, message: `Crewmate ${address.who} had ${ended}; it was resumed in the background with your message${completion} Output file: ${resumed.outputFile}${resumed.note ?? ''}` } }
    } catch (error) {
      const words = errorMessage(error)
      const owner = liveAgentOwner(address.agentId, context.getAppState().tasks)
      const next = owner?.words === words ? '' : ' Launch a new crewmate with Crewmate if the work is still wanted.'
      return { data: { success: false, message: `Crewmate ${address.who} had ${ended} and could not be resumed: ${words}${next}` } }
    }
  },
  mapToolResultToToolResultBlockParam: mapMessageResult,
  renderToolUseMessage,
  renderToolResultMessage,
} satisfies ToolDef<InputSchema, ResumeAgentToolOutput>)
