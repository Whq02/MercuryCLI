import { pinnedCommandAnalysis } from '../../utils/permissions/decision/commandAnalysis.js'
import { posixExitSignalsCount } from '../../utils/platform/processes.js'
import { notBuilt } from '../../pi/holes.js'

type CommandSemantic = (exitCode: number) => { isError: boolean; message?: string }

function baseCommandFor(command: string): string {
  const subcommands = pinnedCommandAnalysis.splitCommand(command)
  const last = subcommands[subcommands.length - 1] ?? command
  return commandWord(last)
}

const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/

function commandWord(stage: string): string {
  const words = stage.trim().split(/\s+/)
  let i = 0
  while (i < words.length && ASSIGNMENT_WORD.test(words[i] ?? '')) i++
  if (words[i] === 'env') {
    i++
    while (i < words.length && (ASSIGNMENT_WORD.test(words[i] ?? '') || (words[i] ?? '').startsWith('-'))) i++
  }
  if (words[i] === 'command' && (words[i + 1] === '-v' || words[i + 1] === '-V')) return 'command -v'
  return words[i] ?? ''
}

function whichOperandCount(command: string): number {
  const stages = pinnedCommandAnalysis.splitCommand(command)
  const parsed = pinnedCommandAnalysis.tryParseShellCommand(stages[stages.length - 1] ?? command)
  if (!parsed.success || parsed.tokens.some(token => typeof token !== 'string')) return 0
  const words = parsed.tokens as string[]
  const which = words.indexOf('which')
  if (which < 0) return 0
  let operands = 0
  let options = true
  for (const word of words.slice(which + 1)) {
    if (options && word === '--') { options = false; continue }
    if (options && word.startsWith('-')) {
      if (!/^(?:-a|--all|--(?:skip|show)-(?:dot|tilde)|--tty-only|--(?:read|skip)-(?:alias|functions))$/.test(word)) return 0
      continue
    }
    operands++
  }
  return operands
}

export function interpretCommandResult(
  command: string,
  exitCode: number,
  _stdout: string,
  _stderr: string,
): { isError: boolean; message?: string } {
  return notBuilt('src/tools/BashTool/commandSemantics.ts:89')
}

const SIGNAL_EXIT_WORDS: Readonly<Record<number, string>> = {
  134: 'aborted (SIGABRT)',
  137: 'killed (out of memory or a kill signal)',
  139: 'crashed (segmentation fault)',
  143: 'terminated (SIGTERM)',
}

export function exitLine(exitCode: number, diedOnItsOwn: boolean = true, signalsCount: boolean = posixExitSignalsCount()): string {
  const words = diedOnItsOwn && signalsCount ? SIGNAL_EXIT_WORDS[exitCode] : undefined
  return words === undefined ? `Exited with code ${exitCode}` : `exit ${exitCode} · ${words}`
}
