import { randomUUID, type UUID } from 'node:crypto'
import type { CanUseToolFn, SetToolJSXFn, ToolUseContext } from '../../tools/kit/tool.js'
import type { QuerySource } from '../requests/querySource.js'
import type { Base64ImageSource, ContentBlockParam, ImageBlockParam } from '../message-shapes/wire.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  MessageOrigin,
  ProgressMessage,
  SystemMessage,
  UserMessage,
} from '../message-shapes/message.js'
import type { EffortValue } from '../../models/effort/effort.js'
import type { PastedContent } from '../../platform/settings/config.js'
import type { BatchedPrompt, PromptInputMode } from '../../screen/composer/input-core/textInput.js'
import type { LocalJSXCommandContext } from '../../commands/catalogue/command.js'
import {
  createAttachmentMessage,
  getAttachmentMessages,
} from '../attachments/attachments.js'
import { readToolCallChain } from '../../tools/kit/tool.js'
import { getSessionId } from '../../boot/process-state/processState.js'
import { fireHooks } from '../../integrations/event-hooks/fire.js'
import { hookRowsOfResult } from '../../integrations/event-hooks/rows.js'
import {
  createSystemMessage,
  createUserMessage,
  extractTextContent,
} from '../messages/messages.js'
import { maybeResizeAndDownsampleImageBlock } from '../../platform/images/imageResizer.js'
import { isStoredImageRef, readStoredImageRef, storeImages } from '../../platform/images/imageStore.js'
import { logError } from '../../platform/logs/errorLog.js'
import { parseSlashCommand } from '../../commands/catalogue/slashCommandParsing.js'
import { LOCAL_COMMAND_STDOUT_TAG } from '../message-shapes/messageTags.js'
import { untoldSettingsFaultLines } from '../../platform/settings-faults/faultNotices.js'
import { untoldHiddenCharacterLines } from '../../platform/text/hiddenCharacterFindings.js'
import { processBashCommand } from './processBashCommand.js'
import { processSlashCommand } from './processSlashCommand.js'
import { processTextPrompt } from './processTextPrompt.js'

export type ProcessUserInputContext = ToolUseContext & LocalJSXCommandContext

export type ProcessUserInputBaseResult = {
  messages: (UserMessage | AssistantMessage | AttachmentMessage | SystemMessage | ProgressMessage)[]
  shouldQuery: boolean
  allowedTools?: string[]
  model?: string
  effort?: EffortValue
  resultText?: string
  commandError?: string
  commandRefused?: true
  hookBlocked?: true
  nextInput?: string
  submitNextInput?: boolean
}


type ProcessUserInputOptions = {
  input: string | ContentBlockParam[]
  syntaxInput?: string
  mode: PromptInputMode
  setToolJSX: SetToolJSXFn
  context: ProcessUserInputContext
  pastedContents?: Record<number, PastedContent>
  messages: Message[]
  setUserInputOnProcessing?: (prompt?: string) => void
  uuid?: string
  batchUuids?: string[]
  batchTail?: BatchedPrompt[]
  isMeta?: boolean
  operatorPrompt?: boolean
  origin?: MessageOrigin
  skipSlashCommands?: boolean
  bridgeOrigin?: boolean
  skipAttachments?: boolean
  isAlreadyProcessing?: boolean
  querySource: QuerySource
  canUseTool?: CanUseToolFn
}


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

