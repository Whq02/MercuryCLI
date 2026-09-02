// ============================================================================
//  The submission pipeline entry: normalise input, resize images, store
//  pastes, collect attachments, route by mode, then run the submit hooks.
//
//  Observability contract (consumed by the status line — the mark and
//  stage names are contract data): process_user_input_base_start/_end
//  bracket the base pipeline, the stage user_prompt_hooks brackets the
//  hook loop, and image_processing / pasted_image_processing /
//  attachment_loading pairs bracket their phases inside the base pipeline.
// ============================================================================

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
import { storeImages } from '../imageStore.js'
import {
  getActivePulseTrace,
  pulseMark,
  pulseStageEnd,
  pulseStageStart,
  setPulsePhase,
} from '../pulse/index.js'
import { logError } from '../log.js'

/** The execution context this pipeline runs in: the tool-use context
 *  intersected with the local-JSX command context. */
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
  /** The asked command did NOT run — resultText is a typed refusal (the
   *  unavailable family: retired, concourse-off, interactive-only, sign-in,
   *  enablement), not a result. The headless road answers it as an error
   *  envelope (sentence on stderr, exit 1); interactive surfaces ignore it
   *  (the transcript row is the answer there). */
  commandRefused?: true
  /** A UserPromptSubmit hook BLOCKED the prompt (exit-2 contract) — the
   *  model never ran. Rides the commandRefused groove exactly: the headless
   *  envelope carries is_error with the reason as its result text (stderr +
   *  exit 1), so a script behind a policy hook can tell "the model
   *  answered" from "the policy stopped it" (FC-019); interactive surfaces
   *  ignore it — the warning transcript row is the answer there. */
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
  /** Pre-expansion copy, for keyword detection — pasted content containing
   *  a trigger word must not fire it. */
  preExpansionInput?: string
  mode: string
  setToolJSX: SetToolJSXFn
  context: ProcessUserInputContext
  pastedContents?: Record<number, PastedContent>
  ideSelection?: IDESelection | null
  messages: Message[]
  /** The UI echo callback; absent for headless callers with no UI to echo into. */
  setUserInputOnProcessing?: (input: string | undefined) => void
  uuid?: string
  querySource: QuerySource
  canUseTool?: CanUseToolFn
  skipSlashCommands?: boolean
  bridgeOrigin?: boolean
  isMeta?: boolean
  skipAttachments?: boolean
  isAlreadyProcessing?: boolean
}

// ── the entry point ─────────────────────────────────────────────────────────

export async function processUserInput(
  options: ProcessUserInputOptions,
): Promise<ProcessUserInputBaseResult> {
  const { input, mode, context, isMeta, setUserInputOnProcessing } = options

  // In prompt mode with string input — and NOT a meta submission — the
  // input echoes into the UI immediately so the operator sees their prompt
  // while processing continues. Meta submissions run invisibly.
  if (mode === 'prompt' && typeof input === 'string' && isMeta !== true) {
    setUserInputOnProcessing?.(input)
  }

  const generation = getActivePulseTrace()?.generation
  pulseMark('process_user_input_base_start', undefined, generation)
  const base = await processUserInputBase(options)
  pulseMark('process_user_input_base_end', undefined, generation)
  if (!base.shouldQuery) return base

  // The submit hooks run over the input's text content and the current
  // permission mode. extractTextContent takes the BLOCK ARRAY itself — the
  // previous shape wrapped it in a message object behind an `as never` cast,
  // so every block-array prompt (the ACP/SDK image+resource path) threw
  // "filter is not a function" and killed the turn (LANE ACP layer-2 fix).
  const promptText =
    typeof input === 'string' ? input : extractTextContent(input, '\n')
  const permissionMode = context.getAppState().toolPermissionContext.mode
  pulseStageStart('user_prompt_hooks', undefined, generation)
  if (generation !== undefined) setPulsePhase(generation, 'preparing', { reason: 'hooks' })
  try {
    const hookMessages: Message[] = []
    for await (const result of executeUserPromptSubmitHooks(promptText, permissionMode, context)) {
      if (result.message?.type === 'progress') continue
      if (result.blockingError) {
        // Blocking discards EVERYTHING: one warning-level system message
        // conveying the block and repeating the original prompt, querying
        // disabled, the allowed-tool list preserved.
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
        // This literal IS the Attachment union's hook_additional_context
        // member (content: string[]) — no cast. A second `as never` used to
        // sit here (the same class as the block-array turn-killer above);
        // it hid nothing, and removing it lets the compiler re-verify the
        // shape on every future edit. (LANE P3.)
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
          // An empty hook-success attachment is skipped; a non-empty one is
          // the second (and only other) truncation target.
          if (!attachment.content || attachment.content.trim() === '') continue
          hookMessages.push({
            ...result.message,
            attachment: { ...attachment, content: truncateHookText(attachment.content) },
          } as Message)
          continue
        }
        // Every other emitted hook message arrives whole.
        hookMessages.push(result.message as Message)
      }
    }
    return { ...base, messages: [...base.messages, ...hookMessages] }
  } finally {
    pulseStageEnd('user_prompt_hooks', undefined, generation)
  }
}

