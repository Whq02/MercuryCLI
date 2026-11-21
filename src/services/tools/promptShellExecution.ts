import { randomUUID } from 'node:crypto'

import { canAnswerAsks, getSessionId } from '../../bootstrap/state.js'
import { guardKeysOf, judgeToolCall } from '../../guards/guards.js'
import type { ToolUseContext } from '../../Tool.js'
import { BashTool } from '../../tools/BashTool/BashTool.js'
import { logForDebugging } from '../../utils/debug.js'
import { MalformedCommandError, ShellError } from '../../utils/errors.js'
import { errorMessage } from '../../utils/errors.js'
import type { FrontmatterShell } from '../../utils/frontmatterParser.js'
import { createAssistantMessage } from '../messages.js'
import { hasPermissionsToUseTool } from '../../utils/permissions/permissions.js'
import { isPowerShellToolEnabled } from '../../utils/shell/shellToolUtils.js'
import { processToolResultBlock } from '../../utils/toolResultStorage.js'


const BLOCK_PATTERN = /```!\s*\n?([\s\S]*?)\n?```/g
const INLINE_PATTERN = /(?<=\s|^)!`([^`]+)`/g
const INLINE_OPENER = '!`'

type ShellTool = typeof BashTool | typeof import('../../tools/PowerShellTool/PowerShellTool.js').PowerShellTool

function resolveShellTool(shell: FrontmatterShell | undefined): ShellTool {
  if (shell === 'powershell' && isPowerShellToolEnabled()) {
    const { PowerShellTool } = require('../../tools/PowerShellTool/PowerShellTool.js') as typeof import('../../tools/PowerShellTool/PowerShellTool.js')
    return PowerShellTool
  }
  return BashTool
}

function formatShellOutput(stdout: string, stderr: string, inline: boolean = false): string {
  const parts: string[] = []
  const trimmedOut = stdout.trim()
  const trimmedErr = stderr.trim()
  if (trimmedOut !== '') parts.push(trimmedOut)
  if (trimmedErr !== '') {
    if (inline) parts.push(`[stderr: ${trimmedErr}]`)
    else parts.push(`stderr:\n${trimmedErr}`)
  }
  return parts.join(inline ? ' ' : '\n')
}

async function runEmbeddedCommand(
  command: string,
  context: ToolUseContext,
  slashCommandName: string,
  shell: FrontmatterShell | undefined,
): Promise<string> {
  const tool = resolveShellTool(shell)
  const judgement = await judgeToolCall(
    guardKeysOf(getSessionId(), context.agentId),
    {
      tool: tool.name,
      input: { command },
      callId: randomUUID(),
      messages: context.messages,
      toolRef: tool,
      asksAnswerable: canAnswerAsks() && context.getAppState().toolPermissionContext.shouldAvoidPermissionPrompts !== true,
    },
    context.abortController.signal,
  )
  if (judgement.refused) {
    logForDebugging(`promptShellExecution: a guard refused ${slashCommandName}: ${command} (${judgement.guard})`)
    throw new MalformedCommandError(`Permission check failed for the matched pattern "${command}": ${judgement.reason}`)
  }
  for (const note of judgement.notes) context.appendSystemMessage?.(note)
  const syntheticAssistant = createAssistantMessage({ content: [] })
  const permission = await hasPermissionsToUseTool(
    tool,
    { command },
    context,
    syntheticAssistant,
    '',
  )
  if (permission.behavior !== 'allow') {
    const reason =
      (permission as { message?: string }).message && (permission as { message?: string }).message !== ''
        ? (permission as { message?: string }).message
        : 'permission denied'
    logForDebugging(`promptShellExecution: permission check failed for ${slashCommandName}: ${command} (${reason})`)
    throw new MalformedCommandError(`Permission check failed for the matched pattern "${command}": ${reason}`)
  }
  let lastResult: unknown = await tool.call({ command }, context)
  if (lastResult !== null && typeof lastResult === 'object' && Symbol.asyncIterator in lastResult) {
    for await (const update of lastResult as AsyncIterable<unknown>) lastResult = update
  }
  const result = (lastResult as { data?: unknown })?.data ?? lastResult
  const block = await processToolResultBlock(tool, result, randomUUID(), context.options.engineModel)
  const content = block.content
  if (typeof content === 'string') return content
  const shellResult = result as { stdout?: string; stderr?: string }
  return formatShellOutput(shellResult?.stdout ?? '', shellResult?.stderr ?? '')
}

export async function executeShellCommandsInPrompt(
  text: string,
  context: ToolUseContext,
  slashCommandName: string,
  shell?: FrontmatterShell,
): Promise<string> {
  type EmbeddedMatch = { full: string; command: string }
  const matches: EmbeddedMatch[] = []
  for (const match of text.matchAll(BLOCK_PATTERN)) {
    matches.push({ full: match[0], command: match[1] as string })
  }
  if (text.includes(INLINE_OPENER)) {
    for (const match of text.matchAll(INLINE_PATTERN)) {
      matches.push({ full: match[0], command: match[1] as string })
    }
  }
  if (matches.length === 0) return text

  const outcomes = await Promise.allSettled(
    matches.map(async ({ command }): Promise<string | null> => {
      const trimmed = command.trim()
      if (trimmed === '') return null
      try {
        return await runEmbeddedCommand(trimmed, context, slashCommandName, shell)
      } catch (err) {
        if (err instanceof MalformedCommandError) throw err
        if (err instanceof ShellError) {
          if (err.interrupted) {
            throw new MalformedCommandError(`The command was interrupted for the matched pattern "${trimmed}"`)
          }
          throw new MalformedCommandError(
            `The command failed for the matched pattern "${trimmed}":\n${formatShellOutput(err.stdout, err.stderr)}`,
          )
        }
        throw new MalformedCommandError(errorMessage(err))
      }
    }),
  )
  const failed = outcomes.find(outcome => outcome.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
  const outputs = outcomes.map(outcome => outcome.status === 'fulfilled' ? outcome.value : null)

  let result = text
  matches.forEach(({ full, command }, index) => {
    const output = outputs[index]
    if (output === null || output === undefined) return
    void command
    result = result.replace(full, () => output)
  })
  return result
}
