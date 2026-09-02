/**
 * Splits a slash-command input into command name, arguments, and an MCP
 * flag. Splitting is on the SINGLE space character — tabs are not separators
 * and repeated spaces produce empty words, so exactly one separator space is
 * consumed and any further run survives the round trip.
 */

export type ParsedSlashCommand = {
  commandName: string
  args: string
  isMcp: boolean
}

const MCP_MARKER = '(MCP)'

export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return null
  const words = trimmed.split(' ')
  const first = words[0] as string
  if (first === '/') return null
  let commandName = first.slice(1)
  if (commandName === '') return null
  let argStart = 1
  let isMcp = false
  if (words[1] === MCP_MARKER) {
    commandName = `${commandName} ${MCP_MARKER}`
    isMcp = true
    argStart = 2
  }
  return { commandName, args: words.slice(argStart).join(' '), isMcp }
}
