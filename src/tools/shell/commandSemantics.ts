import { closingStatement, pinnedCommandAnalysis, preparedSecurityParse, watchesItsShell, type ClosingStatement } from '../../permissions/rules/decision/commandAnalysis.js'
import { posixExitSignalsCount } from '../../platform/host-os/processes.js'

type CommandSemantic = (exitCode: number) => { isError: boolean; message?: string }

function exitOneMessage(message: string): CommandSemantic {
  return exitCode => {
    if (exitCode === 0) return { isError: false }
    if (exitCode === 1) return { isError: false, message }
    return { isError: true, message: `failed with exit code ${exitCode}` }
  }
}

const COMMAND_SEMANTICS: Readonly<Record<string, CommandSemantic>> = {
  grep: exitOneMessage('no matches found'),
  rg: exitOneMessage('no matches found'),
  find: exitOneMessage('some directories were inaccessible'),
  diff: exitOneMessage('files differ'),
  cmp: exitOneMessage('files differ'),
  pgrep: exitOneMessage('no process matched'),
  test: exitOneMessage('condition is false'),
  '[': exitOneMessage('condition is false'),
  which: exitOneMessage('a name was not found'),
  'command -v': exitOneMessage('a name was not found'),
}

const WHICH_LONG_FLAGS: ReadonlySet<string> = new Set([
  '--all',
  '--read-alias',
  '--skip-alias',
  '--read-functions',
  '--skip-functions',
  '--skip-dot',
  '--skip-tilde',
  '--show-dot',
  '--show-tilde',
  '--tty-only',
])

function whichOperandCount(command: string): number {
  const parsed = preparedSecurityParse(command)
  if (parsed.kind !== 'simple' || parsed.commands.length === 0) return 0
  const last = parsed.commands[parsed.commands.length - 1]
  if (last === undefined) return 0
  const argv = last.argv
  let i = 0
  while (i < argv.length && ASSIGNMENT_WORD.test(argv[i] ?? '')) i++
  if (argv[i] === 'env') {
    i++
    while (i < argv.length) {
      const token = argv[i] ?? ''
      if (token === '-u') {
        i += 2
        continue
      }
      if (ASSIGNMENT_WORD.test(token) || token.startsWith('-')) {
        i++
        continue
      }
      break
    }
  }
  if (argv[i] !== 'which') return 0
  let operands = 0
  let optionsEnded = false
  for (let k = i + 1; k < argv.length; k++) {
    const arg = argv[k] ?? ''
    if (!optionsEnded && arg === '--') {
      optionsEnded = true
      continue
    }
    if (!optionsEnded && arg.startsWith('-')) {
      if (WHICH_LONG_FLAGS.has(arg) || /^-[as]+$/.test(arg)) continue
      return 0
    }
    operands++
  }
  return operands
}

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

export function closingTableCommand(command: string): ClosingStatement | undefined {
  const closing = closingStatement(command)
  if (closing === undefined || !Object.hasOwn(COMMAND_SEMANTICS, commandWord(closing.stage))) return undefined
  return watchesItsShell(command, closing) ? undefined : closing
}

export function interpretCommandResult(
  command: string,
  exitCode: number,
  _stdout: string,
  _stderr: string,
  ran?: { stage: string; endedOnOne: boolean; pipeline: number[] | undefined },
): { isError: boolean; message?: string } {
  if (exitCode === 0) return { isError: false }
  if (exitCode === 1 && ran !== undefined) {
    const itsOwn = ran.endedOnOne && (ran.pipeline === undefined || ran.pipeline[ran.pipeline.length - 1] === 1)
    const semantic = itsOwn ? COMMAND_SEMANTICS[commandWord(ran.stage)] : undefined
    return semantic === undefined ? { isError: true, message: 'failed with exit code 1' } : semantic(1)
  }
  const base = baseCommandFor(command)
  if (base === 'which' && exitCode > 1 && exitCode < 126 && exitCode <= whichOperandCount(command)) {
    return { isError: false, message: 'a name was not found' }
  }
  const semantic = Object.hasOwn(COMMAND_SEMANTICS, base) ? COMMAND_SEMANTICS[base] : undefined
  if (semantic !== undefined) return semantic(exitCode)
  return { isError: true, message: `failed with exit code ${exitCode}` }
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
