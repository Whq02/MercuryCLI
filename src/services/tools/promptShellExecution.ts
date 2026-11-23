import { randomUUID } from 'node:crypto'

import { canAnswerAsks, getSessionId } from '../../bootstrap/state.js'
import { guardKeysOf, judgeToolCall } from '../../guards/guards.js'
import type { Tool, ToolUseContext } from '../../Tool.js'
import { BashTool } from '../../tools/BashTool/BashTool.js'
import { logForDebugging } from '../../utils/debug.js'
import { MalformedCommandError, ShellError } from '../../utils/errors.js'
import { errorMessage } from '../../utils/errors.js'
import type { FrontmatterShell } from '../../utils/frontmatterParser.js'
import { createAssistantMessage } from '../messages.js'
import { hasPermissionsToUseTool } from '../../utils/permissions/permissions.js'
import { isPowerShellToolEnabled } from '../../utils/shell/shellToolUtils.js'
import { processToolResultBlock } from '../../utils/toolResultStorage.js'

type ShellMatch = {
  fullMatch: string
  command: string
  start: number
  end: number
}

function findShellMatches(text: string): ShellMatch[] {
  const matches: ShellMatch[] = []
  const fencedRanges: Array<{ start: number; end: number }> = []
  const fencedRegex = /```![^\S\r\n]*\r?\n?([\s\S]*?)\r?\n?```/g
  for (const match of text.matchAll(fencedRegex)) {
    const start = match.index
    const fullMatch = match[0]
    const end = start + fullMatch.length
    fencedRanges.push({ start, end })
    matches.push({ fullMatch, command: match[1] ?? '', start, end })
  }
  if (text.includes('!`')) {
    const inlineRegex = /(?:^|(?<=\s))!`([^`]+)`/g
    for (const match of text.matchAll(inlineRegex)) {
      const start = match.index
      const fullMatch = match[0]
      const end = start + fullMatch.length
      if (fencedRanges.some(range => start >= range.start && start < range.end)) continue
      matches.push({ fullMatch, command: match[1] ?? '', start, end })
    }
  }
  return matches
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  )
}

function formatShellOutput(stdout: string, stderr: string): string {
  const parts: string[] = []
  const trimmedOut = stdout.trim()
  if (trimmedOut) parts.push(trimmedOut)
  const trimmedErr = stderr.trim()
  if (trimmedErr) parts.push(`stderr:\n${trimmedErr}`)
  return parts.join('\n')
}

async function runPromptShellCommand(
  command: string,
  tool: Tool,
  context: ToolUseContext,
  slashCommandName: string,
): Promise<string | null> {
  const trimmed = command.trim()
  if (!trimmed) return null
  const input = { command: trimmed }
  try {
    const callId = randomUUID()
    const judgement = await judgeToolCall(
      guardKeysOf(getSessionId(), context.agentId),
      {
        tool: tool.name,
        input,
        callId,
        messages: context.messages,
        toolRef: tool,
        asksAnswerable:
          canAnswerAsks() &&
          context.getAppState().toolPermissionContext.shouldAvoidPermissionPrompts !== true,
      },
      context.abortController.signal,
    )
    if (judgement.refused) {
      logForDebugging(
        `Guard refused shell command "${trimmed}" in ${slashCommandName}: ${judgement.reason}`,
      )
      throw new MalformedCommandError(
        `Permission check failed for the matched pattern "${trimmed}": ${judgement.reason}`,
      )
    }
    if (context.appendSystemMessage) {
      for (const note of judgement.notes) {
        context.appendSystemMessage(note)
      }
    }

    const emptyAssistant = createAssistantMessage({ content: '' })
    const permission = await hasPermissionsToUseTool(
      tool,
      input,
      context,
      emptyAssistant,
      '',
    )
    if (permission.behavior !== 'allow') {
      const reason = permission.message || 'permission denied'
      logForDebugging(
        `Permission check failed for shell command "${trimmed}" in ${slashCommandName}: ${reason}`,
      )
      throw new MalformedCommandError(
        `Permission check failed for the matched pattern "${trimmed}": ${reason}`,
      )
    }

    let rawResult: unknown = await tool.call(
      input,
      context,
      hasPermissionsToUseTool,
      emptyAssistant,
    )
    if (isAsyncIterable(rawResult)) {
      let last: unknown
      for await (const item of rawResult) {
        last = item
      }
      rawResult = last
    }
    const resultData =
      typeof rawResult === 'object' && rawResult !== null && Object.hasOwn(rawResult, 'data')
        ? (rawResult as { data: unknown }).data
        : rawResult

    const block = await processToolResultBlock(
      tool,
      resultData,
      randomUUID(),
      context.options.engineModel,
    )
    if (typeof block.content === 'string') return block.content
    const shellResult =
      typeof resultData === 'object' && resultData !== null
        ? (resultData as { stdout?: unknown; stderr?: unknown })
        : {}
    const stdout = typeof shellResult.stdout === 'string' ? shellResult.stdout : ''
    const stderr = typeof shellResult.stderr === 'string' ? shellResult.stderr : ''
    return formatShellOutput(stdout, stderr)
  } catch (err) {
    if (err instanceof MalformedCommandError) throw err
    if (err instanceof ShellError) {
      if (err.interrupted) {
        throw new MalformedCommandError(
          `The command was interrupted for the matched pattern "${trimmed}"`,
        )
      }
      throw new MalformedCommandError(
        `The command failed for the matched pattern "${trimmed}":\n${formatShellOutput(err.stdout, err.stderr)}`,
      )
    }
    throw new MalformedCommandError(errorMessage(err))
  }
}

export async function executeShellCommandsInPrompt(
  text: string,
  context: ToolUseContext,
  slashCommandName: string,
  shell?: FrontmatterShell,
): Promise<string> {
  const matches = findShellMatches(text)
  if (matches.length === 0) return text

  const usePowerShell = shell === 'powershell' && isPowerShellToolEnabled()
  const tool: Tool = usePowerShell
    ? (await import('../../tools/PowerShellTool/PowerShellTool.js')).PowerShellTool
    : BashTool

  const settled = await Promise.allSettled(
    matches.map(match => runPromptShellCommand(match.command, tool, context, slashCommandName)),
  )

  for (const outcome of settled) {
    if (outcome.status === 'rejected') {
      throw outcome.reason
    }
  }

  let result = text
  for (let i = 0; i < matches.length; i++) {
    const outcome = settled[i]!
    if (outcome.status === 'fulfilled' && outcome.value !== null) {
      const replacement = outcome.value
      result = result.replace(matches[i]!.fullMatch, () => replacement)
    }
  }
  return result
}
