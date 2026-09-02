// ============================================================================
//  The `/`-command path: resolution, unknown-command handling, the three
//  command kinds (local-jsx / local / prompt), forked-subagent commands,
//  and the prompt-expansion hooks.
//
//  Error handling has two layers: inside the PROMPT kind every throw is
//  caught (abort → interruption message, else stderr-wrapped); around all
//  three kinds a malformed-command error becomes a plain user message; only
//  errors escaping both layers propagate.
// ============================================================================

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

/** THE UNKNOWN-NAME HONESTY (the gated-command
 *  fix's sibling): on a daemon-hosted seat an unregistered /name fell
 *  through the one dispatch rule as session WORDS, and the runner's refusal
 *  came back as a persisted user row spelled "Unknown skill: theme" — the
 *  transcript claimed the operator typed the refusal. The SCREEN resolves
 *  the unknown name at the dispatch seam and answers display-only. Names
 *  that are really paths, the // escape and non-name shapes pass through
 *  untouched (they are prompts). */
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

/** The screen's own sentence for it — "Unknown command", never the runner's
 *  skill spelling; the nearest registered name rides as a pointer when the
 *  suggestion index has one. */
export function unknownCommandLine(name: string, commands: Command[]): string {
  let near: string | undefined
  try {
    const top = generateCommandSuggestions(`/${name}`, commands)[0]
    const meta = top?.metadata as Command | undefined
    if (meta !== undefined && typeof meta === 'object' && typeof meta.type === 'string') near = getCommandName(meta)
  } catch {
    /* the pointer is a courtesy — the sentence stands without it */
  }
  return `Unknown command: /${name}${near !== undefined && near !== name ? ` — closest: /${near}` : ''} · /help lists commands`
}

// ── name shape ──────────────────────────────────────────────────────────────

/** Only letters, digits, colons, hyphens and underscores look like a
 *  command name. */
export function looksLikeCommand(commandName: string): boolean {
  return /^[a-zA-Z0-9:_-]+$/.test(commandName)
}

/** The slash-prefixed name is probed as a filesystem path: an existing path
 *  is treated as an ordinary prompt, never an unknown skill. */
function isExistingPath(slashPrefixed: string): boolean {
  try {
    statSync(slashPrefixed)
    return true
  } catch {
    return false
  }
}

// ── loading metadata (contract data — tag names) ────────────────────────────

/** Model-only skill loading metadata: the command-message and command-name
 *  tags with the BARE skill name plus the skill-format marker. The
 *  progress-message parameter is part of the exported signature and
 *  deliberately unused. */
export function formatSkillLoadingMetadata(
  skillName: string,
  progressMessage?: string,
): string {
  void progressMessage
  return `<${COMMAND_MESSAGE_TAG}>${skillName}</${COMMAND_MESSAGE_TAG}><${COMMAND_NAME_TAG}>${skillName}</${COMMAND_NAME_TAG}><skill-format>skill</skill-format>`
}

/** User-invocable command loading metadata: slash-prefixed name plus an
 *  optional args tag. The FULLY QUALIFIED name (extension prefix included) is
 *  used, never a display name. */
export function formatCommandLoadingMetadata(fullName: string, args: string): string {
  const argsTag = args ? `<${COMMAND_ARGS_TAG}>${args}</${COMMAND_ARGS_TAG}>` : ''
  return `<${COMMAND_MESSAGE_TAG}>${fullName}</${COMMAND_MESSAGE_TAG}><${COMMAND_NAME_TAG}>/${fullName}</${COMMAND_NAME_TAG}>${argsTag}`
}

/** The honest answer for a REAL built-in command the current seat cannot
 *  serve: a typed reason (the world, mode, sign-in, or enablement) — the
 *  unknown-skill line is reserved for names the product has never
 *  registered anywhere. Exported for the command-table prover. */
