
import { CREW_LEAD_NAME } from './constants.js'

export const CREW_CHARTER_VERSION = 1 as const

export type CrewCharter = {
  version: typeof CREW_CHARTER_VERSION
  crewName: string
  objective: string
  successCriteria: readonly string[]
  synthesisOwner: string
  createdAt: number
}

export type CrewRolePacket = {
  crewmateName: string
  agentType: string
  mission: string
  owns: readonly string[]
  dependsOn: readonly string[]
  deliverable: string
  doneWhen: readonly string[]
  handoffTo: string
  charterVersion: typeof CREW_CHARTER_VERSION
}

export type DeriveCharterInputs = {
  crewName: string
  description?: string
  objective?: string
  successCriteria?: readonly string[]
  createdAt: number
}

export function deriveCrewCharter(i: DeriveCharterInputs): CrewCharter {
  const objective =
    i.objective?.trim() ||
    i.description?.trim() ||
    `Complete the operator's task that created crew ${i.crewName} (no objective was stated — the lead should set one before spawning).`
  return {
    version: CREW_CHARTER_VERSION,
    crewName: i.crewName,
    objective,
    successCriteria: [...(i.successCriteria ?? [])],
    synthesisOwner: CREW_LEAD_NAME,
    createdAt: i.createdAt,
  }
}

export function parseCrewCharter(raw: unknown): CrewCharter | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.version !== CREW_CHARTER_VERSION) return null
  if (typeof o.crewName !== 'string' || typeof o.objective !== 'string') return null
  if (typeof o.synthesisOwner !== 'string') return null
  if (typeof o.createdAt !== 'number') return null
  const criteria = Array.isArray(o.successCriteria)
    ? o.successCriteria.filter((c): c is string => typeof c === 'string')
    : []
  return {
    version: CREW_CHARTER_VERSION,
    crewName: o.crewName,
    objective: o.objective,
    successCriteria: criteria,
    synthesisOwner: o.synthesisOwner,
    createdAt: o.createdAt,
  }
}

export function formatCharterForContext(c: CrewCharter): string {
  const criteria =
    c.successCriteria.length > 0
      ? c.successCriteria.map(s => `  - ${s}`).join('\n')
      : '  - (none stated — report evidence of completion to the lead)'
  return [
    `# Crew charter — ${c.crewName} (v${c.version})`,
    `Objective: ${c.objective}`,
    `Success criteria:`,
    criteria,
    `Synthesis owner: ${c.synthesisOwner} — report conclusions and evidence there, not raw transcripts.`,
  ].join('\n')
}

export function formatRolePacketForContext(p: CrewRolePacket): string {
  const list = (xs: readonly string[], empty: string): string =>
    xs.length > 0 ? xs.join(' · ') : empty
  return [
    `# Your assignment — ${p.crewmateName} (${p.agentType})`,
    `Mission: ${p.mission}`,
    `You own: ${list(p.owns, 'the surfaces your mission names')}`,
    `Depends on: ${list(p.dependsOn, 'nothing — start immediately')}`,
    `Deliverable: ${p.deliverable}`,
    `Done when:`,
    ...(p.doneWhen.length > 0
      ? p.doneWhen.map(d => `  - ${d}`)
      : ['  - your deliverable is produced and evidenced']),
    `Hand off to: ${p.handoffTo}`,
  ].join('\n')
}
