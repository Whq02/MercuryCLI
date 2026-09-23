
import { randomUUID, type UUID } from 'node:crypto'
import type { SetToolJSXFn, ToolUseContext } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { QuerySource } from '../../constants/querySource.js'
import type { ContentBlockParam, ImageBlockParam } from '../../types/wire.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  ProgressMessage,
  SystemMessage,
  UserMessage,
} from '../../types/message.js'
import type { EffortValue } from '../effort.js'
import type { PastedContent } from '../config.js'
import type { IDESelection } from '../../hooks/useIdeSelection.js'
import type { BatchedPrompt } from '../../types/textInputTypes.js'
import {
  createAttachmentMessage,
  getAttachmentMessages,
} from '../attachments.js'
import { executeUserPromptSubmitHooks } from '../hooks.js'
import {
  createSystemMessage,
  createUserMessage,
  extractTextContent,
} from '../messages.js'
import { maybeResizeAndDownsampleImageBlock } from '../imageResizer.js'
import { isStoredImageRef, readStoredImageRef, storeImages } from '../imageStore.js'
import { logError } from '../log.js'

export type ProcessUserInputContext = ToolUseContext &
  import('../../commands.js').LocalJSXCommandContext

export type ProcessUserInputBaseResult = {
  messages: (UserMessage | AssistantMessage | AttachmentMessage | SystemMessage | ProgressMessage)[]
  shouldQuery: boolean
  allowedTools?: string[]
  model?: string
  effort?: EffortValue
  resultText?: string
  nextInput?: string
  submitNextInput?: boolean
  commandRefused?: true
  hookBlocked?: true
}

const HOOK_TRUNCATION_LIMIT = 10_000
const HOOK_TOOL_USE_ID_PREFIX = 'hook-'

function truncateHookText(text: string): string {
  if (text.length <= HOOK_TRUNCATION_LIMIT) return text
  return `${text.slice(0, HOOK_TRUNCATION_LIMIT)}\n[Output truncated at ${HOOK_TRUNCATION_LIMIT} characters]`
}

type ProcessUserInputOptions = {
  input: string | ContentBlockParam[]
  preExpansionInput?: string
  mode: string
  setToolJSX: SetToolJSXFn
  context: ProcessUserInputContext
  pastedContents?: Record<number, PastedContent>
  ideSelection?: IDESelection | null
  messages: Message[]
  setUserInputOnProcessing?: (input: string | undefined) => void
  uuid?: string
  batchUuids?: string[]
  batchTail?: BatchedPrompt[]
  querySource: QuerySource
  canUseTool?: CanUseToolFn
  skipSlashCommands?: boolean
  bridgeOrigin?: boolean
  isMeta?: boolean
  skipAttachments?: boolean
  isAlreadyProcessing?: boolean
}


