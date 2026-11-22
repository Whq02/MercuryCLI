import type { Base64ImageSource, ContentBlockParam, ImageBlockParam } from '../../types/wire.js'
import type { ToolUseContext } from '../../Tool.js'
import { getSessionId } from '../../bootstrap/state.js'
import { drainPendingMessages } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { takeAdvisorNotes } from '../advisor/advisorRoads.js'
import { advisorSeatRefusal } from '../advisor/advisorSettings.js'
import { getImagePasteIds, isValidImagePaste, type QueuedCommand } from 'src/types/textInputTypes.js'
import type { QuerySource } from '../../constants/querySource.js'
import type { PastedContent } from '../../utils/config.js'
import { maybeResizeAndDownsampleImageBlock } from '../../utils/imageResizer.js'
import { extractTextContent } from '../messages.js'
import type { Attachment } from '../../utils/attachments/types.js'
import { fitCompletionCommands } from '../agentResults/summaryRoom.js'
import type { Message } from '../../types/message.js'
import { swarmBoundary, swarmEventIds, swarmRoad } from '../crewBoard/seam.js'
import { notBuilt } from '../../pi/holes.js'

async function buildImageContentBlocks(pastedContents: Record<number, PastedContent> | undefined): Promise<ImageBlockParam[]> {
  return notBuilt('src/services/attachments/queuedCommands.ts:25')
}

function promptWithImages(value: QueuedCommand['value'], images: ImageBlockParam[]): string | ContentBlockParam[] {
  if (!images.length) return value
  const text = typeof value === 'string' ? value : extractTextContent(value, '\n')
  return [{ type: 'text', text }, ...images]
}

async function queuedRow(command: QueuedCommand): Promise<Attachment> {
  const images = await buildImageContentBlocks(command.pastedContents)
  return {
    type: 'queued_command', prompt: promptWithImages(command.value, images),
    source_uuid: command.uuid, imagePasteIds: getImagePasteIds(command.pastedContents),
    commandMode: command.mode, origin: command.origin, isMeta: command.isMeta,
    ...(command.sentAt !== undefined ? { sentAt: command.sentAt } : {}),
  }
}

export async function getQueuedCommandAttachments(queuedCommands: QueuedCommand[], parent?: { messages: readonly Message[]; model: string }): Promise<Attachment[]> {
  return notBuilt('src/services/attachments/queuedCommands.ts:46')
}

export function getAgentPendingMessageAttachments(toolUseContext: ToolUseContext): Attachment[] {
  return notBuilt('src/services/attachments/queuedCommands.ts:54')
}

export function isMainChatAdvisorDrain(args: { agentId: string | undefined; querySource: QuerySource | undefined; localSubmission: boolean | undefined }): boolean {
  if (args.agentId !== undefined && args.agentId !== '') return false
  if (args.localSubmission === true) return false
  const source = args.querySource
  return source === 'sdk' || (source !== undefined && source.startsWith('main_thread'))
}

export function getAdvisorNoteAttachments(toolUseContext: Pick<ToolUseContext, 'agentId'>, drain: { querySource?: QuerySource; localSubmission?: boolean } = {}): Attachment[] {
  const agentId = toolUseContext.agentId
  if (!isMainChatAdvisorDrain({ agentId, querySource: drain.querySource, localSubmission: drain.localSubmission })) return []
  if (advisorSeatRefusal('main') !== undefined) return []
  const notes = takeAdvisorNotes(String(getSessionId()))
  if (notes.length === 0) return []
  return notes.map(note => ({ type: 'queued_command' as const, prompt: note.text, origin: note.origin }))
}

export function getSwarmAttachments(toolUseContext: ToolUseContext, messages: readonly Message[]): Attachment[] {
  if (!swarmRoad(toolUseContext.agentId)) return []
  return swarmBoundary(toolUseContext.agentId, swarmEventIds(messages)).map(packet => ({ type: 'queued_command', prompt: packet.text, boardEventIds: packet.eventIds, origin: { kind: 'coordinator' }, isMeta: true }))
}
