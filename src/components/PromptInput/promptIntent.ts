
import { type Command, findCommand, isCommandEnabled } from '../../commands.js'

export type AgentViewIntent =
  | { kind: 'agent-literal'; text: string }
  | { kind: 'session-command'; command: Command }
  | { kind: 'agent-command'; command: Command }
  | { kind: 'unknown-command'; bareName: string }
  | { kind: 'agent-guidance' }

export function classifyAgentViewSubmission(
  inputParam: string,
  fromKeybinding: boolean,
  commands: Command[],
): AgentViewIntent {
  const trimmed = inputParam.trim()
  if (trimmed.startsWith('//')) {
    return { kind: 'agent-literal', text: trimmed.slice(1) }
  }
  if (fromKeybinding || trimmed.startsWith('/')) {
    const spaceIdx = trimmed.indexOf(' ')
    const bareName = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).replace(/^\//, '')
    const matching = findCommand(bareName, commands)
    if (matching && isCommandEnabled(matching)) {
      return (matching.scope ?? 'session') === 'session'
        ? { kind: 'session-command', command: matching }
        : { kind: 'agent-command', command: matching }
    }
    return { kind: 'unknown-command', bareName }
  }
  return { kind: 'agent-guidance' }
}
