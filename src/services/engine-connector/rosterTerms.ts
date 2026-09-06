import type { Command } from '../../commands.js'
import type { MCPServerConnection } from '../mcp/types.js'
import type { McpRosterEntryV1, SkillsRosterEntryV1 } from './types.js'

export function skillsRosterOf(commands: readonly Command[], offNames: readonly string[] = []): SkillsRosterEntryV1[] {
  const rows: SkillsRosterEntryV1[] = commands
    .filter(
      command =>
        command.type === 'prompt' &&
        command.source !== 'builtin' &&
        (command.loadedFrom === 'bundled' ||
          command.loadedFrom === 'skills' ||
          command.hasUserSpecifiedDescription === true ||
          Boolean(command.whenToUse)),
    )
    .map(command => ({
      name: command.name,
      description: command.description ?? '',
      ...(command.disableModelInvocation === true ? { state: 'invocable' as const } : {}),
    }))
  const present = new Set(rows.map(row => row.name))
  for (const name of offNames) {
    if (present.has(name)) continue
    present.add(name)
    rows.push({ name, description: '', state: 'off' as const })
  }
  return rows
}

export function mcpRosterEntriesOf(
  mount: readonly MCPServerConnection[],
  dynamic: readonly MCPServerConnection[],
): McpRosterEntryV1[] {
  const seen = new Set<string>()
  const rows: McpRosterEntryV1[] = []
  for (const client of [...mount, ...dynamic]) {
    if (seen.has(client.name)) continue
    seen.add(client.name)
    rows.push({
      name: client.name,
      type: client.type,
      ...(client.type === 'failed' && client.error !== undefined && client.error !== ''
        ? { error: client.error }
        : {}),
    })
  }
  return rows
}
