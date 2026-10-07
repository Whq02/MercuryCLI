import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { AssistantMessage } from '../../types/message.js'
import { queuePendingMessage, speakAgentMessageFrame } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { errorMessage } from '../../utils/errors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { liveAgentOwner } from '../AgentTool/resumeAgent.js'
import { endedWords, mapMessageResult, messageNoticeFor, messageWorkflowWorker, resolveCrewAddress, selfAddressRefusalText, senderAgentTask, unknownAgentRefusal, validateCrewMessage, type CrewMessageInput, type MessageOutput } from '../SendMessageTool/crewAddress.js'
import { renderToolResultMessage, renderToolUseMessage } from '../SendMessageTool/UI.js'
import { RESUME_AGENT_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'

export type ResumeAgentToolOutput = MessageOutput
export type Input = CrewMessageInput
const inputSchema = lazySchema(() => z.object({
  to: z.string().describe('The crewmate to resume: the id its launch receipt names or the name its launch gave it'),
  message: z.string().describe('Its next turn: what to do, written as you would brief it'),
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
    if (address.task?.status === 'running') {
      queuePendingMessage(address.agentId, messageNoticeFor(address.agentId, input.message, context), context.setAppStateForTasks ?? context.setAppState)
      return { data: { success: true, message: `Agent ${address.who} is still running, so nothing was resumed: the message was delivered and it reads it at its next tool boundary.` } }
    }
    const workflow = await messageWorkflowWorker(address, input.message)
    if (workflow !== undefined) return { data: workflow }
    if (address.task === undefined && address.transcriptPath === null) return { data: { success: false, message: `Cannot resume ${address.who}: no running task by that id in this session and no transcript on disk to resume from — the agent may belong to another process, or its record was cleaned up. Launch a new crewmate with Agent if the work is still wanted.` } }
    const ended = await endedWords(address)
    try {
      const notice = messageNoticeFor(address.agentId, input.message, context)
      const resumed = await (await import('../AgentTool/resumeAgent.js')).resumeAgentBackground({
        agentId: address.agentId, prompt: notice, toolUseContext: context, canUseTool, invokingRequestId: parentAssistantMessage.requestId,
      })
      speakAgentMessageFrame(address.agentId, notice)
      const completion = senderAgentTask(context) === undefined
        ? ', and its completion notice will come to you.'
        : '. Its completion notice goes to the main agent, not to you.'
      return { data: { success: true, message: `Agent ${address.who} had ${ended}; it was resumed in the background with your message${completion} Output file: ${resumed.outputFile}${resumed.note ?? ''}` } }
    } catch (error) {
      const words = errorMessage(error)
      const owner = liveAgentOwner(address.agentId, context.getAppState().tasks)
      const next = owner?.words === words ? '' : ' Launch a new crewmate with Agent if the work is still wanted.'
      return { data: { success: false, message: `Agent ${address.who} had ${ended} and could not be resumed: ${words}${next}` } }
    }
  },
  mapToolResultToToolResultBlockParam: mapMessageResult,
  renderToolUseMessage,
  renderToolResultMessage,
} satisfies ToolDef<InputSchema, ResumeAgentToolOutput>)
