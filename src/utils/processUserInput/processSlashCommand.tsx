
import * as React from 'react'
import { randomUUID, type UUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { Box, Text } from '../../ink.js'
import type { SetToolJSXFn, ToolUseContext } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { Command } from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { builtinCommands, commandOffInPlainWorld, commandRetired, commandSeat, getCommandName, isCommandEnabled, meetsAvailabilityRequirement } from '../../commands.js'
import { generateCommandSuggestions } from '../suggestions/commandSuggestions.js'
import { concourseOffSentence } from '../../context/surfaceRoute.js'
import { markTransitionStart } from '../observability/frictionStopwatch.js'
import {
  COMMAND_ARGS_TAG,
  COMMAND_MESSAGE_TAG,
  COMMAND_NAME_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from '../../constants/xml.js'
import { NO_CONTENT_MESSAGE } from '../../constants/messages.js'
import type { ContentBlockParam } from '../../types/wire.js'
import type {
  AttachmentMessage,
  Message,
  UserMessage,
} from '../../types/message.js'
import {
  createAttachmentMessage,
  getAttachmentMessages,
} from '../attachments.js'
import { isFullscreenEnvEnabled } from '../fullscreen.js'
import {
  executeUserPromptExpansionHooks,
} from '../hooks.js'
import {
  createCommandInputMessage,
  createCompactBoundaryMessage,
  createSyntheticUserCaveatMessage,
  createSystemMessage,
  createUserMessage,
  INTERRUPT_MESSAGE,
  isCompactBoundaryMessage,
} from '../messages.js'
import { getPlatform } from '../platform.js'
import { parseSlashCommand } from '../slashCommandParsing.js'
import { logError } from '../log.js'
import { logForDebugging } from '../debug.js'
import { resetMicrocompactState } from '../../services/compact/microCompact.js'
import { recordSkillUsage } from '../suggestions/skillUsageTracking.js'
import { getAgentContext } from '../agentContext.js'
import { addInvokedSkill, getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { addSessionHook } from '../hooks/sessionHooks.js'
import type { HookMatcher } from '../../schemas/hooks.js'
import type { HookEvent } from '../../entrypoints/agentSdkTypes.js'
import { getSessionId } from '../../bootstrap/state.js'
import { noteCompanionSurfaceOpened } from '../cockpit/critterProfile.js'
import { isRestrictedToExtensionsOnly } from '../settings/extensionOnlyPolicy.js'
import { parseSlashCommandToolsFromFrontmatter } from '../markdownConfigLoader.js'
import type {
  ProcessUserInputBaseResult,
  ProcessUserInputContext,
} from './processUserInput.js'

const UNKNOWN_COMMAND_PREFIX = 'Unknown skill'

export function resolveUnknownSlashName(input: string, commands: Command[]): string | undefined {
  const trimmed = input.trimStart()
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return undefined
  const spaceIndex = trimmed.indexOf(' ')
  const slashPrefixed = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)
  const name = slashPrefixed.slice(1).trim()
  if (name === '' || !looksLikeCommand(name)) return undefined
  if (isExistingPath(slashPrefixed)) return undefined
  return findCommand(commands, name) === undefined ? name : undefined
}

export function unknownCommandLine(name: string, commands: Command[]): string {
  let near: string | undefined
  try {
    const top = generateCommandSuggestions(`/${name}`, commands)[0]
    const meta = top?.metadata as Command | undefined
    if (meta !== undefined && typeof meta === 'object' && typeof meta.type === 'string') near = getCommandName(meta)
  } catch {
  }
  return `Unknown command: /${name}${near !== undefined && near !== name ? ` — closest: /${near}` : ''} · /help lists commands`
}


export function looksLikeCommand(commandName: string): boolean {
  return /^[a-zA-Z0-9:_-]+$/.test(commandName)
}

function isExistingPath(slashPrefixed: string): boolean {
  try {
    statSync(slashPrefixed)
    return true
  } catch {
    return false
  }
}


export function formatSkillLoadingMetadata(
  skillName: string,
  progressMessage?: string,
): string {
  void progressMessage
  return `<${COMMAND_MESSAGE_TAG}>${skillName}</${COMMAND_MESSAGE_TAG}><${COMMAND_NAME_TAG}>${skillName}</${COMMAND_NAME_TAG}><skill-format>skill</skill-format>`
}

export function formatCommandLoadingMetadata(fullName: string, args: string): string {
  const argsTag = args ? `<${COMMAND_ARGS_TAG}>${args}</${COMMAND_ARGS_TAG}>` : ''
  return `<${COMMAND_MESSAGE_TAG}>${fullName}</${COMMAND_MESSAGE_TAG}><${COMMAND_NAME_TAG}>/${fullName}</${COMMAND_NAME_TAG}>${argsTag}`
}

export function unavailableCommandLine(real: Command): string {
  const name = getCommandName(real)
  const retired = commandRetired(real)
  if (retired !== undefined) {
    return `The /${name} command is retired — ${retired}.`
  }
  if (commandOffInPlainWorld(real)) {
    return `The /${name} command opens a Session Concourse surface — ${concourseOffSentence() ?? 'the Session Concourse is off in this boot'}.`
  }
  if (getIsNonInteractiveSession()) {
    if (real.type === 'local-jsx' || commandSeat(real) === 'screen') {
      return `The /${name} command is an interactive surface — it needs the foreground session and has no headless form.`
    }
    if (real.type === 'local' && real.supportsNonInteractive !== true) {
      return `The /${name} command is interactive-only — run it in the foreground session.`
    }
    if (real.type === 'prompt' && real.disableNonInteractive === true) {
      return `The /${name} command is not available in a headless run.`
    }
  }
  if (!meetsAvailabilityRequirement(real)) {
    return `The /${name} command needs an account this session is not signed in with — see /accounts.`
  }
  return `The /${name} command exists but is not enabled in this session.`
}

function stdoutWrapped(text: string): string {
  return `<${LOCAL_COMMAND_STDOUT_TAG}>${text}</${LOCAL_COMMAND_STDOUT_TAG}>`
}

function stderrWrapped(text: string): string {
  return `<${LOCAL_COMMAND_STDERR_TAG}>${text}</${LOCAL_COMMAND_STDERR_TAG}>`
}


function findCommand(commands: Command[], name: string): Command | undefined {
  return commands.find(
    command =>
      command.name === name ||
      command.aliases?.includes(name) === true ||
      getCommandName(command) === name,
  )
}


type ExpansionHookOutcome =
  | { kind: 'blocked'; result: ProcessUserInputBaseResult }
  | { kind: 'ok'; hookMessages: Message[] }

const HOOK_TRUNCATION_LIMIT = 10_000

function truncateHookText(text: string): string {
  if (text.length <= HOOK_TRUNCATION_LIMIT) return text
  return `${text.slice(0, HOOK_TRUNCATION_LIMIT)}\n[Output truncated at ${HOOK_TRUNCATION_LIMIT} characters]`
}

async function runExpansionHooks(
  command: Command,
  args: string,
  expansionType: 'slash_command' | 'mcp_prompt',
  fullCommandString: string,
  context: ToolUseContext,
): Promise<ExpansionHookOutcome> {
  const hookMessages: Message[] = []
  const permissionMode = context.getAppState().toolPermissionContext.mode
  for await (const result of executeUserPromptExpansionHooks(
    { name: command.name, source: (command as { source?: string }).source ?? 'built-in' },
    args,
    expansionType,
    fullCommandString,
    permissionMode,
    context,
  )) {
    if (result.blockingError) {
      return {
        kind: 'blocked',
        result: {
          messages: [
            createSystemMessage(
              `Operation blocked by hook: ${result.blockingError.blockingError}\n\nOriginal command: ${fullCommandString}`,
              'warning',
            ),
          ],
          shouldQuery: false,
        },
      }
    }
    if (result.preventContinuation) {
      return {
        kind: 'blocked',
        result: {
          messages: [
            createUserMessage({
              content: result.stopReason
                ? `Operation stopped by hook: ${result.stopReason}`
                : 'Operation stopped by hook',
            }),
          ],
          shouldQuery: false,
        },
      }
    }
    if (result.additionalContexts && result.additionalContexts.length > 0) {
      hookMessages.push(
        createAttachmentMessage({
          type: 'hook_additional_context',
          content: result.additionalContexts.map(truncateHookText),
          hookName: result.hookSource ?? 'hook',
          toolUseID: `hook-${randomUUID()}`,
          hookEvent: 'UserPromptExpansion',
        }),
      )
      continue
    }
    if (result.message) {
      const attachment = (result.message as { attachment?: { type?: string; content?: string } })
        .attachment
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
  return { kind: 'ok', hookMessages }
}


export async function processPromptSlashCommand(
  commandName: string,
  args: string,
  commands: Command[],
  context: ToolUseContext,
  imageContentBlocks: ContentBlockParam[] = [],
): Promise<ProcessUserInputBaseResult & { command: Command }> {
  const command = findCommand(commands, commandName)
  if (!command) {
    throw Object.assign(new Error(`Unknown command: ${commandName}`), {
      isMalformedCommand: true,
    })
  }
  if (command.type !== 'prompt') {
    throw new Error(
      `Command /${commandName} is not a prompt command — use the command directly in the main conversation.`,
    )
  }
  const result = await executePromptCommand(
    command as Command & { type: 'prompt' },
    commandName,
    args,
    context,
    imageContentBlocks,
    [],
  )
  return { ...result, command }
}

async function executePromptCommand(
  command: Command & { type: 'prompt' },
  commandName: string,
  args: string,
  context: ToolUseContext,
  imageContentBlocks: ContentBlockParam[],
  attachmentMessages: AttachmentMessage[],
  uuid?: UUID,
  setToolJSXForFork: SetToolJSXFn = () => {},
  canUseToolForFork?: CanUseToolFn,
): Promise<ProcessUserInputBaseResult> {
  const fullCommandString = args ? `/${commandName} ${args}` : `/${commandName}`
  const expansionType = (command as { isMcp?: boolean }).isMcp ? 'mcp_prompt' : 'slash_command'

  try {
    const hookOutcome = await runExpansionHooks(command, args, expansionType, fullCommandString, context)
    if (hookOutcome.kind === 'blocked') return hookOutcome.result
    const hookMessages = hookOutcome.hookMessages

    if (command.context === 'fork') {
      return await runForkedPromptCommand(
        command,
        commandName,
        args,
        context,
        hookMessages,
        setToolJSXForFork,
        canUseToolForFork,
      )
    }

    const expansion = await command.getPromptForCommand(args, context)

    const declaredHooks = command.hooks
    if (declaredHooks && !isRestrictedToExtensionsOnly('hooks')) {
      const setAppState = context.setAppState
      if (setAppState) {
        try {
          for (const [event, groups] of Object.entries(declaredHooks) as Array<[HookEvent, HookMatcher[] | undefined]>) {
            for (const group of groups ?? []) {
              for (const hook of group.hooks ?? []) {
                addSessionHook(
                  setAppState,
                  context.agentId ?? getSessionId(),
                  event,
                  group.matcher ?? '*',
                  hook,
                  undefined,
                  command.skillRoot,
                )
              }
            }
          }
        } catch (error) {
          logError(error)
        }
      }
    }

    const expansionText = expansion
      .map(block => (block.type === 'text' ? (block as { text: string }).text : ''))
      .join('\n')
    addInvokedSkill(
      command.name,
      command.source ?? command.name,
      expansionText,
      getAgentContext()?.agentId,
    )

    const isUserInvocable = command.userInvocable !== false
    if (isUserInvocable) {
      recordSkillUsage(command.name)
    }
    const metadata = isUserInvocable
      ? formatCommandLoadingMetadata(getCommandName(command), args)
      : formatSkillLoadingMetadata(command.name, command.progressMessage)

    const allowedTools = parseSlashCommandToolsFromFrontmatter(command.allowedTools)
    const model = command.model
    const effort = command.effort

    const contentBlocks: ContentBlockParam[] = [
      ...imageContentBlocks,
      ...expansion,
    ] as ContentBlockParam[]
    const extraAttachments: AttachmentMessage[] = []
    for await (const attachment of getAttachmentMessages(
      expansionText,
      context,
      null,
      [],
      undefined,
      undefined,
      { skipSkillDiscovery: true },
    )) {
      extraAttachments.push(attachment)
    }

    const metadataMessage = createUserMessage({
      content: metadata,
      ...(uuid ? { uuid } : {}),
    })
    const contentMessage = createUserMessage({ content: contentBlocks, isMeta: true })
    const permissionsAttachment = createAttachmentMessage({
      type: 'command_permissions',
      allowedTools,
      ...(model !== undefined ? { model } : {}),
    })

    return {
      messages: [
        metadataMessage,
        contentMessage,
        ...attachmentMessages,
        ...extraAttachments,
        ...hookMessages,
        permissionsAttachment,
      ],
      shouldQuery: true,
      allowedTools,
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
    }
  } catch (error) {
    const echoed = createUserMessage({
      content: formatCommandLoadingMetadata(commandName, args),
      ...(uuid ? { uuid } : {}),
    })
    if ((error as { name?: string } | null)?.name === 'AbortError') {
      return {
        messages: [echoed, createUserMessage({ content: INTERRUPT_MESSAGE })],
        shouldQuery: false,
      }
    }
    logError(error)
    return {
      messages: [
        echoed,
        createUserMessage({ content: stderrWrapped(String(error)) }),
      ],
      shouldQuery: false,
    }
  }
}


async function runForkedPromptCommand(
  command: Command & { type: 'prompt' },
  commandName: string,
  args: string,
  context: ToolUseContext,
  hookMessages: Message[],
  setToolJSX: SetToolJSXFn,
  canUseTool: CanUseToolFn | undefined,
): Promise<ProcessUserInputBaseResult> {
  const {
    extractResultText,
    getLastCacheSafeParams,
    prepareForkedCommandContext,
    runForkedAgent,
  } = await import('../forkedAgent.js')
  const echoed = createUserMessage({
    content: formatCommandLoadingMetadata(getCommandName(command), args),
  })
  try {
    const prepared = await prepareForkedCommandContext(command, args, context)
    const cacheSafeParams = getLastCacheSafeParams()
    if (!cacheSafeParams) {
      throw new Error('No cache-safe turn parameters are available yet for a forked command.')
    }
    const baseAgent = command.effort !== undefined
      ? { ...prepared.baseAgent, effort: command.effort }
      : prepared.baseAgent
    const promptMessages = [...prepared.promptMessages, ...hookMessages]

    let emitted = 0
    let responseLength = 0
    const renderProgress = (): void => {
      setToolJSX({
        jsx: (
          <Box flexDirection="column">
            <Text dimColor>{`/${commandName} running in a subagent (${emitted} message${emitted === 1 ? '' : 's'}, ${responseLength} chars)`}</Text>
          </Box>
        ),
        shouldHidePromptInput: true,
        shouldContinueAnimation: true,
        showSpinner: true,
      })
    }
    renderProgress()
    try {
      const result = await runForkedAgent({
        promptMessages,
        cacheSafeParams,
        canUseTool:
          canUseTool ?? (async () => ({ behavior: 'allow' as const, updatedInput: {} })),
        querySource: 'repl_main_thread',
        forkLabel: command.name,
        overrides: {
          getAppState: prepared.modifiedGetAppState,
          agentType: baseAgent.agentType,
        },
        onMessage: message => {
          if (message.type === 'assistant' || message.type === 'user') {
            emitted += 1
            if (message.type === 'assistant') {
              const content = message.message.content
              if (Array.isArray(content)) {
                for (const block of content) {
                  if ((block as { type?: string }).type === 'text') {
                    responseLength += ((block as { text?: string }).text ?? '').length
                  }
                }
              }
            }
            renderProgress()
          }
        },
      })
      const resultText = extractResultText(result.messages)
      return {
        messages: [echoed, createUserMessage({ content: stdoutWrapped(resultText) })],
        shouldQuery: false,
        resultText,
      }
    } finally {
      setToolJSX(null)
    }
  } catch (error) {
    logError(error)
    return {
      messages: [echoed, createUserMessage({ content: stderrWrapped(String(error)) })],
      shouldQuery: false,
    }
  }
}


export async function processSlashCommand(
  inputString: string,
  precedingInputBlocks: ContentBlockParam[],
  imageContentBlocks: ContentBlockParam[],
  attachmentMessages: AttachmentMessage[],
  context: ProcessUserInputContext,
  setToolJSX: SetToolJSXFn,
  uuid?: UUID,
  isAlreadyProcessing?: boolean,
  canUseTool?: CanUseToolFn,
): Promise<ProcessUserInputBaseResult> {
  const caveat = createSyntheticUserCaveatMessage()

  const parsed = parseSlashCommand(inputString)
  if (!parsed) {
    const explanation =
      'Commands are in the form `/command-name [arguments]` — a slash, a command name, then optional arguments.'
    return {
      messages: [caveat, ...attachmentMessages, createUserMessage({ content: explanation })],
      shouldQuery: false,
      resultText: explanation,
    }
  }
  const { commandName, args } = parsed
  const commands = context.options.commands
  const command = findCommand(commands, commandName)

  if (command && !isCommandEnabled(command)) {
    const line = unavailableCommandLine(command)
    return {
      messages: [caveat, ...attachmentMessages, createUserMessage({ content: line })],
      shouldQuery: false,
      resultText: line,
      commandRefused: true,
    }
  }

  if (!command) {
    const registered = findCommand([...builtinCommands()], commandName)
    if (registered) {
      if (registered.type === 'local' && registered.userPrivate === true && isCommandEnabled(registered)) {
        try {
          const module = await registered.load()
          const result = await module.call(args, context as unknown as Parameters<typeof module.call>[1])
          const text = result.type === 'text' ? result.value : ''
          return { messages: [], shouldQuery: false, ...(text !== '' ? { resultText: text } : {}) }
        } catch (error) {
          logError(error)
          return { messages: [], shouldQuery: false, resultText: `/${commandName} failed — ${String(error)}` }
        }
      }
      const line = unavailableCommandLine(registered)
      return {
        messages: [caveat, ...attachmentMessages, createUserMessage({ content: line })],
        shouldQuery: false,
        resultText: line,
        commandRefused: true,
      }
    }
    if (looksLikeCommand(commandName) && !isExistingPath(`/${commandName}`)) {
      const unknownLine = `${UNKNOWN_COMMAND_PREFIX}: ${commandName}`
      const messages: Message[] = [
        caveat,
        ...attachmentMessages,
        createUserMessage({ content: unknownLine }),
      ]
      if (args) {
        messages.push(
          createSystemMessage(
            `The skill "${commandName}" was not found; its arguments were: ${args}`,
            'warning',
          ),
        )
      }
      return { messages, shouldQuery: false, resultText: unknownLine }
    }
    const promptMessage = createUserMessage({
      content: inputString,
      uuid: (uuid ?? randomUUID()) as UUID,
    })
    return {
      messages: [promptMessage, ...attachmentMessages],
      shouldQuery: true,
    }
  }

  try {
    noteCompanionSurfaceOpened(command.name)
  } catch {
  }

  if (command.userInvocable === false) {
    const echoed = createUserMessage({
      content: formatCommandLoadingMetadata(getCommandName(command), args),
      ...(uuid ? { uuid } : {}),
    })
    return {
      messages: [
        echoed,
        createUserMessage({
          content: `The ${command.name} skill can only be invoked by the assistant. Ask for it by name instead.`,
        }),
      ],
      shouldQuery: false,
    }
  }

  try {
    let result: ProcessUserInputBaseResult
    switch (command.type) {
      case 'local-jsx':
        result = await runLocalJsxCommand(command, args, context, setToolJSX)
        break
      case 'local':
        result = await runLocalCommand(command, commandName, args, context, uuid)
        break
      default:
        result = await executePromptCommand(
          command as Command & { type: 'prompt' },
          commandName,
          args,
          context,
          imageContentBlocks,
          attachmentMessages,
          uuid,
          setToolJSX,
          canUseTool,
        )
        break
    }
    void isAlreadyProcessing
    void canUseTool

    if (result.messages.length === 0) {
      return {
        messages: [],
        shouldQuery: false,
        ...(result.model !== undefined ? { model: result.model } : {}),
        ...(result.nextInput !== undefined ? { nextInput: result.nextInput } : {}),
        ...(result.submitNextInput !== undefined
          ? { submitNextInput: result.submitNextInput }
          : {}),
      }
    }
    const second = result.messages[1]
    const secondIsUnknown =
      result.messages.length === 2 &&
      second?.type === 'user' &&
      typeof (second as UserMessage).message.content === 'string' &&
      ((second as UserMessage).message.content as string).startsWith(UNKNOWN_COMMAND_PREFIX)
    if (secondIsUnknown) {
      return { ...result, messages: [caveat, ...result.messages] }
    }
    const allLocalCommand = result.messages.every(
      m => m.type === 'system' && (m as { subtype?: string }).subtype === 'local_command',
    )
    const firstIsCompactBoundary =
      result.messages[0] !== undefined && isCompactBoundaryMessage(result.messages[0])
    if (!result.shouldQuery && !allLocalCommand && !firstIsCompactBoundary) {
      return { ...result, messages: [caveat, ...result.messages] }
    }
    return result
  } catch (error) {
    if ((error as { isMalformedCommand?: boolean } | null)?.isMalformedCommand === true) {
      return {
        messages: [createUserMessage({ content: String((error as Error).message) })],
        shouldQuery: false,
      }
    }
    throw error
  }
}


async function runLocalJsxCommand(
  command: Command & { type: 'local-jsx' },
  args: string,
  context: ProcessUserInputContext,
  setToolJSX: SetToolJSXFn,
): Promise<ProcessUserInputBaseResult> {
  return new Promise(resolve => {
    let settled = false
    const finish = (result: ProcessUserInputBaseResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const done: LocalJSXCommandOnDone = (resultText, options): void => {
      const display = options?.display ?? 'user'
      const metaMessages = (options?.metaMessages ?? []).map(text =>
        createUserMessage({ content: text, isMeta: true }),
      )
      const forwarded = {
        shouldQuery: options?.shouldQuery ?? false,
        ...(options?.nextInput !== undefined ? { nextInput: options.nextInput } : {}),
        ...(options?.submitNextInput !== undefined
          ? { submitNextInput: options.submitNextInput }
          : {}),
      }
      if (display === 'skip') {
        finish({ messages: [], ...forwarded })
        return
      }
      const echoed = createCommandInputMessage(
        formatCommandLoadingMetadata(getCommandName(command), args),
      )
      if (display === 'system') {
        const isDismissal =
          typeof resultText === 'string' && /closed|dismissed|cancelled/i.test(resultText)
        if (isFullscreenEnvEnabled() && isDismissal) {
          finish({ messages: [...metaMessages], ...forwarded })
          return
        }
        finish({
          messages: [
            echoed,
            createCommandInputMessage(stdoutWrapped(resultText ?? NO_CONTENT_MESSAGE)),
            ...metaMessages,
          ],
          ...forwarded,
          ...(resultText ? { resultText } : {}),
        })
        return
      }
      finish({
        messages: [
          createUserMessage({
            content: formatCommandLoadingMetadata(getCommandName(command), args),
          }),
          createUserMessage({
            content: stdoutWrapped(resultText ?? NO_CONTENT_MESSAGE),
          }),
          ...metaMessages,
        ],
        ...forwarded,
        ...(resultText ? { resultText } : {}),
      })
    }

    void (async () => {
      try {
        markTransitionStart(getCommandName(command) === 'model' ? 'picker-open' : 'screen-switch')
        const module = await command.load()
        const element = await module.call(done, context, args)
        if ((context as { options?: { isNonInteractiveSession?: boolean } }).options
          ?.isNonInteractiveSession === true && element) {
          finish({ messages: [], shouldQuery: false })
          return
        }
        if (element === null || element === undefined) {
          return
        }
        if (settled) {
          return
        }
        setToolJSX({
          jsx: element as React.ReactNode,
          shouldHidePromptInput: true,
          showSpinner: false,
          isLocalJSXCommand: true,
          isImmediate: command.immediate === true,
        })
      } catch (error) {
        logError(error)
        setToolJSX({
          jsx: null,
          shouldHidePromptInput: false,
          isLocalJSXCommand: false,
          clearLocalJSX: true,
        })
        finish({ messages: [], shouldQuery: false })
      }
    })()
  })
}


async function runLocalCommand(
  command: Command & { type: 'local' },
  commandName: string,
  args: string,
  context: ProcessUserInputContext,
  uuid?: UUID,
): Promise<ProcessUserInputBaseResult> {
  const sensitive = command.isSensitive === true
  const echoedArgs = sensitive && args.trim() !== '' ? '[REDACTED]' : args
  const echoed = createUserMessage({
    content: formatCommandLoadingMetadata(getCommandName(command), echoedArgs),
    ...(uuid ? { uuid } : {}),
  })
  try {
    const module = await command.load()
    const result = await module.call(args, context)
    if (command.userPrivate === true) {
      const text = result.type === 'text' ? result.value : ''
      return { messages: [], shouldQuery: false, ...(text !== '' ? { resultText: text } : {}) }
    }
    if (result.type === 'skip') {
      return { messages: [], shouldQuery: false }
    }
    if (result.type === 'compact') {
      resetMicrocompactState(undefined)
      const compaction = result.compactionResult
      const display = result.displayText ?? compaction.userDisplayMessage
      const displayMessage = display
        ? {
            ...createCommandInputMessage(stdoutWrapped(display)),
            timestamp: new Date(Date.now() + 2).toISOString(),
          }
        : undefined
      return {
        messages: [
          compaction.boundaryMarker,
          ...compaction.summaryMessages,
          ...(compaction.messagesToKeep ?? []),
          createSyntheticUserCaveatMessage(),
          echoed,
          ...(displayMessage ? [displayMessage] : []),
          ...compaction.attachments,
          ...compaction.hookResults,
        ],
        shouldQuery: false,
        ...(display ? { resultText: display } : {}),
      }
    }
    const text = result.value
    return {
      messages: [echoed, createCommandInputMessage(stdoutWrapped(text))],
      shouldQuery: false,
      resultText: text,
    }
  } catch (error) {
    logError(error)
    return {
      messages: [echoed, createCommandInputMessage(stderrWrapped(String(error)))],
      shouldQuery: false,
    }
  }
}
