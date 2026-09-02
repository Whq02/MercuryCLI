
export const SCRIBE_TEAM_NAME = 'scribe'

export const IMPLEMENTER_AGENT_NAME = 'implementer'
export const BUS_TEAM_LEAD_NAME = 'team-lead'

export const SCRIBE_DISPLAY_NAME = 'Mercury-Amanuensis'
export const IMPLEMENTER_DISPLAY_NAME = 'Mercury-Implement'

const SCRIBE_ALIASES: Record<string, readonly string[]> = {
  [IMPLEMENTER_AGENT_NAME]: [
    'implementer',
    'the implementer',
    'implement',
    'implementer@scribe',
    'mercury-implement',
    'mercury implement',
  ],
  [BUS_TEAM_LEAD_NAME]: [
    'team-lead',
    'team lead',
    'lead',
    'scribe',
    'the scribe',
    'amanuensis',
    'mercury-amanuensis',
  ],
}

function aliasTableFor(teamName: string | null | undefined): Record<string, readonly string[]> | null {
  if (teamName === SCRIBE_TEAM_NAME) return SCRIBE_ALIASES
  return null
}

export function normalizeBusTargetKey(raw: string): string {
  let s = (raw ?? '').trim()
  if (s.startsWith('[') && s.endsWith(']') && s.length > 2) s = s.slice(1, -1).trim()
  if (s.startsWith('@')) s = s.slice(1).trim()
  return s.toLowerCase().replace(/[-_@\s]+/g, ' ').trim()
}

export interface CanonicalBusTarget {
  name: string
  known: boolean
}

export function canonicalizeBusTarget(
  teamName: string | null | undefined,
  raw: string,
): CanonicalBusTarget {
  const trimmed = (raw ?? '').trim()
  const table = aliasTableFor(teamName)
  if (!table) return { name: trimmed, known: false }
  const key = normalizeBusTargetKey(trimmed)
  if (key.length === 0) return { name: trimmed, known: false }
  for (const [canonical, aliases] of Object.entries(table)) {
    if (key === normalizeBusTargetKey(canonical)) return { name: canonical, known: true }
    for (const a of aliases) if (key === normalizeBusTargetKey(a)) return { name: canonical, known: true }
  }
  return { name: trimmed, known: false }
}

export function knownBusTargets(teamName: string | null | undefined): string[] {
  const table = aliasTableFor(teamName)
  return table ? Object.keys(table) : []
}

export function isManagedBusTeam(teamName: string | null | undefined): boolean {
  return teamName === SCRIBE_TEAM_NAME
}
