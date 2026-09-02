import { quote } from './shellQuote.js'

export function formatShellPrefixCommand(prefix: string, command: string): string {
  const splitIndex = prefix.lastIndexOf(' -')
  if (splitIndex > 0) {
    const executable = prefix.slice(0, splitIndex)
    const flags = prefix.slice(splitIndex + 1)
    return `${quote([executable])} ${flags} ${quote([command])}`
  }
  return `${quote([prefix])} ${quote([command])}`
}
