// Queued-command attachments — drained prompt/task-notification queue entries
// (with pasted-image content blocks) and the per-agent pending-message drain.
// Owned Mercury module.

import type { Base64ImageSource, ContentBlockParam, ImageBlockParam } from '../../types/wire.js'
import type { ToolUseContext } from '../../Tool.js'
import { drainPendingMessages } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import {
  getImagePasteIds,
  isValidImagePaste,
  type QueuedCommand,
} from 'src/types/textInputTypes.js'
import type { PastedContent } from '../config.js'
import { maybeResizeAndDownsampleImageBlock } from '../imageResizer.js'
import { extractTextContent } from '../messages.js'
import type { Attachment } from './types.js'

const INLINE_NOTIFICATION_MODES = new Set(['prompt', 'task-notification'])

export async function getQueuedCommandAttachments(
  queuedCommands: QueuedCommand[],
): Promise<Attachment[]> {
  if (!queuedCommands) {
    return []
  }
  // Task-notifications drain here alongside prompts by necessity, not
  // convenience: nothing else reads the queue while a turn runs, so a
  // notification-only queue would sit for the whole turn and Sleep would
  // wake instantly in a 0ms spin. (The screen-era idle drain this comment
  // once named — useQueueProcessor — is retired; the turn driver drains
  // between turns, this drain folds in at tool boundaries.)
  const filtered = queuedCommands.filter(_ =>
    INLINE_NOTIFICATION_MODES.has(_.mode),
  )
  return Promise.all(
    filtered.map(async _ => {
      const imageBlocks = await buildImageContentBlocks(_.pastedContents)
      let prompt: string | Array<ContentBlockParam> = _.value
      if (imageBlocks.length > 0) {
        // Pasted images ride as content blocks beside the text — a plain
        // string prompt would drop them on the wire.
        const textValue =
          typeof _.value === 'string'
            ? _.value
            : extractTextContent(_.value, '\n')
        prompt = [{ type: 'text' as const, text: textValue }, ...imageBlocks]
      }
      return {
        type: 'queued_command' as const,
        prompt,
        source_uuid: _.uuid,
        imagePasteIds: getImagePasteIds(_.pastedContents),
        commandMode: _.mode,
        origin: _.origin,
        isMeta: _.isMeta,
      }
    }),
  )
}

export function getAgentPendingMessageAttachments(
  toolUseContext: ToolUseContext,
): Attachment[] {
  const agentId = toolUseContext.agentId
  if (!agentId) return []
  const drained = drainPendingMessages(
    agentId,
    toolUseContext.getAppState,
    toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState,
  )
  return drained.map(msg => ({
    type: 'queued_command' as const,
    prompt: msg,
    origin: { kind: 'coordinator' as const },
    isMeta: true,
  }))
}

async function buildImageContentBlocks(
  pastedContents: Record<number, PastedContent> | undefined,
): Promise<ImageBlockParam[]> {
  if (!pastedContents) {
    return []
  }
  const imageContents = Object.values(pastedContents).filter(isValidImagePaste)
  if (imageContents.length === 0) {
    return []
  }
  const results = await Promise.all(
    imageContents.map(async img => {
      const imageBlock: ImageBlockParam = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: (img.mediaType ||
            'image/png') as Base64ImageSource['media_type'],
          data: img.content,
        },
      }
      const resized = await maybeResizeAndDownsampleImageBlock(imageBlock)
      return resized.block
    }),
  )
  return results
}