async function normalizeInputBlocks(
  blocks: ContentBlockParam[],
  imageDimensionNotes: string[],
): Promise<{
  normalizedBlocks: ContentBlockParam[]
  promptText: string | null
  precedingInputBlocks: ContentBlockParam[]
}> {
  const normalizedBlocks: ContentBlockParam[] = []
  for (const rawBlock of blocks) {
    let block: ContentBlockParam = rawBlock
    if (isStoredImageRef(rawBlock)) {
      const read = await readStoredImageRef(rawBlock)
      if (read.kind === 'missing') {
        normalizedBlocks.push({ type: 'text', text: read.words })
        continue
      }
      block = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: read.block.source.media_type as Base64ImageSource['media_type'],
          data: read.block.source.data,
        },
      }
    }
    if (!isImageBlock(block)) {
      normalizedBlocks.push(block)
      continue
    }
    const source = block.source as { type: string; media_type?: string; mediaType?: string }
    if (!source.media_type && source.mediaType) {
      source.media_type = source.mediaType
    }
    try {
      const resized = await maybeResizeAndDownsampleImageBlock(block)
      normalizedBlocks.push(resized.block)
      const dims = resized.dimensions
      if (dims?.displayWidth && dims?.displayHeight) {
        imageDimensionNotes.push(
          `[Image dimensions: ${dims.displayWidth}x${dims.displayHeight}]`,
        )
      }
    } catch (error) {
      logError(error)
      normalizedBlocks.push(block)
    }
  }

  const firstTextIndex = normalizedBlocks.findIndex(block => block.type === 'text')
  if (firstTextIndex !== -1) {
    const firstBlock = normalizedBlocks[firstTextIndex]!
    const promptText = firstBlock.type === 'text' ? firstBlock.text : null
    const precedingInputBlocks = normalizedBlocks.filter((_, index) => index !== firstTextIndex)
    return { normalizedBlocks, promptText, precedingInputBlocks }
  }
  return { normalizedBlocks, promptText: null, precedingInputBlocks: normalizedBlocks }
}

async function processPastedImages(
  pastedContents: Record<number, PastedContent> | undefined,
  imageDimensionNotes: string[],
): Promise<{ imageContentBlocks: ContentBlockParam[]; imagePasteIds: number[] }> {
  const imageContentBlocks: ContentBlockParam[] = []
  const imagePasteIds: number[] = []
  if (pastedContents === undefined || Object.keys(pastedContents).length === 0) {
    return { imageContentBlocks, imagePasteIds }
  }

  storeImages(pastedContents).catch(error => {
    logError(error)
  })

  const imagePastes = Object.entries(pastedContents)
    .map(([key, paste]) => ({ id: Number(key), paste }))
    .filter(entry => entry.paste.type === 'image' && entry.paste.content.length > 0)
    .sort((a, b) => a.id - b.id)

  const fitted = await Promise.all(
    imagePastes.map(async ({ id, paste }) => {
      const rawBlock: ImageBlockParam = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: (paste.mediaType ?? 'image/png') as Base64ImageSource['media_type'],
          data: paste.content,
        },
      }
      try {
        const resized = await maybeResizeAndDownsampleImageBlock(rawBlock)
        return { id, paste, block: resized.block, dimensions: resized.dimensions }
      } catch (error) {
        logError(error)
        return { id, paste, block: rawBlock, dimensions: undefined }
      }
    }),
  )

  for (const { id, paste, block, dimensions } of fitted) {
    imageContentBlocks.push(block)
    imagePasteIds.push(id)
    if (dimensions?.displayWidth && dimensions?.displayHeight) {
      imageDimensionNotes.push(
        `[Image #${id} dimensions: ${dimensions.displayWidth}x${dimensions.displayHeight}]`,
      )
    } else if (dimensions?.originalWidth && dimensions?.originalHeight) {
      imageDimensionNotes.push(
        `[Image #${id} dimensions: ${dimensions.originalWidth}x${dimensions.originalHeight}]`,
      )
    } else if (paste.dimensions?.originalWidth && paste.dimensions?.originalHeight) {
      imageDimensionNotes.push(
        `[Image #${id} dimensions: ${paste.dimensions.originalWidth}x${paste.dimensions.originalHeight}]`,
      )
    } else if (paste.sourcePath) {
      imageDimensionNotes.push(`[Image #${id} source: ${paste.sourcePath}]`)
    }
  }

  return { imageContentBlocks, imagePasteIds }
}

