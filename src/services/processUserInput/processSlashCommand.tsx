import { featureReached } from '../../substrate/featureReached.js'

import * as React from 'react'
import { randomUUID, type UUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { Box, Text } from '../../ink.js'
import type { CanUseToolFn, SetToolJSXFn, ToolUseContext } from '../../Tool.js'
import type { Command } from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { builtinCommands, commandOffInPlainWorld, commandSeat, getCommandName, isCommandEnabled, meetsAvailabilityRequirement } from '../../commands.js'
import samples, { SAMPLES_OFF_SENTENCE } from '../../commands/samples/index.js'
import { bareUsageLine, requiresArgument } from '../../skills/argumentHint.js'
import { generateCommandSuggestions } from '../../utils/suggestions/commandSuggestions.js'
import { concourseOffSentence } from '../../context/surfaceRoute.js'
import { markTransitionStart } from '../../utils/observability/frictionStopwatch.js'
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
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import {
  createCommandInputMessage,
  createSyntheticUserCaveatMessage,
  createSystemMessage,
  createUserMessage,
  INTERRUPT_MESSAGE,
  isCompactBoundaryMessage,
} from '../messages.js'
import { parseSlashCommand } from '../../utils/slashCommandParsing.js'
import { logError } from '../../utils/log.js'
import { isNothingToCompactMessage } from '../compact/compact/limits.js'
import { resetMicrocompactState } from '../compact/microCompact.js'
import { recordSkillUsage } from '../../utils/suggestions/skillUsageTracking.js'
import { getAgentContext } from '../../utils/agentContext.js'
import { addInvokedSkill, getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { registerSkillHooks } from '../../utils/hooks/registerFrontmatterHooks.js'

import { getSessionId } from '../../bootstrap/state.js'
import { isRestrictedToExtensionsOnly } from '../../utils/settings/extensionOnlyPolicy.js'
import { parseSlashCommandToolsFromFrontmatter } from '../../utils/markdownConfigLoader.js'
import type {
  ProcessUserInputBaseResult,
  ProcessUserInputContext,
} from './processUserInput.js'
import { passedOver } from '../../utils/passedOver.js'
import { notBuilt } from '../../pi/holes.js'

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
  const registered = findCommand([...builtinCommands()], name)
  if (registered !== undefined) return unavailableCommandLine(registered)
  let near: string | undefined
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
  return `Unknown command: /${name}${near !== undefined && near !== name ? ` — closest: /${near}` : ''} · /help lists commands`
}


function looksLikeCommand(commandName: string): boolean {
  return notBuilt('src/services/processUserInput/processSlashCommand.tsx:92')
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
  progressMessage?: string,
): string {
  return notBuilt('src/services/processUserInput/processSlashCommand.tsx:107')
}

export function formatCommandLoadingMetadata(fullName: string, args: string): string {
  return notBuilt('src/services/processUserInput/processSlashCommand.tsx:115')
}

export function unavailableCommandLine(real: Command, args?: string): string {
  return notBuilt('src/services/processUserInput/processSlashCommand.tsx:120')
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


export async function processPromptSlashCommand(
  commandName: string,
  args: string,
  commands: Command[],
  context: ToolUseContext,
  imageContentBlocks?: ContentBlockParam[],
): Promise<ProcessUserInputBaseResult & { command: Command }> {
  return notBuilt('src/services/processUserInput/processSlashCommand.tsx:173')
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
  return notBuilt('src/services/processUserInput/processSlashCommand.tsx:415')
}


function answerBareUsage(
  command: Command & { type: 'prompt' },
  args: string,
  uuid?: UUID,
): ProcessUserInputBaseResult {
  const echoed = createUserMessage({
    content: formatCommandLoadingMetadata(getCommandName(command), args),
    ...(uuid ? { uuid } : {}),
  })
  const text = bareUsageLine(command)
  return {
    messages: [echoed, createCommandInputMessage(stdoutWrapped(text))],
    shouldQuery: false,
    resultText: text,
  }
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
    featureReached('command', command.name)
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
    if (error instanceof Error && isNothingToCompactMessage(error.message)) {
      return {
        messages: [echoed, createCommandInputMessage(stderrWrapped(error.message))],
        shouldQuery: false,
        commandError: error.message,
      }
    }
    logError(error)
    return {
      messages: [echoed, createCommandInputMessage(stderrWrapped(String(error)))],
      shouldQuery: false,
      commandError: String(error),
    }
  }
}