// ── the base pipeline ───────────────────────────────────────────────────────

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
  const generation = getActivePulseTrace()?.generation

  // Block-array input: every image block resizes and downsamples FIRST, its
  // dimensions recorded as metadata, and the processed blocks REPLACE the
  // originals — the normalised blocks are what reach the model. The
  // media-type spelling of bridge inputs is repaired here too.
  const imageMetadataTexts: string[] = []
  let normalizedInput: string | ContentBlockParam[] = input
  if (Array.isArray(input)) {
    pulseMark('image_processing_start', undefined, generation)
    const processed: ContentBlockParam[] = []
    for (const block of input) {
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
    pulseMark('image_processing_end', undefined, generation)
  }

  // The prompt string: a block array whose LAST block is text yields it as
  // the prompt with the earlier blocks preceding; otherwise every block
  // precedes and there is no prompt string.
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

  // Pasted images: valid image pastes extract in order with their ids; ALL
  // pasted contents store to disk so the model can reference the paths;
  // each image resizes in parallel; metadata text prefers resized
  // dimensions, then original dimensions, then a source-path line.
  const imageContentBlocks: ContentBlockParam[] = []
  const imagePasteIds: number[] = []
  if (pastedContents && Object.keys(pastedContents).length > 0) {
    pulseMark('pasted_image_processing_start', undefined, generation)
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
    pulseMark('pasted_image_processing_end', undefined, generation)
  }

  // Bridge-safe slash override: a bridge-origin slash command resolves
  // here. A bridge-safe command executes; a known-but-unsafe one
  // short-circuits with an honest refusal; an unknown or unparseable slash
  // falls through to plain text (a remote user typing a shrug must not be
  // told they invoked an unknown skill).
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

  // Attachments collect unless suppressed, and only when the prompt is a
  // string and either the mode is not prompt, slash handling is skipped, or
  // the input does not start with a slash (slash commands collect their
  // own). Non-prompt modes are LOCAL SUBMISSIONS: at-mentions and queued
  // state still collect, but model-bound-task producers skip.
  const attachmentMessages: AttachmentMessage[] = []
  const collectAttachments =
    skipAttachments !== true &&
    typeof prompt === 'string' &&
    (mode !== 'prompt' || skipSlashCommands || !prompt.startsWith('/'))
  if (collectAttachments) {
    pulseMark('attachment_loading_start', undefined, generation)
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
    pulseMark('attachment_loading_end', undefined, generation)
  }

  // Routing: bash → the shell path; a slash-prefixed string in prompt mode
  // with slash handling enabled → the command path; everything else → the
  // plain-prompt path. Both specialised paths load lazily.
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
    )
  }

  // Collected image metadata rides ONE extra meta user message, appended
  // last (model-visible, user-hidden) — on every path.
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
