import { pinnedCommandAnalysis } from '../../utils/permissions/decision/commandAnalysis.js'

export type CommandSemantic = (exitCode: number) => { isError: boolean; message?: string }

const COMMAND_SEMANTICS: Record<string, CommandSemantic> = {
  grep: code => ({
    isError: code >= 2,
    message: code === 1 ? 'no matches found' : undefined,
  }),
  rg: code => ({
    isError: code >= 2,
    message: code === 1 ? 'no matches found' : undefined,
  }),
  find: code => ({
    isError: code >= 2,
    message: code === 1 ? 'some directories were inaccessible' : undefined,
  }),
  diff: code => ({
    isError: code >= 2,
    message: code === 1 ? 'files differ' : undefined,
  }),
  cmp: code => ({
    isError: code >= 2,
    message: code === 1 ? 'files differ' : undefined,
  }),
  pgrep: code => ({
    isError: code >= 2,
    message: code === 1 ? 'no process matched' : undefined,
  }),
  test: code => ({
    isError: code >= 2,
    message: code === 1 ? 'condition is false' : undefined,
  }),
  '[': code => ({
    isError: code >= 2,
    message: code === 1 ? 'condition is false' : undefined,
  }),
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
  return words[i] ?? ''
}

export function interpretCommandResult(
  command: string,
  exitCode: number,
  _stdout: string,
  _stderr: string,
): { isError: boolean; message?: string } {
  const base = baseCommandFor(command)
  const semantic = COMMAND_SEMANTICS[base]
  if (semantic) {
    return semantic(exitCode)
  }
  if (exitCode !== 0) {
    return { isError: true, message: `failed with exit code ${exitCode}` }
  }
  return { isError: false }
}
