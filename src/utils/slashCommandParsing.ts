
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
