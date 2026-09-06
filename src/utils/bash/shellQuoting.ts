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

export function hasMultilineQuotedString(command: string): boolean {
  let state: 'plain' | 'single' | 'double' = 'plain'
  let regionHasNewline = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (state === 'plain') {
      if (ch === "'") {
        state = 'single'
        regionHasNewline = false
      } else if (ch === '"') {
        state = 'double'
        regionHasNewline = false
      }
      continue
    }
    if (ch === '\\' && i + 1 < command.length) {
      i++
      continue
    }
    if (ch === '\n') {
      regionHasNewline = true
      continue
    }
    if ((state === 'single' && ch === "'") || (state === 'double' && ch === '"')) {
      if (regionHasNewline) return true
      state = 'plain'
    }
  }
  return false
}

function posixSingleQuote(text: string): string {
  return `'${text.split("'").join("'\\''")}'`
}

export function hasStdinRedirect(command: string): boolean {
  return /(?:^|[\s;&|])<(?![<(])\s*\S/.test(command)
}

const HERE_STRING_RE = /(?:^|[\s;&|])<<<\s*\S/

export function shouldAddStdinRedirect(command: string): boolean {
  if (containsHeredoc(command)) return false
  if (HERE_STRING_RE.test(command)) return false
  if (hasStdinRedirect(command)) return false
  return true
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