export function unavailableCommandLine(real: Command): string {
  const name = getCommandName(real)
  // A retired door first: its own reason, in every world and every seat.
  const retired = commandRetired(real)
  if (retired !== undefined) {
    return `The /${name} command is retired — ${retired}.`
  }
  // The plain world next: a concourse-only command has one honest answer
  // here — the router's own sentence (why the concourse is off in this boot
  // and the way back), never the generic enablement line.
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

// ── command resolution (name, alias, or canonical name) ─────────────────────

function findCommand(commands: Command[], name: string): Command | undefined {
  return commands.find(
    command =>
      command.name === name ||
      command.aliases?.includes(name) === true ||
      getCommandName(command) === name,
  )
}

// ── the expansion-hook loop (shared by prompt commands) ─────────────────────

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

// ── the prompt-command executor (exported for tool-facing callers) ──────────

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

    // Forked commands run in a subagent; inline commands expand here.
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

    // Skill-declared hooks register only when hook registration is not
    // restricted to trusted extension sources (user skills still load under a
    // hooks-only restriction, so the block happens HERE, where the source
    // is known).
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

    // Recorded for compaction restoration, tagged by the CURRENT agent so
    // one agent's skills are never restored into another.
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

    // Main content: pasted images, then preceding blocks, then the
    // expansion; attachments are extracted from the expansion's text with
    // SKILL DISCOVERY SUPPRESSED (a skill body is meta-content, not
    // operator intent).
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
    // The inner layer: every throw inside the prompt kind is caught.
    // The echoed row is the send's LANDING: it carries the frame uuid (the
    // delivery law's one identity — the cockpit retires its echo on it).
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

// ── forked prompt commands ──────────────────────────────────────────────────

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
    // The command's effort, when set, merges into the agent definition; the
    // hook messages ran around the EXPANSION, so their context reaches the
    // agent performing it, not the parent.
    const baseAgent = command.effort !== undefined
      ? { ...prepared.baseAgent, effort: command.effort }
      : prepared.baseAgent
    const promptMessages = [...prepared.promptMessages, ...hookMessages]

    // Agent-progress UI renders from the FIRST moment, before any output;
    // it updates for each assistant and normalised user message, and
    // assistant messages advance the response-length counter behind the
    // spinner.
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
      // The progress display clears in a finally block.
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

// ── the entry point ─────────────────────────────────────────────────────────

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
    // Unparseable: explain the required form; headless callers see the
    // explanation as the result text.
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

  // Enablement is read AGAIN at dispatch: the roster is memoized at load,
  // so a predicate that flipped since (the concourse switch through /config
  // — the plain world mid-session — or scribe mode) answers its typed line
  // here instead of running from the stale table.
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
    // A REAL built-in absent from this seat's roster answers with its typed
    // reason (mode, sign-in, or enablement) — a registered command is never
    // an unknown skill anywhere.
    const registered = findCommand([...builtinCommands()], commandName)
    if (registered) {
      // The never-reaches defense (command-privacy law): a USER-PRIVATE line
      // arriving at a session runner as words — the screen normally consumes
      // it, but a bridge or an older client can still send it — EXECUTES and
      // leaves the conversation untouched: zero persisted rows, zero wire,
      // zero turn. The receipt rides resultText alone.
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
        // The warning names BOTH the skill and the arguments in distinct,
        // labelled slots (an argument once read as a second unknown skill).
        messages.push(
          createSystemMessage(
            `The skill "${commandName}" was not found; its arguments were: ${args}`,
            'warning',
          ),
        )
      }
      return { messages, shouldQuery: false, resultText: unknownLine }
    }
    // Not command-shaped (or a real path): an ordinary prompt.
    const promptMessage = createUserMessage({
      content: inputString,
      uuid: (uuid ?? randomUUID()) as UUID,
    })
    return {
      messages: [promptMessage, ...attachmentMessages],
      shouldQuery: true,
    }
  }

  // The companion's opened-surface memory: a surface the operator has never
  // opened ranks its tip first. Fail-soft — a read-only home never blocks a
  // command.
  try {
    noteCompanionSurfaceOpened(command.name)
  } catch {
    /* the memory is a convenience, never a gate */
  }

  // Non-user-invocable commands are the assistant's vocabulary only.
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

    // Post-processing around all three kinds.
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
    // The outer layer: a malformed-command error becomes a plain user
    // message; anything else propagates.
    if ((error as { isMalformedCommand?: boolean } | null)?.isMalformedCommand === true) {
      return {
        messages: [createUserMessage({ content: String((error as Error).message) })],
        shouldQuery: false,
      }
    }
    throw error
  }
}

