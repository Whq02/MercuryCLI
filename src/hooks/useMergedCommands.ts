import { useMemo } from 'react'
import type { Command } from '../commands.js'

export function useMergedCommands(
  initialCommands: Command[],
  mcpCommands?: Command[],
): Command[] {
  return useMemo(() => {
    if (!mcpCommands || mcpCommands.length === 0) return initialCommands
    const initialNames = new Set(initialCommands.map(command => command.name))
    const appended = mcpCommands.filter(command => !initialNames.has(command.name))
    return [...initialCommands, ...appended]
  }, [initialCommands, mcpCommands])
}
