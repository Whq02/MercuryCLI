import { notBuilt } from '../../pi/holes.js'

const DIGIT_SHIFT_RE = /\d\s*<<\s*\d/
const ARITH_TEST_SHIFT_RE = /\[\[\s*\d+\s*<<\s*\d+\s*\]\]/

const HEREDOC_RE = /<<-?\s*(?:'[A-Za-z0-9_]+'|"[A-Za-z0-9_]+"|\\?[A-Za-z0-9_]+)/

function containsHeredoc(command: string): boolean {
  if (DIGIT_SHIFT_RE.test(command)) return false
  if (ARITH_TEST_SHIFT_RE.test(command)) return false
  if (hasShiftInsideArithmetic(command)) return false
  return HEREDOC_RE.test(command)
}

function hasShiftInsideArithmetic(command: string): boolean {
  let index = command.indexOf('$((')
  while (index !== -1) {
    const close = command.indexOf('))', index + 3)
    const end = close === -1 ? command.length : close
    if (command.slice(index + 3, end).includes('<<')) return true
    index = command.indexOf('$((', end + 1)
  }
  return false
}

function posixSingleQuote(text: string): string {
  return `'${text.split("'").join("'\\''")}'`
}

export function hasStdinRedirect(command: string): boolean {
  return notBuilt('src/utils/bash/shellQuoting.ts:28')
}

export function shouldAddStdinRedirect(command: string): boolean {
  return notBuilt('src/utils/bash/shellQuoting.ts:34')
}

export function quoteShellCommand(command: string, addStdinRedirect = true): string {
  const quoted = posixSingleQuote(command)
  if (addStdinRedirect && !containsHeredoc(command)) {
    return `${quoted} < /dev/null`
  }
  return quoted
}

export function rewriteWindowsNullRedirect(command: string): string {
  return command.replace(
    /(\d?&?>+\s*)nul(?=\s|$|[|&;)\n])/gi,
    (_match, operator: string) => `${operator}/dev/null`,
  )
}
