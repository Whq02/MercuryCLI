import { randomUUID, type UUID } from 'node:crypto'
import type { CanUseToolFn, SetToolJSXFn, ToolUseContext } from '../../Tool.js'
import type { QuerySource } from '../../constants/querySource.js'
import type { ContentBlockParam, ImageBlockParam } from '../../types/wire.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  MessageOrigin,
  ProgressMessage,
  SystemMessage,
  UserMessage,
} from '../../types/message.js'
import type { EffortValue } from '../../utils/effort.js'
import type { PastedContent } from '../../utils/config.js'
import type { BatchedPrompt } from '../../types/textInputTypes.js'
import {
  createAttachmentMessage,
  getAttachmentMessages,
} from '../attachments.js'
import { readToolCallChain } from '../../Tool.js'
import { getSessionId } from '../../bootstrap/state.js'
import { fireHooks } from '../../utils/hooks/fire.js'
import { hookRowsOfResult } from '../../utils/hooks/rows.js'
import {
  createSystemMessage,
  createUserMessage,
  extractTextContent,
} from '../messages.js'
import { maybeResizeAndDownsampleImageBlock } from '../../utils/imageResizer.js'
import { isStoredImageRef, readStoredImageRef, storeImages } from '../../utils/imageStore.js'
import { logError } from '../../utils/log.js'
import { parseSlashCommand } from '../../utils/slashCommandParsing.js'
import { untoldSettingsFaultLines } from '../settings/faultNotices.js'
import { untoldHiddenCharacterLines } from '../../utils/text/hiddenCharacterFindings.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

export type ProcessUserInputContext = Unbuilt

export type ProcessUserInputBaseResult = Unbuilt


type ProcessUserInputOptions = Unbuilt


export async function processUserInput(
  options: ProcessUserInputOptions,
): Promise<ProcessUserInputBaseResult> {
  return notBuilt('src/services/processUserInput/processUserInput.ts:80')
}


function isImageBlock(block: ContentBlockParam): block is ImageBlockParam {
  return (block as { type?: string }).type === 'image'
}
