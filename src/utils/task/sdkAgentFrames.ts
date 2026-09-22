import type { Message, ProgressMessage } from '../../types/message.js'
import { normalizeMessage } from '../queryHelpers.js'
import { enqueueSdkEvent, type SdkAgentFrame } from '../sdkEventQueue.js'

export function emitBackgroundAgentFrames(parentToolUseId: string | undefined, agentId: string, message: Message): void {
  if (parentToolUseId === undefined || parentToolUseId === '') return
  if (message.type !== 'assistant' && message.type !== 'user') return
  const progress = {
    type: 'progress',
    uuid: message.uuid,
    timestamp: message.timestamp,
    toolUseID: `agent_${agentId}`,
    parentToolUseID: parentToolUseId,
    data: { type: 'agent_progress', message, prompt: '', agentId },
  } as unknown as ProgressMessage
  for (const frame of normalizeMessage(progress)) {
    if ((frame.type === 'assistant' || frame.type === 'user') && typeof frame.parent_tool_use_id === 'string') {
      enqueueSdkEvent({ ...frame, parent_tool_use_id: frame.parent_tool_use_id } as SdkAgentFrame)
    }
  }
}
