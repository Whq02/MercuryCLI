import type { SessionKitV1 } from '../daemon/sessionKit.js'
import type { Command } from '../commands.js'

export function isKitGovernedSkillCommand(command: Command): boolean {
  if (command.type !== 'prompt') return false
  const loadedFrom = (command as { loadedFrom?: string }).loadedFrom
  if (loadedFrom === 'skills' || loadedFrom === 'legacy-commands') return true
  if (loadedFrom === 'extension') return (command as { skillRoot?: string }).skillRoot !== undefined
  return false
}


let bootRoster: ReadonlySet<string> | null = null

export function noteBootSkillRoster(governedNames: Iterable<string>): void {
  if (bootRoster !== null) return
  bootRoster = new Set(governedNames)
}

export function isBootRosterSkill(name: string): boolean {
  return bootRoster !== null && bootRoster.has(name)
}

export function _resetKitGovernanceForTesting(): void {
  bootRoster = null
}


function kitSkillStateOf(kit: SessionKitV1, name: string, bornLater: boolean): 'on' | 'invocable' | 'off' | 'ungoverned' {
  if (kit.resolved === false) {
    const state = kit.deltas?.skillStates[name]
    return state === undefined ? 'on' : state
  }
  if ((kit.skillsOff ?? []).includes(name)) return 'off'
  if (kit.skills.includes(name)) return 'on'
  if (kit.invocable.includes(name)) return 'invocable'
  return bornLater ? 'ungoverned' : 'off'
}

export function kitDropsCommand(kit: SessionKitV1 | undefined, command: Command): boolean {
  if (kit === undefined || !isKitGovernedSkillCommand(command)) return false
  return kitSkillStateOf(kit, command.name, !isBootRosterSkill(command.name)) === 'off'
}

export function offSkillNamesOf(kit: SessionKitV1 | undefined, tableNames: readonly string[]): string[] {
  if (kit === undefined) return []
  const present = new Set(tableNames)
  const spoken =
    kit.resolved === false
      ? Object.entries(kit.deltas?.skillStates ?? {})
          .filter(([, state]) => state === 'off')
          .map(([name]) => name)
      : (kit.skillsOff ?? [])
  const out: string[] = []
  for (const name of new Set([...(bootRoster ?? []), ...spoken])) {
    if (present.has(name)) continue
    if (kitSkillStateOf(kit, name, !isBootRosterSkill(name)) !== 'off') continue
    out.push(name)
  }
  return out
}

export function withKitSkillMark(kit: SessionKitV1 | undefined, command: Command): Command {
  if (kit === undefined || !isKitGovernedSkillCommand(command)) return command
  const state = kitSkillStateOf(kit, command.name, !isBootRosterSkill(command.name))
  if (state !== 'invocable') return command
  return { ...command, disableModelInvocation: true, kitSkillState: 'invocable' as const }
}
