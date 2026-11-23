type ParsedSlashCommand = { commandName: string; args: string; isMcp: boolean }

export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return null
  const words = trimmed.split(' ')
  const first = words[0] ?? ''
  if (first === '/') return null
  const baseName = first.slice(1)
  const isMcp = words[1] === '(MCP)'
  const commandName = isMcp ? `${baseName} (MCP)` : baseName
  const args = words.slice(isMcp ? 2 : 1).join(' ')
  return { commandName, args, isMcp }
}
