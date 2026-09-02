// Name-deduplicated union of built-in and MCP-provided commands;
// built-ins first — they win deduplication.

import { useMemo } from 'react'
import type { Command } from '../commands.js'

export function useMergedCommands(
  initialCommands: Command[],
  mcpCommands: Command[] | undefined,
): Command[] {
  return useMemo(() => {
    if (!mcpCommands || mcpCommands.length === 0) return initialCommands
    const seen = new Set(initialCommands.map(command => command.name))
    return [
      ...initialCommands,
      ...mcpCommands.filter(command => !seen.has(command.name)),
    ]
  }, [initialCommands, mcpCommands])
}
