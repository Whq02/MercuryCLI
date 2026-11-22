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
  const { input, mode, context, isMeta, setUserInputOnProcessing } = options

  if (mode === 'prompt' && options.batchTail && options.batchTail.length > 0) {
    const prompts: Array<{ value: string | ContentBlockParam[]; uuid?: string; origin?: MessageOrigin }> = [
      { value: input, uuid: options.uuid, origin: options.origin },
      ...options.batchTail,
    ]
    const lead: ProcessUserInputBaseResult['messages'] = []
    const rows: UserMessage[] = []
    const remaining: ProcessUserInputBaseResult['messages'] = []
    const results: ProcessUserInputBaseResult[] = []
    for (const [index, prompt] of prompts.entries()) {
      const uuid = prompt.uuid ?? randomUUID()
      const result = await processUserInput({
        ...options,
        input: prompt.value,
        messages: [...options.messages, ...lead, ...rows, ...remaining],
        uuid,
        batchUuids: undefined,
        batchTail: undefined,
        ...(index === 0 ? {} : {
          skipSlashCommands: true,
          bridgeOrigin: false,
          origin: prompt.origin,
          syntaxInput: undefined,
          pastedContents: undefined,
          setUserInputOnProcessing: undefined,
        }),
      })
      results.push(result)
      const lastBlock = typeof prompt.value === 'string' ? undefined : prompt.value.at(-1)
      const promptText = typeof prompt.value === 'string' ? prompt.value : lastBlock?.type === 'text' ? lastBlock.text : undefined
      if (
        index === 0 && options.skipSlashCommands !== true &&
        promptText?.startsWith('/') && !result.hookBlocked &&
        !result.messages.some(message => message.type === 'user' && message.uuid === uuid && message.message.content === promptText)
      ) {
        lead.push(...result.messages)
        continue
      }
      for (const message of result.messages) {
        if (result.shouldQuery && message.type === 'user' && message.uuid === uuid) {
          rows.push(message)
        } else if (!result.shouldQuery && message.type === 'user') {
          remaining.push({ ...message, isVirtual: true })
        } else if (result.shouldQuery || message.type !== 'attachment') {
          remaining.push(message)
        }
      }
    }
    if (rows.length > 1) rows[0] = { ...rows[0]!, batchUuids: rows.map(row => row.uuid) }
    const shouldQuery = results.some(result => result.shouldQuery)
    const blocked = results.filter(result => result.hookBlocked)
    return {
      ...results[0]!,
      messages: [...lead, ...rows, ...remaining],
      shouldQuery,
      ...(blocked.length > 0 && !shouldQuery ? {
        hookBlocked: true,
        resultText: blocked.map(result => result.resultText).join('\n'),
      } : {}),
    }
  }

  if (mode === 'prompt' && typeof input === 'string' && isMeta !== true) {
    setUserInputOnProcessing?.(input)
  }

  const base = await processUserInputBase(options)
  if (!base.shouldQuery) return base

  const promptText = typeof input === 'string' ? input : extractTextContent(input, '\n')
  const settingsMessages: Message[] = context.agentId === undefined ? [...untoldSettingsFaultLines(), ...untoldHiddenCharacterLines()].map(line => createSystemMessage(line, 'warning')) : []
  const started = await fireHooks(
    'turn.start',
    { turn_id: readToolCallChain(context)?.key ?? '', prompt: promptText },
    { scope: { sessionId: String(getSessionId()), ...(context.agentId !== undefined ? { crewmateId: context.agentId } : {}) }, signal: context.abortController.signal, toolUseContext: context },
  )
  const hookMessages: Message[] = [...settingsMessages, ...hookRowsOfResult(started).map(row => createAttachmentMessage(row) as Message)]
  if (started.answer.block !== undefined) {
    return {
      messages: [
        ...hookMessages,
        createSystemMessage(`${started.answer.block}\n\nThe prompt was: ${promptText}`, 'warning'),
      ],
      shouldQuery: false,
      hookBlocked: true,
      resultText: started.answer.block,
      ...(base.allowedTools !== undefined ? { allowedTools: base.allowedTools } : {}),
    }
  }
  if (started.answer.stop !== undefined) {
    return { ...base, messages: [...base.messages, ...hookMessages], shouldQuery: false }
  }
  return { ...base, messages: [...base.messages, ...hookMessages] }
}


function isImageBlock(block: ContentBlockParam): block is ImageBlockParam {
  return (block as { type?: string }).type === 'image'
}

async function processUserInputBase(
  options: ProcessUserInputOptions,
): Promise<ProcessUserInputBaseResult> {
  return notBuilt('src/services/processUserInput/processUserInput.ts:185')
}
