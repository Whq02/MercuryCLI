import { quote } from './shellQuote.js'
import { quoteShellCommand } from './shellQuoting.js'

export function formatShellPrefixCommand(prefix: string, command: string): string {
  const flagIndex = prefix.lastIndexOf(' -')
  if (flagIndex > 0) {
    const executable = prefix.slice(0, flagIndex)
    const flags = prefix.slice(flagIndex + 1)
    return `${quote([executable])} ${flags} ${quote([command])}`
  }
  return `${quote([prefix])} ${quote([command])}`
}

const START_THE_SHELL_WHERE_THE_LINE_LANDS =
  'if "$1" -c : >/dev/null 2>&1; then exec "$1" -c "$2"; fi; if command -v bash >/dev/null 2>&1; then exec bash -c "$2"; fi; printf "%s\\n" "Mercury: its shell at $1 cannot be run where this wrapper ran the line, and no bash is on PATH there, so the command did not run" >&2; exit 127'

export function shellStartLine(shellPath: string, frame: string): string {
  return ['/bin/sh', '-c', START_THE_SHELL_WHERE_THE_LINE_LANDS, 'mercury-shell', shellPath, frame].map(word => quoteShellCommand(word, false)).join(' ')
}

export function shStartLine(script: string): string {
  return ['/bin/sh', '-c', script].map(word => quoteShellCommand(word, false)).join(' ')
}