// ── local-jsx commands ──────────────────────────────────────────────────────

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

    // The command's completion callback, typed to the declared contract
    // (L4): a 'skip' display is total, 'system' echoes as a system row,
    // 'user' (the default) echoes as user rows.
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
        // The skip is TOTAL: no messages, no meta messages — only the
        // next-input fields forward.
        finish({ messages: [], ...forwarded })
        return
      }
      const echoed = createCommandInputMessage(
        formatCommandLoadingMetadata(getCommandName(command), args),
      )
      if (display === 'system') {
        // In fullscreen a modal-dismissal notice is suppressed — the modal
        // itself was the feedback, and these rows never reach the model.
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
        // Friction stopwatch: the operator's ↵ is the transition's start —
        // the mounted surface's own effect marks the end (CommandCenter /
        // the model picker); a command that mounts neither records nothing.
        markTransitionStart(getCommandName(command) === 'model' ? 'picker-open' : 'screen-switch')
        // The command MODULE is loaded once and its call entry invoked
        // EXACTLY ONCE — the run-once guarantee the command modules build
        // their result-channel semantics on.
        const module = await command.load()
        const element = await module.call(done, context, args)
        if ((context as { options?: { isNonInteractiveSession?: boolean } }).options
          ?.isNonInteractiveSession === true && element) {
          finish({ messages: [], shouldQuery: false })
          return
        }
        if (element === null || element === undefined) {
          // A command that renders nothing installs nothing: the promise
          // waits for the done callback alone.
          return
        }
        if (settled) {
          // The done callback already fired: installing the element now
          // would leave the local-JSX flag stuck true and deadlock the
          // queue processor.
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

// ── local commands ──────────────────────────────────────────────────────────

async function runLocalCommand(
  command: Command & { type: 'local' },
  commandName: string,
  args: string,
  context: ProcessUserInputContext,
  uuid?: UUID,
): Promise<ProcessUserInputBaseResult> {
  // A sensitive command with a NON-BLANK argument string masks the echoed
  // arguments; invoked bare it echoes empty arguments, not a mask.
  const sensitive = command.isSensitive === true
  const echoedArgs = sensitive && args.trim() !== '' ? '[REDACTED]' : args
  // The echoed row is the send's LANDING: it carries the frame uuid (the
  // delivery law's one identity). Without it a delivered slash command's
  // cockpit echo never retired — the send held the live view in-flight and
  // /clear refused a session that was idle (the u4 stuck class).
  const echoed = createUserMessage({
    content: formatCommandLoadingMetadata(getCommandName(command), echoedArgs),
    ...(uuid ? { uuid } : {}),
  })
  try {
    const module = await command.load()
    const result = await module.call(args, context)
    // USER-PRIVATE (command-privacy law): the body ran; NOTHING enters the
    // conversation — no echoed line, no stdout row, nothing for the wire.
    // The receipt rides resultText alone (the screen paints its own).
    if (command.userPrivate === true) {
      const text = result.type === 'text' ? result.value : ''
      return { messages: [], shouldQuery: false, ...(text !== '' ? { resultText: text } : {}) }
    }
    if (result.type === 'skip') {
      return { messages: [], shouldQuery: false }
    }
    if (result.type === 'compact') {
      // A full compact replaces every message: the caveat, the echoed
      // message and an optional stdout display line append AFTER the
      // compaction's kept messages (so attachments and hook results sort
      // after the user messages); the display line's timestamp is pushed
      // slightly into the future so resume, which picks the
      // latest-timestamped message as the leaf, lands on it; microcompact
      // state resets because a full compact replaces every message and the
      // old tool ids are meaningless.
      // The compact command runs on the main conversation lane; the reset
      // defaults to the main owner.
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