async function processUserInputBase(
  options: ProcessUserInputOptions,
): Promise<ProcessUserInputBaseResult> {
  const {
    input,
    syntaxInput,
    mode,
    setToolJSX,
    context,
    pastedContents,
    messages,
    uuid,
    batchUuids,
    isMeta,
    operatorPrompt,
    origin,
    skipSlashCommands,
    bridgeOrigin,
    skipAttachments,
    isAlreadyProcessing,
    querySource,
    canUseTool,
  } = options

  const imageDimensionNotes: string[] = []
  let normalizedInput: string | ContentBlockParam[]
  let promptText: string | null
  let precedingInputBlocks: ContentBlockParam[]

  if (typeof input === 'string') {
    normalizedInput = input
    promptText = input
    precedingInputBlocks = []
  } else {
    const normalized = await normalizeInputBlocks(input, imageDimensionNotes)
    normalizedInput = normalized.normalizedBlocks
    promptText = normalized.promptText
    precedingInputBlocks = normalized.precedingInputBlocks
  }

  if (mode !== 'prompt' && promptText === null) {
    throw new Error(`processUserInput: mode ${mode} requires string input`)
  }

  const { imageContentBlocks, imagePasteIds } = await processPastedImages(
    pastedContents,
    imageDimensionNotes,
  )

  let skipSlash = skipSlashCommands === true
  const syntaxPrompt = syntaxInput ?? promptText

  if (bridgeOrigin === true && promptText !== null && promptText.startsWith('/')) {
    const parsedBridge = parseSlashCommand(promptText)
    if (parsedBridge !== null) {
      const matched = context.options.commands.find(
        command =>
          command.name === parsedBridge.commandName ||
          command.aliases?.includes(parsedBridge.commandName) === true,
      )
      if (matched !== undefined) {
        if ((matched as { isBridgeSafe?: boolean }).isBridgeSafe === true) {
          skipSlash = false
        } else {
          const refusal = `The /${parsedBridge.commandName} command cannot be used from the remote-control surface.`
          return {
            messages: [
              createUserMessage({ content: promptText }),
              createUserMessage({
                content: `<${LOCAL_COMMAND_STDOUT_TAG}>${refusal}</${LOCAL_COMMAND_STDOUT_TAG}>`,
              }),
            ],
            shouldQuery: false,
            resultText: refusal,
          }
        }
      }
    }
  }

  const isSlashLine =
    mode === 'prompt' &&
    syntaxPrompt !== null &&
    syntaxPrompt.startsWith('/') &&
    parseSlashCommand(syntaxPrompt) !== null

  const attachmentMessages: AttachmentMessage[] = []
  if (
    skipAttachments !== true &&
    typeof syntaxPrompt === 'string' &&
    (mode !== 'prompt' || skipSlash || !isSlashLine)
  ) {
    try {
      for await (const attachmentMessage of getAttachmentMessages(
        syntaxPrompt,
        context,
        [],
        messages,
        querySource,
        {
          localSubmission: mode === 'bash',
          operatorPrompt: operatorPrompt === true,
        },
      )) {
        attachmentMessages.push(attachmentMessage)
      }
    } catch (error) {
      logError(error)
    }
  }

  let result: ProcessUserInputBaseResult
  if (mode === 'bash') {
    result = await processBashCommand(
      promptText!,
      precedingInputBlocks,
      attachmentMessages,
      context,
      setToolJSX,
      uuid,
    )
  } else if (!skipSlash && isSlashLine && syntaxPrompt !== null) {
    const slashBlocks = [...precedingInputBlocks]
    if (
      syntaxInput !== undefined &&
      promptText !== null &&
      promptText.startsWith(syntaxInput)
    ) {
      slashBlocks.push({
        type: 'text',
        text: promptText.slice(syntaxInput.length).trimStart(),
      })
    }
    result = await processSlashCommand(
      syntaxPrompt,
      slashBlocks,
      imageContentBlocks,
      attachmentMessages,
      context,
      setToolJSX,
      uuid as UUID | undefined,
      isAlreadyProcessing,
      canUseTool,
    )
  } else {
    result = processTextPrompt(
      normalizedInput,
      imageContentBlocks,
      imagePasteIds,
      attachmentMessages,
      uuid as UUID | undefined,
      context.getAppState().toolPermissionContext?.mode,
      isMeta,
      batchUuids,
      origin,
    )
  }

  if (imageDimensionNotes.length > 0) {
    return {
      ...result,
      messages: [
        ...result.messages,
        createUserMessage({
          content: imageDimensionNotes.join('\n'),
          isMeta: true,
        }),
      ],
    }
  }

  return result
}
