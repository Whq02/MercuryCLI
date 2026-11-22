import { z } from 'zod/v4'
import { swarmPeerMessage, swarmRoad } from '../../services/crewBoard/seam.js'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { enqueueMessageToMainAgent, queuePendingMessage } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { SEND_MESSAGE_TOOL_NAME } from '../../constants/tools/sendMessage.js'
import { DESCRIPTION, getPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'
import { endedWords, mapMessageResult, messageNoticeFor, resolveCrewAddress, selfAddressRefusalText, senderAgentTask, unknownAgentRefusal, validateCrewMessage, type CrewMessageInput, type MessageOutput } from './crewAddress.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'

export type SendMessageToolOutput = MessageOutput
export type Input = CrewMessageInput

export const SendMessageTool: Unbuilt = unbuilt('src/tools/SendMessageTool/SendMessageTool.ts:20')