export async function processUserInput(
  options: ProcessUserInputOptions,
): Promise<ProcessUserInputBaseResult> {
  const { input, mode, context, isMeta, setUserInputOnProcessing } = options

  if (mode === 'prompt' && options.batchTail && options.batchTail.length > 0) {
    const prompts = [{ value: input, uuid: options.uuid }, ...options.batchTail]
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
          preExpansionInput: undefined,
          pastedContents: undefined,
          ideSelection: undefined,
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

  const promptText =
    typeof input === 'string' ? input : extractTextContent(input, '\n')
  const permissionMode = context.getAppState().toolPermissionContext.mode
  const hookMessages: Message[] = []
  for await (const result of executeUserPromptSubmitHooks(promptText, permissionMode, context)) {
    if (result.message?.type === 'progress') continue
    if (result.blockingError) {
      return {
        messages: [
          createSystemMessage(
            `Operation blocked by hook: ${result.blockingError.blockingError}\n\nOriginal prompt: ${promptText}`,
            'warning',
          ),
        ],
        shouldQuery: false,
        hookBlocked: true,
        resultText: `Operation blocked by hook: ${result.blockingError.blockingError}`,
        ...(base.allowedTools !== undefined ? { allowedTools: base.allowedTools } : {}),
      }
    }
    if (result.preventContinuation) {
      return {
        ...base,
        messages: [
          ...base.messages,
          createUserMessage({
            content: result.stopReason
              ? `Operation stopped by hook: ${result.stopReason}`
              : 'Operation stopped by hook',
          }),
        ],
        shouldQuery: false,
      }
    }
    if (result.additionalContexts && result.additionalContexts.length > 0) {
      hookMessages.push(
        createAttachmentMessage({
          type: 'hook_additional_context',
          content: result.additionalContexts.map(truncateHookText),
          hookName: result.hookSource ?? 'hook',
          toolUseID: `${HOOK_TOOL_USE_ID_PREFIX}${randomUUID()}`,
          hookEvent: 'UserPromptSubmit',
        }),
      )
      continue
    }
    if (result.message) {
      const attachment = (
        result.message as { attachment?: { type?: string; content?: string } }
      ).attachment
      if (attachment?.type === 'hook_success') {
        if (!attachment.content || attachment.content.trim() === '') continue
        hookMessages.push({
          ...result.message,
          attachment: { ...attachment, content: truncateHookText(attachment.content) },
        } as Message)
        continue
      }
      hookMessages.push(result.message as Message)
    }
  }
  return { ...base, messages: [...base.messages, ...hookMessages] }
}


function isImageBlock(block: ContentBlockParam): block is ImageBlockParam {
  return (block as { type?: string }).type === 'image'
}

async function processUserInputBase(
  options: ProcessUserInputOptions,
): Promise<ProcessUserInputBaseResult> {
  const {
    input,
    mode,
    context,
    setToolJSX,
    pastedContents,
    ideSelection,
    messages,
    uuid,
    querySource,
    canUseTool,
    bridgeOrigin,
    isMeta,
    skipAttachments,
    isAlreadyProcessing,
  } = options
  let skipSlashCommands = options.skipSlashCommands === true
  const imageMetadataTexts: string[] = []
  let normalizedInput: string | ContentBlockParam[] = input
  if (Array.isArray(input)) {
    const processed: ContentBlockParam[] = []
    for (const raw of input) {
      let block = raw
      if (isStoredImageRef(raw)) {
        const read = await readStoredImageRef(raw)
        if (read.kind === 'missing') {
          processed.push({ type: 'text', text: read.words } as ContentBlockParam)
          continue
        }
        block = read.block as ContentBlockParam
      }
      if (!isImageBlock(block)) {
        processed.push(block)
        continue
      }
      const source = block.source as { media_type?: string; mediaType?: string }
      if (source && source.media_type === undefined && source.mediaType !== undefined) {
        source.media_type = source.mediaType
      }
      try {
        const { block: resized, dimensions } = await maybeResizeAndDownsampleImageBlock(block)
        processed.push(resized)
        if (dimensions?.displayWidth && dimensions.displayHeight) {
          imageMetadataTexts.push(
            `[Image dimensions: ${dimensions.displayWidth}x${dimensions.displayHeight}]`,
          )
        }
      } catch (error) {
        logError(error)
        processed.push(block)
      }
    }
    normalizedInput = processed
  }

  let prompt: string | null
  let precedingBlocks: ContentBlockParam[] = []
  if (typeof normalizedInput === 'string') {
    prompt = normalizedInput
  } else {
    const last = normalizedInput[normalizedInput.length - 1]
    if (last && (last as { type?: string }).type === 'text') {
      prompt = (last as { text: string }).text
      precedingBlocks = normalizedInput.slice(0, -1)
    } else {
      prompt = null
      precedingBlocks = normalizedInput
    }
  }

  if (mode !== 'prompt' && prompt === null) {
    throw new Error(`processUserInput: mode ${mode} requires string input`)
  }

  const imageContentBlocks: ContentBlockParam[] = []
  const imagePasteIds: number[] = []
  if (pastedContents && Object.keys(pastedContents).length > 0) {
    void storeImages(pastedContents).catch(error => logError(error))
    const imageEntries = Object.entries(pastedContents)
      .map(([id, content]) => ({ id: Number(id), content }))
      .filter(entry => entry.content.type === 'image' && Boolean(entry.content.content))
      .sort((a, b) => a.id - b.id)
    const resizedBlocks = await Promise.all(
      imageEntries.map(async entry => {
        const block: ImageBlockParam = {
          type: 'image',
          source: {
            type: 'base64',
            media_type: (entry.content.mediaType ?? 'image/png') as ImageBlockParam['source'] extends { media_type: infer M } ? M : never,
            data: entry.content.content,
          },
        } as ImageBlockParam
        try {
          return { entry, ...(await maybeResizeAndDownsampleImageBlock(block)) }
        } catch (error) {
          logError(error)
          return { entry, block, dimensions: undefined }
        }
      }),
    )
    for (const { entry, block, dimensions } of resizedBlocks) {
      imageContentBlocks.push(block)
      imagePasteIds.push(entry.id)
      const original = (entry.content as { dimensions?: { width?: number; height?: number } })
        .dimensions
      const sourcePath = (entry.content as { sourcePath?: string }).sourcePath
      if (dimensions?.displayWidth && dimensions.displayHeight) {
        imageMetadataTexts.push(
          `[Image #${entry.id} dimensions: ${dimensions.displayWidth}x${dimensions.displayHeight}]`,
        )
      } else if (original?.width && original.height) {
        imageMetadataTexts.push(
          `[Image #${entry.id} dimensions: ${original.width}x${original.height}]`,
        )
      } else if (sourcePath) {
        imageMetadataTexts.push(`[Image #${entry.id} source: ${sourcePath}]`)
      }
    }
  }

  if (bridgeOrigin === true && typeof prompt === 'string' && prompt.startsWith('/')) {
    const { parseSlashCommand } = await import('../slashCommandParsing.js')
    const parsed = parseSlashCommand(prompt)
    if (parsed) {
      const command = context.options.commands.find(
        c => c.name === parsed.commandName || c.aliases?.includes(parsed.commandName) === true,
      )
      if (command) {
        if ((command as { isBridgeSafe?: boolean }).isBridgeSafe === true) {
          skipSlashCommands = false
        } else {
          const refusal = `The /${parsed.commandName} command cannot be used from the remote-control surface.`
          return {
            messages: [
              createUserMessage({ content: prompt }),
              createUserMessage({
                content: `<local-command-stdout>${refusal}</local-command-stdout>`,
              }),
            ],
            shouldQuery: false,
            resultText: refusal,
          }
        }
      }
    }
  }

  const attachmentMessages: AttachmentMessage[] = []
  const collectAttachments =
    skipAttachments !== true &&
    typeof prompt === 'string' &&
    (mode !== 'prompt' || skipSlashCommands || !prompt.startsWith('/'))
  if (collectAttachments) {
    try {
      for await (const attachment of getAttachmentMessages(
        prompt,
        context,
        ideSelection ?? null,
        [],
        messages,
        querySource,
        { localSubmission: mode !== 'prompt' },
      )) {
        attachmentMessages.push(attachment)
      }
    } catch (error) {
      logError(error)
    }
  }

  let result: ProcessUserInputBaseResult
  if (mode === 'bash') {
    const { processBashCommand } = await import('./processBashCommand.js')
    result = await processBashCommand(
      prompt as string,
      precedingBlocks,
      attachmentMessages,
      context,
      setToolJSX,
      uuid,
    )
  } else if (
    mode === 'prompt' &&
    typeof prompt === 'string' &&
    prompt.startsWith('/') &&
    !skipSlashCommands
  ) {
    const { processSlashCommand } = await import('./processSlashCommand.js')
    result = await processSlashCommand(
      prompt,
      precedingBlocks,
      imageContentBlocks,
      attachmentMessages,
      context,
      setToolJSX,
      uuid as UUID | undefined,
      isAlreadyProcessing,
      canUseTool,
    )
  } else {
    const { processTextPrompt } = await import('./processTextPrompt.js')
    result = processTextPrompt(
      normalizedInput,
      imageContentBlocks,
      imagePasteIds,
      attachmentMessages,
      uuid as UUID | undefined,
      context.getAppState().toolPermissionContext.mode,
      isMeta,
      options.batchUuids,
    )
  }

  if (imageMetadataTexts.length > 0) {
    result = {
      ...result,
      messages: [
        ...result.messages,
        createUserMessage({ content: imageMetadataTexts.join('\n'), isMeta: true }),
      ],
    }
  }
  return result
}
