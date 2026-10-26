import type { Base64ImageSource, ContentBlockParam, ImageBlockParam } from '../../types/wire.js'
import type { ToolUseContext } from '../../Tool.js'
import { getSessionId } from '../../bootstrap/state.js'
import { drainPendingMessages } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { takeAdvisorNotes } from '../../services/advisor/advisorRoads.js'
import { advisorSeatRefusal } from '../../services/advisor/advisorSettings.js'
import { getImagePasteIds, isValidImagePaste, type QueuedCommand } from 'src/types/textInputTypes.js'
import type { QuerySource } from '../../constants/querySource.js'
import type { PastedContent } from '../config.js'
import { maybeResizeAndDownsampleImageBlock } from '../imageResizer.js'
import { extractTextContent } from '../messages.js'
import type { Attachment } from './types.js'
import { fitCompletionCommands } from '../../services/agentResults/summaryRoom.js'
import type { Message } from '../../types/message.js'

const imagePastesOf = (pasted: Record<number, PastedContent> | undefined): PastedContent[] =>
  pasted ? Object.values(pasted).filter(isValidImagePaste) : []

const pastedImageBlock = (paste: PastedContent): ImageBlockParam => ({
  type: 'image',
  source: { type: 'base64', media_type: (paste.mediaType || 'image/png') as Base64ImageSource['media_type'], data: paste.content },
})

async function buildImageContentBlocks(pastedContents: Record<number, PastedContent> | undefined): Promise<ImageBlockParam[]> {
  const fitted = await Promise.all(imagePastesOf(pastedContents).map(paste => maybeResizeAndDownsampleImageBlock(pastedImageBlock(paste))))
  return fitted.map(result => result.block)
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
  return Promise.all(fitCompletionCommands(queuedCommands ?? [], parent).flatMap(command =>
    command.mode === 'prompt' || command.mode === 'task-notification' ? [queuedRow(command)] : [],
  ))
}

const coordinatorCommand = (prompt: string): Attachment => ({ type: 'queued_command', prompt, origin: { kind: 'coordinator' }, isMeta: true })

export function getAgentPendingMessageAttachments(toolUseContext: ToolUseContext): Attachment[] {
  const { agentId, getAppState, setAppStateForTasks, setAppState } = toolUseContext
  if (!agentId) return []
  return drainPendingMessages(agentId, getAppState, setAppStateForTasks ?? setAppState).map(coordinatorCommand)
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
