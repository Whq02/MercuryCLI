import type { Base64ImageSource, ContentBlockParam, ImageBlockParam } from '../message-shapes/wire.js'
import type { ToolUseContext } from '../../tools/kit/tool.js'
import { getSessionId } from '../../boot/process-state/processState.js'
import { drainPendingMessages } from '../tasks/local-agent/crewmateTask.js'
import { takeAdvisorNotes } from '../../models/advisor/advisorRoads.js'
import { advisorSeatRefusal } from '../../models/advisor/advisorSettings.js'
import { getImagePasteIds, isValidImagePaste, type QueuedCommand } from 'src/screen/composer/input-core/textInput.js'
import type { QuerySource } from '../requests/querySource.js'
import type { PastedContent } from '../../platform/settings/config.js'
import { maybeResizeAndDownsampleImageBlock } from '../../platform/images/imageResizer.js'
import { extractTextContent } from '../messages/messages.js'
import type { Attachment } from '../attachment-shapes/attachmentTypes.js'
import { fitCompletionCommands } from '../../crew/agent-results/summaryRoom.js'
import type { Message } from '../message-shapes/message.js'
import { swarmBoundary, swarmEventIds, swarmRoad } from '../../crew/board/seam.js'

async function buildImageContentBlocks(pastedContents: Record<number, PastedContent> | undefined): Promise<ImageBlockParam[]> {
  if (!pastedContents) return []
  const images = Object.values(pastedContents).filter(isValidImagePaste)
  if (images.length === 0) return []
  return Promise.all(
    images.map(async paste => {
      const block: ImageBlockParam = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: (paste.mediaType || 'image/png') as Base64ImageSource['media_type'],
          data: paste.content,
        },
      }
      const resized = await maybeResizeAndDownsampleImageBlock(block)
      return resized.block
    }),
  )
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
  const fitted = fitCompletionCommands(queuedCommands ?? [], parent)
  const eligible = fitted.filter(
    command => command.mode === 'prompt' || command.mode === 'task-notification',
  )
  return Promise.all(eligible.map(queuedRow))
}

export function getAgentPendingMessageAttachments(toolUseContext: ToolUseContext): Attachment[] {
  if (!toolUseContext.agentId) return []
  const setAppState = toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState
  const messages = drainPendingMessages(
    toolUseContext.agentId,
    toolUseContext.getAppState,
    setAppState,
  )
  return messages.map(prompt => ({
    type: 'queued_command',
    prompt,
    origin: { kind: 'coordinator' },
    isMeta: true,
  }))
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
