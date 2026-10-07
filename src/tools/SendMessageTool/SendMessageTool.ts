import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { enqueueMessageToMainAgent, queuePendingMessage } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { SEND_MESSAGE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'
import { endedWords, mapMessageResult, messageNoticeFor, messageWorkflowWorker, resolveCrewAddress, selfAddressRefusalText, senderAgentTask, unknownAgentRefusal, validateCrewMessage, type CrewMessageInput, type MessageOutput } from './crewAddress.js'

export type SendMessageToolOutput = MessageOutput
export type Input = CrewMessageInput
const inputSchema = lazySchema(() => z.object({
  to: z.string().describe('The crewmate to send to: the id its launch receipt names or the name its launch gave it; "main" from a background crewmate reaches the agent that launched it'),
  message: z.string().describe('The message'),
}))
type InputSchema = ReturnType<typeof inputSchema>
const outputSchema = lazySchema(() => z.object({ success: z.boolean(), message: z.string() }))

export const SendMessageTool = buildTool({
  name: SEND_MESSAGE_TOOL_NAME,
  searchHint: 'send a note to a running crewmate of this session; it never starts a finished one',
  shouldDefer: true,
  maxResultSizeChars: 100_000,
  get inputSchema() { return inputSchema() },
  get outputSchema() { return outputSchema() },
  isReadOnly: () => true,
  async description() { return DESCRIPTION },
  async prompt({ tools }) { return getPrompt(new Set(tools.map(tool => tool.name))) },
  async checkPermissions(input: Input) { return { behavior: 'allow' as const, updatedInput: input } },
  validateInput: validateCrewMessage,
  async call(input: Input, context: ToolUseContext) {
    const to = input.to.trim()
    const self = selfAddressRefusalText(to, context, 'deliver to')
    if (self !== null) return { data: { success: false, message: self } }
    const address = await resolveCrewAddress(to, context)
    if (address.kind === 'main') {
      const sender = senderAgentTask(context)
      if (sender === undefined) return { data: { success: false, message: `Cannot deliver to "${to}": that address names this session's own main agent, and only a background crewmate reaches its main agent there. Address a crewmate by the id its launch receipt names or by its name.` } }
      enqueueMessageToMainAgent({ fromTaskId: sender.id, description: sender.description, text: input.message })
      return { data: { success: true, message: 'Delivered to the main agent; it reads it at its next tool boundary, or between turns starts a turn for it.' } }
    }
    if (address.kind === 'unknown') return { data: { success: false, message: await unknownAgentRefusal(to, context, 'deliver to') } }
    const resolvedSelf = selfAddressRefusalText(to, context, 'deliver to', address.agentId)
    if (resolvedSelf !== null) return { data: { success: false, message: resolvedSelf } }
    if (address.task?.status === 'running') {
      queuePendingMessage(address.agentId, messageNoticeFor(address.agentId, input.message, context), context.setAppStateForTasks ?? context.setAppState)
      return { data: { success: true, message: `Delivered to ${address.who}; it reads it at its next tool boundary.` } }
    }
    const workflow = await messageWorkflowWorker(address, input.message)
    if (workflow !== undefined) return { data: workflow }
    if (address.task === undefined && address.transcriptPath === null) return { data: { success: false, message: `Agent ${address.who}: no running task by that id in this session and no transcript on disk — the agent may belong to another process, or its record was cleaned up. Address a live crewmate by the id its launch receipt names, or by the name its launch gave it.` } }
    return { data: { success: false, message: `Not delivered: ${address.who} has ${await endedWords(address)}, so no turn of it is running to read a message. To give it this message as a new turn, call ResumeAgent with the same to and message.` } }
  },
  mapToolResultToToolResultBlockParam: mapMessageResult,
  renderToolUseMessage,
  renderToolResultMessage,
} satisfies ToolDef<InputSchema, SendMessageToolOutput>)
