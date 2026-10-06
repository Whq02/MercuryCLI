import type { Command } from '../../commands.js'
import { isKitMcpName, isKitExtensionName, isKitSkillName, type SessionKitV1 } from '../../daemon/sessionKit.js'
import { isKitGovernedSkillCommand } from '../../skills/kitGovernance.js'
import { isMcpOrgan, kitMembership } from './membership.js'

export interface KitCompletionRoster {
  mcpNames: readonly string[]
  commands: readonly Command[]
  extensions: readonly string[]
}

const extensionOwnerOf = (mcpName: string): string | null => {
  if (!mcpName.startsWith('ext:')) return null
  return mcpName.split(':')[1] ?? null
}

export function completeSessionKitFromRoster(unresolved: SessionKitV1, roster: KitCompletionRoster): SessionKitV1 {
  const deltas = unresolved.deltas ?? { mcpOff: [], skillStates: {}, extensionsOff: [] }
  const mcp: string[] = []
  for (const name of roster.mcpNames) {
    if (mcp.includes(name)) continue
    if (!isKitMcpName(name)) continue
    if (isMcpOrgan(name)) continue
    if (!kitMembership(unresolved, name)) continue
    const owner = extensionOwnerOf(name)
    if (owner !== null && deltas.extensionsOff.includes(owner)) continue
    mcp.push(name)
  }
  const skills: string[] = []
  const invocable: string[] = []
  for (const command of roster.commands) {
    if (!isKitGovernedSkillCommand(command)) continue
    if (!isKitSkillName(command.name)) continue
    const owner = (command as { extensionInfo?: { manifest?: { name?: string } } }).extensionInfo?.manifest?.name
    if (owner !== undefined && deltas.extensionsOff.includes(owner)) continue
    if ((command as { kitSkillState?: string }).kitSkillState === 'invocable') {
      if (!invocable.includes(command.name)) invocable.push(command.name)
    } else if (!skills.includes(command.name)) {
      skills.push(command.name)
    }
  }
  const extensions: Record<string, 'on' | 'off'> = {}
  for (const name of roster.extensions) {
    if (!isKitExtensionName(name)) continue
    extensions[name] = deltas.extensionsOff.includes(name) ? 'off' : 'on'
  }
  for (const name of deltas.extensionsOff) {
    if (isKitExtensionName(name) && !(name in extensions)) extensions[name] = 'off'
  }
  const resolved: SessionKitV1 = { schema: 1, mcp, skills, invocable }
  const skillsOff = Object.entries(deltas.skillStates)
    .filter(([, state]) => state === 'off')
    .map(([name]) => name)
    .filter(name => isKitSkillName(name) && !skills.includes(name) && !invocable.includes(name))
  if (skillsOff.length > 0) resolved.skillsOff = skillsOff
  if (Object.keys(extensions).length > 0) resolved.extensions = extensions
  return resolved
}
