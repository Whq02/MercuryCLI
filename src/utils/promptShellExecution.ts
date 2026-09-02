import { randomUUID } from 'node:crypto'

import type { ToolUseContext } from '../Tool.js'
import { BashTool } from '../tools/BashTool/BashTool.js'
import { logForDebugging } from './debug.js'
import { MalformedCommandError, ShellError } from './errors.js'
import { errorMessage } from './errors.js'
import type { FrontmatterShell } from './frontmatterParser.js'
import { createAssistantMessage } from './messages.js'
import { hasPermissionsToUseTool } from './permissions/permissions.js'
import { isPowerShellToolEnabled } from './shell/shellToolUtils.js'
import { processToolResultBlock } from './toolResultStorage.js'

/**
 * Executes shell commands embedded in slash-command / skill prompt bodies
 * and substitutes their output in place.
 */

// A fenced block opened by three backticks immediately followed by `!`; the
// captured command is the shortest text reaching a closing fence.
const BLOCK_PATTERN = /```!\s*\n?([\s\S]*?)\n?```/g
// The inline form requires whitespace or start-of-line before the mark:
// the bare shape also occurs inside code spans and shell parameter
// references, none of which has whitespace before the mark.
const INLINE_PATTERN = /(?<=\s|^)!`([^`]+)`/g
const INLINE_OPENER = '!`'

type ShellToolLike = {
  name: string
  maxResultSizeChars: number
  call: (input: never, context: ToolUseContext) => AsyncGenerator<unknown>
  mapToolResultToToolResultBlockParam: (result: never, toolUseID: string) => never
}

/**
 * The shell is the AUTHOR's frontmatter choice (never the default-shell
 * setting); PowerShell routes only when the user's runtime gate allows it —
 * a skill's frontmatter cannot outrank the user's setting. The PowerShell
 * tool is required lazily: this module loads during startup through the
 * command registry, and a static import would drag the tool and its parsers
 * into every launch on every platform.
 */
function resolveShellTool(shell: FrontmatterShell | undefined): ShellToolLike {
  if (shell === 'powershell' && isPowerShellToolEnabled()) {
    const { PowerShellTool } = require('../tools/PowerShellTool/PowerShellTool.js') as {
      PowerShellTool: ShellToolLike
    }
    return PowerShellTool
  }
  return BashTool as unknown as ShellToolLike
}

/** Non-empty trimmed stdout, then labelled stderr. The inline variant exists but is never selected on any current call path — reproduce the default. */
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
  const syntheticAssistant = createAssistantMessage({ content: [] })
  const permission = await hasPermissionsToUseTool(
    tool as never,
    { command } as never,
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
  // Invoked directly — this BYPASSES input validation, so any load-bearing
  // check must live in the call itself.
  let lastResult: unknown
  for await (const update of tool.call({ command } as never, context)) {
    lastResult = update
  }
  const result = (lastResult as { data?: unknown })?.data ?? lastResult
  const block = await processToolResultBlock(tool as never, result as never, randomUUID())
  const content = (block as { content?: unknown }).content
  if (typeof content === 'string') return content
  const shellResult = result as { stdout?: string; stderr?: string }
  return formatShellOutput(shellResult?.stdout ?? '', shellResult?.stderr ?? '')
}

/**
 * Both scans run first and their matches concatenate (block before inline)
 * before any work starts; matches process concurrently. The inline scan is
 * gated on a cheap substring test — the look-behind pattern is two orders
 * of magnitude slower on a large body, and most skills carry no inline
 * command.
 */
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

  const outputs = await Promise.all(
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

  let result = text
  matches.forEach(({ full, command }, index) => {
    const output = outputs[index]
    if (output === null || output === undefined) return
    void command
    // A FUNCTION replacer, never a replacement string: the standard replace
    // expands dollar-sign patterns inside a string argument, and command
    // output (PowerShell above all) is full of exactly those sequences.
    result = result.replace(full, () => output)
  })
  return result
}
