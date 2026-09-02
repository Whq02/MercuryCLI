/**
 * Format a configured shell-executable prefix plus a command into a safely
 * quoted invocation string.
 *
 * The prefix may be a bare name, an absolute path, or a path plus flags. The
 * split point is the LAST occurrence of a space followed by `-`: paths may
 * contain spaces (a Windows install path is the driving case) while the
 * flags must stay separate shell words, so the executable path is quoted and
 * the flag section is emitted unquoted.
 */
import { quote } from './shellQuote.js'

export function formatShellPrefixCommand(prefix: string, command: string): string {
  const splitIndex = prefix.lastIndexOf(' -')
  if (splitIndex > 0) {
    const executable = prefix.slice(0, splitIndex)
    const flags = prefix.slice(splitIndex + 1) // from just after the space
    return `${quote([executable])} ${flags} ${quote([command])}`
  }
  return `${quote([prefix])} ${quote([command])}`
}
