import { featureReached } from '../../platform/substrate/featureReached.js'

import * as React from 'react'
import type { UUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { Box, Text } from '../../screen/themedRenderer.js'
import type { CanUseToolFn, SetToolJSXFn, ToolUseContext } from '../../tools/kit/tool.js'
import type { Command } from '../../commands/catalogue/commands.js'
import type { LocalJSXCommandOnDone } from '../../commands/catalogue/command.js'
import { builtinCommands, commandOffInPlainWorld, commandSeat, findBundledPromptSkill, findCommand, getCommandName, isCommandEnabled, meetsAvailabilityRequirement, runsPromptWithArgs } from '../../commands/catalogue/commands.js'
import samples, { SAMPLES_OFF_SENTENCE } from '../../commands/samples/index.js'
import { bareUsageLine, requiresArgument } from '../../integrations/skills/argumentHint.js'
import { generateCommandSuggestions } from '../../screen/suggestions/commandSuggestions.js'
import { concourseOffSentence } from '../../screen/routes/surfaceRoute.js'
import { markTransitionStart } from '../../platform/observability/frictionStopwatch.js'
import {
  COMMAND_MESSAGE_TAG,
  COMMAND_NAME_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from '../message-shapes/messageTags.js'
import { NO_CONTENT_MESSAGE } from '../message-shapes/noContentMessage.js'
import type { ContentBlockParam } from '../message-shapes/wire.js'
import type {
  AttachmentMessage,
  Message,
  UserMessage,
} from '../message-shapes/message.js'
import {
  createAttachmentMessage,
  getAttachmentMessages,
} from '../attachments/attachments.js'
import { isFullscreenEnvEnabled } from '../../screen/fullscreen-layout/fullscreen.js'
import {
  createCommandInputMessage,
  createSyntheticUserCaveatMessage,
  createSystemMessage,
  createUserMessage,
  formatCommandInputTags,
  INTERRUPT_MESSAGE,
  isFoldBoundaryMessage,
} from '../messages/messages.js'
import { parseSlashCommand } from '../../commands/catalogue/slashCommandParsing.js'
import { logError } from '../../platform/logs/errorLog.js'
import { isNothingToFoldMessage } from '../compaction/fold/foldLimits.js'
import { recordSkillUsage } from '../../screen/suggestions/skillUsage.js'
import { getCrewmateContext } from '../../crew/agents/crewmateContext.js'
import { addInvokedSkill, getIsNonInteractiveSession } from '../../boot/process-state/processState.js'
import { registerSkillHooks } from '../../integrations/event-hooks/registerFrontmatterHooks.js'

import { getSessionId } from '../../boot/process-state/processState.js'
import { isRestrictedToExtensionsOnly } from '../../platform/settings/extensionOnlyPolicy.js'
import { parseSlashCommandToolsFromFrontmatter } from '../../platform/settings/markdownConfigLoader.js'
import type {
  ProcessUserInputBaseResult,
  ProcessUserInputContext,
} from './processUserInput.js'
import { isRecord } from '../../platform/primitives/isRecord.js'
import { passedOver } from '../../platform/errors/passedOver.js'
class TaggedMalformedCommandError extends Error {
  readonly isMalformedCommand = true
}

const UNKNOWN_COMMAND_PREFIX = 'Unknown skill'

export function resolveUnknownSlashName(input: string, commands: Command[]): string | undefined {
  const trimmed = input.trimStart()
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return undefined
  const spaceIndex = trimmed.indexOf(' ')
  const slashPrefixed = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)
  const name = slashPrefixed.slice(1).trim()
  if (name === '' || !looksLikeCommand(name)) return undefined
  if (isExistingPath(slashPrefixed)) return undefined
  return findCommand(name, commands) === undefined ? name : undefined
}

export function unknownCommandLine(name: string, commands: Command[]): string {
  const registered = name === '' ? undefined : findCommand(name, [...builtinCommands()])
  if (registered !== undefined) return unavailableCommandLine(registered)
  let near: string | undefined
  if (name !== '') {
    try {
      const byNameAlone = commands
        .filter(command => command.type !== 'prompt' && command.isHidden !== true)
        .map(command => ({ ...command, description: '' }) as Command)
      const top = generateCommandSuggestions(`/${name}`, byNameAlone)[0]
      const meta = top?.metadata as Command | undefined
      if (meta !== undefined && typeof meta === 'object' && typeof meta.type === 'string') near = getCommandName(meta)
    } catch (error) {
      passedOver(error)
    }
  }
  return `Unknown command: /${name}${near !== undefined && near !== name ? ` — closest: /${near}` : ''} · /help lists commands`
}


function looksLikeCommand(commandName: string): boolean {
  return /^[a-zA-Z0-9:_-]+$/.test(commandName)
}

function isExistingPath(slashPrefixed: string): boolean {
  try {
    statSync(slashPrefixed)
    return true
  } catch (error) {
    passedOver(error)
    return false
  }
}


export function formatSkillLoadingMetadata(
  skillName: string,
  _progressMessage?: string,
): string {
  return `<${COMMAND_MESSAGE_TAG}>${skillName}</${COMMAND_MESSAGE_TAG}><${COMMAND_NAME_TAG}>${skillName}</${COMMAND_NAME_TAG}><skill-format>skill</skill-format>`
}

export function unavailableCommandLine(real: Command, args = ''): string {
  const name = getCommandName(real)
  if (commandOffInPlainWorld(real)) {
    return `The /${name} command opens a Session Concourse surface — ${concourseOffSentence() ?? 'the Session Concourse is off in this boot'}.`
  }
  if (real.name === samples.name && !isCommandEnabled(real)) {
    return SAMPLES_OFF_SENTENCE
  }
  if (getIsNonInteractiveSession()) {
    if (real.type === 'local-jsx' || commandSeat(real) === 'screen') {
      const verbs = real.type === 'local-jsx' ? real.headlessVerbs : undefined
      if (verbs === undefined || verbs.length === 0) {
        const hint = real.argumentHint?.trim() ?? ''
        if (runsPromptWithArgs(real, hint || 'words')) {
          const tail = hint !== '' ? `: /${name} ${hint}` : ''
          return `The /${name} command is an interactive surface — it needs the foreground session; with words it runs here too${tail}.`
        }
        return `The /${name} command is an interactive surface — it needs the foreground session and has no headless form.`
      }
      const typed = args.trim().split(/\s+/)[0] ?? ''
      if (!verbs.includes(typed)) {
        const offered = verbs.map(verb => `/${name} ${verb}`).join(' · ')
        return `The /${name} command is interactive in this form — headless it answers only ${offered}.`
      }
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


function finalizeCommandResult(
  result: ProcessUserInputBaseResult,
  caveat: UserMessage,
): ProcessUserInputBaseResult {
  if (result.messages.length === 0) {
    return {
      messages: [],
      shouldStartTurn: false,
      ...(result.model !== undefined ? { model: result.model } : {}),
      ...(result.nextInput !== undefined ? { nextInput: result.nextInput } : {}),
      ...(result.submitNextInput !== undefined
        ? { submitNextInput: result.submitNextInput }
        : {}),
      ...(result.resultText !== undefined ? { resultText: result.resultText } : {}),
    }
  }
  const isAllLocalCommandSystem = result.messages.every(
    (msg: Message) => msg.type === 'system' && msg.subtype === 'local_command',
  )
  const startsAtFoldBoundary = isFoldBoundaryMessage(result.messages[0]!)
  const isTwoRowUnknown =
    result.messages.length === 2 &&
    result.messages.some(
      (msg: Message) =>
        msg.type === 'user' &&
        typeof msg.message.content === 'string' &&
        msg.message.content.includes(UNKNOWN_COMMAND_PREFIX),
    )
  if (
    isTwoRowUnknown ||
    (!result.shouldStartTurn && !isAllLocalCommandSystem && !startsAtFoldBoundary)
  ) {
    return {
      ...result,
      messages: [caveat, ...result.messages],
    }
  }
  return result
}

export async function processPromptSlashCommand(
  commandName: string,
  args: string,
  commands: Command[],
  context: ToolUseContext,
  imageContentBlocks?: ContentBlockParam[],
): Promise<ProcessUserInputBaseResult & { command: Command }> {
  const command = findCommand(commandName, commands)
  if (command === undefined) {
    throw new TaggedMalformedCommandError(`Unknown command: ${commandName}`)
  }
  if (command.type !== 'prompt') {
    throw new Error(
      `Command /${commandName} is not a prompt command — use the command directly in the main conversation.`,
    )
  }
  const result = await executePromptCommand(
    command,
    commandName,
    args,
    context,
    imageContentBlocks ?? [],
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
  try {
    featureReached('command', command.name)
    const hookMessages: Message[] = []

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
    if (declaredHooks && !isRestrictedToExtensionsOnly('hooks') && context.setAppState && command.skillRoot !== undefined) {
      try {
        registerSkillHooks(context.setAppState, { sessionId: String(getSessionId()), ...(context.agentId !== undefined ? { crewmateId: context.agentId } : {}) }, declaredHooks, { name: command.name, root: command.skillRoot })
      } catch (error) {
        logError(error)
      }
    }

    const expansionText = expansion
      .map(block => (block.type === 'text' ? (block as { text: string }).text : ''))
      .join('\n')
    addInvokedSkill(
      command.name,
      command.source ?? command.name,
      expansionText,
      getCrewmateContext()?.agentId,
    )

    const isUserInvocable = command.userInvocable !== false
    if (isUserInvocable) {
      recordSkillUsage(command.name)
    }
    const metadata = isUserInvocable
      ? formatCommandInputTags(getCommandName(command), args)
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
      [],
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
      shouldStartTurn: true,
      allowedTools,
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
    }
  } catch (error) {
    const echoed = createUserMessage({
      content: formatCommandInputTags(commandName, args),
      ...(uuid ? { uuid } : {}),
    })
    if ((error as { name?: string } | null)?.name === 'AbortError') {
      return {
        messages: [echoed, createUserMessage({ content: INTERRUPT_MESSAGE })],
        shouldStartTurn: false,
      }
    }
    logError(error)
    return {
      messages: [
        echoed,
        createUserMessage({ content: stderrWrapped(String(error)) }),
      ],
      shouldStartTurn: false,
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
  } = await import('../../crew/agents/forkedAgent.js')
  const echoed = createUserMessage({
    content: formatCommandInputTags(getCommandName(command), args),
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
            <Text dimColor>{`/${commandName} running in a crewmate (${emitted} message${emitted === 1 ? '' : 's'}, ${responseLength} chars)`}</Text>
          </Box>
        ),
        shouldHideComposer: true,
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
        querySource: 'main_thread',
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
        shouldStartTurn: false,
        resultText,
      }
    } finally {
      setToolJSX(null)
    }
  } catch (error) {
    logError(error)
    return {
      messages: [echoed, createUserMessage({ content: stderrWrapped(String(error)) })],
      shouldStartTurn: false,
    }
  }
}

export async function processSlashCommand(
  inputString: string,
  imageContentBlocks: ContentBlockParam[],
  attachmentMessages: AttachmentMessage[],
  context: ProcessUserInputContext,
  setToolJSX: SetToolJSXFn,
  uuid?: UUID,
  canUseTool?: CanUseToolFn,
): Promise<ProcessUserInputBaseResult> {
  const caveat = createSyntheticUserCaveatMessage()
  const rawInputAnswer = (): ProcessUserInputBaseResult => ({
    messages: [
      createUserMessage({
        content: inputString,
        ...(uuid ? { uuid } : {}),
      }),
      ...attachmentMessages,
    ],
    shouldStartTurn: true,
  })
  const parsed = parseSlashCommand(inputString)
  if (!parsed) return rawInputAnswer()
  const { commandName, args } = parsed
  const commands = context.options?.commands ?? []
  const command = findCommand(commandName, commands)
  const availabilityAnswer = (line: string): ProcessUserInputBaseResult => ({
    messages: [caveat, ...attachmentMessages, createUserMessage({ content: line })],
    shouldStartTurn: false,
    resultText: line,
    commandRefused: true,
  })

  if (command === undefined) {
    const builtin = findCommand(commandName, [...builtinCommands()])
    if (builtin !== undefined) {
      if (builtin.type === 'local' && builtin.userPrivate === true && isCommandEnabled(builtin)) {
        if (builtin.seat === 'screen' && getIsNonInteractiveSession()) {
          return {
            messages: [],
            shouldStartTurn: false,
            resultText: unavailableCommandLine(builtin),
            commandRefused: true,
          }
        }
        try {
          const module = await builtin.load()
          featureReached('command', builtin.name)
          const result = await module.call(args, context)
          const text = result.type === 'text' ? result.value : ''
          return {
            messages: [],
            shouldStartTurn: false,
            ...(text !== '' ? { resultText: text } : {}),
          }
        } catch (error) {
          logError(error)
          return {
            messages: [],
            shouldStartTurn: false,
            resultText: `/${commandName} failed — ${String(error)}`,
          }
        }
      }
      return availabilityAnswer(unavailableCommandLine(builtin))
    }
    if (!looksLikeCommand(commandName) || isExistingPath(`/${commandName}`)) {
      return rawInputAnswer()
    }
    const line = unknownCommandLine(commandName, commands)
    const notice = createSystemMessage(line, 'warning')
    return {
      messages: [uuid ? { ...notice, uuid } : notice],
      shouldStartTurn: false,
      resultText: line,
      commandRefused: true,
    }
  }

  if (!isCommandEnabled(command)) {
    return availabilityAnswer(unavailableCommandLine(command, args))
  }

  if (command.userInvocable === false) {
    return {
      messages: [
        createUserMessage({
          content: formatCommandInputTags(getCommandName(command), args),
          ...(uuid ? { uuid } : {}),
        }),
        createUserMessage({
          content: `The ${command.name} skill can only be invoked by the assistant. Ask for it by name instead.`,
        }),
      ],
      shouldStartTurn: false,
    }
  }

  try {
    let result: ProcessUserInputBaseResult
    if (command.type === 'local-jsx') {
      if (runsPromptWithArgs(command, args)) {
        const promptSkill = findBundledPromptSkill(command.name)
        if (promptSkill === undefined) {
          return availabilityAnswer(`The /${getCommandName(command)} command exists but is not enabled in this session.`)
        }
        result = await executePromptCommand(
          promptSkill,
          commandName,
          args,
          context,
          imageContentBlocks,
          attachmentMessages,
          uuid,
          setToolJSX,
          canUseTool,
        )
      } else if (command.promptWithArgs === true && getIsNonInteractiveSession()) {
        return availabilityAnswer(unavailableCommandLine(command, args))
      } else {
        result = await runLocalJsxCommand(
          command,
          commandName,
          args,
          context,
          setToolJSX,
          uuid,
        )
      }
    } else if (command.type === 'local') {
      result = await runLocalCommand(command, args, context, uuid)
    } else if (requiresArgument(command) && args.trim() === '') {
      result = answerBareUsage(command, args, uuid)
    } else {
      result = await executePromptCommand(
        command,
        commandName,
        args,
        context,
        imageContentBlocks,
        attachmentMessages,
        uuid,
        setToolJSX,
        canUseTool,
      )
    }
    return finalizeCommandResult(result, caveat)
  } catch (error) {
    if (error instanceof Error && isRecord(error) && error.isMalformedCommand === true) {
      return {
        messages: [
          createUserMessage({
            content: error.message,
            ...(uuid ? { uuid } : {}),
          }),
        ],
        shouldStartTurn: false,
        commandError: error.message,
      }
    }
    throw error
  }
}


async function runLocalJsxCommand(
  command: Command & { type: 'local-jsx' },
  commandName: string,
  args: string,
  context: ProcessUserInputContext,
  setToolJSX: SetToolJSXFn,
  uuid?: UUID,
): Promise<ProcessUserInputBaseResult> {
  const echoed = createUserMessage({
    content: formatCommandInputTags(getCommandName(command), args),
    ...(uuid ? { uuid } : {}),
  })
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
      const forwarded: Pick<ProcessUserInputBaseResult, 'shouldStartTurn' | 'nextInput' | 'submitNextInput'> = {
        shouldStartTurn: options?.shouldStartTurn ?? false,
        ...(options?.nextInput !== undefined ? { nextInput: options.nextInput } : {}),
        ...(options?.submitNextInput !== undefined
          ? { submitNextInput: options.submitNextInput }
          : {}),
      }
      if (display === 'skip') {
        finish({ messages: [], ...forwarded })
        return
      }
      if (display === 'system') {
        const isDismissal =
          typeof resultText === 'string' && /closed|dismissed|cancelled/i.test(resultText)
        if (isFullscreenEnvEnabled() && isDismissal) {
          finish({ messages: [...metaMessages], ...forwarded })
          return
        }
        finish({
          messages: [
            { ...createCommandInputMessage(echoed.message.content as string), uuid: echoed.uuid, timestamp: echoed.timestamp },
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
          echoed,
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
        featureReached('command', command.name)
        const element = await module.call(done, context, args, commandName)
        if ((context as { options?: { isNonInteractiveSession?: boolean } }).options
          ?.isNonInteractiveSession === true && element) {
          finish({ messages: [], shouldStartTurn: false })
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
          shouldHideComposer: true,
          showSpinner: false,
          isLocalJSXCommand: true,
          isImmediate: command.immediate === true,
        })
      } catch (error) {
        logError(error)
        setToolJSX({
          jsx: null,
          shouldHideComposer: false,
          isLocalJSXCommand: false,
          clearLocalJSX: true,
        })
        finish({
          messages: [echoed, createCommandInputMessage(stderrWrapped(String(error)))],
          shouldStartTurn: false,
          commandError: String(error),
        })
      }
    })()
  })
}

function answerBareUsage(
  command: Command & { type: 'prompt' },
  args: string,
  uuid?: UUID,
): ProcessUserInputBaseResult {
  const echoed = createUserMessage({
    content: formatCommandInputTags(getCommandName(command), args),
    ...(uuid ? { uuid } : {}),
  })
  const text = bareUsageLine(command)
  return {
    messages: [echoed, createCommandInputMessage(stdoutWrapped(text))],
    shouldStartTurn: false,
    resultText: text,
  }
}

async function runLocalCommand(
  command: Command & { type: 'local' },
  args: string,
  context: ProcessUserInputContext,
  uuid?: UUID,
): Promise<ProcessUserInputBaseResult> {
  const sensitive = command.isSensitive === true
  const echoedArgs = sensitive && args.trim() !== '' ? '[REDACTED]' : args
  const echoed = createUserMessage({
    content: formatCommandInputTags(getCommandName(command), echoedArgs),
    ...(uuid ? { uuid } : {}),
  })
  try {
    const module = await command.load()
    featureReached('command', command.name)
    const result = await module.call(args, context)
    if (command.userPrivate === true) {
      const text = result.type === 'text' ? result.value : ''
      return { messages: [], shouldStartTurn: false, ...(text !== '' ? { resultText: text } : {}) }
    }
    if (result.type === 'skip') {
      return { messages: [], shouldStartTurn: false }
    }
    if (result.type === 'compact') {
      const compaction = result.foldHandoff
      const display = result.displayText
      const displayMessage = display
        ? {
            ...createCommandInputMessage(stdoutWrapped(display)),
            timestamp: new Date(Date.now() + 2).toISOString(),
          }
        : undefined
      return {
        messages: [
          compaction.boundaryMarker,
          ...(compaction.operatorMessages !== undefined ? [compaction.operatorMessages] : []),
          ...compaction.summaryMessages,
          ...(compaction.messagesToKeep ?? []),
          createSyntheticUserCaveatMessage(),
          echoed,
          ...(displayMessage ? [displayMessage] : []),
          ...compaction.attachments,
          ...compaction.hookResults,
        ],
        shouldStartTurn: false,
        ...(display ? { resultText: display } : {}),
      }
    }
    const text = result.value
    return {
      messages: [echoed, createCommandInputMessage(stdoutWrapped(text))],
      shouldStartTurn: false,
      resultText: text,
    }
  } catch (error) {
    if (error instanceof Error && isNothingToFoldMessage(error.message)) {
      return {
        messages: [echoed, createCommandInputMessage(stderrWrapped(error.message))],
        shouldStartTurn: false,
        commandError: error.message,
      }
    }
    logError(error)
    return {
      messages: [echoed, createCommandInputMessage(stderrWrapped(String(error)))],
      shouldStartTurn: false,
      commandError: String(error),
    }
  }
}
