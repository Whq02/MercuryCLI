// ============================================================================
//  TeamCharter — the versioned INTENT record a Mercury team is created with
// what the team exists to achieve, how success is
//  judged, and who owns synthesis.
//  Stored inside the team file (TeamFile.charter — optional, so every
//  pre-charter team file keeps parsing) and handed to every teammate as part
//  of its role packet, so "why does this team exist" is machine-readable
//  instead of folklore in the lead's transcript.
// ============================================================================

import { TEAM_LEAD_NAME } from './constants.js'

export const TEAM_CHARTER_VERSION = 1 as const

export type TeamCharter = {
  version: typeof TEAM_CHARTER_VERSION
  teamName: string
  objective: string
  successCriteria: readonly string[]
  /** Who folds teammate results into the deliverable (normally the lead). */
  synthesisOwner: string
  createdAt: number
}

/** One teammate's individual assignment under the charter — compact, typed,
 *  serializable; the spawn path formats it into the teammate's context. */
export type TeamRolePacket = {
  teammateName: string
  agentType: string
  mission: string
  owns: readonly string[]
  dependsOn: readonly string[]
  deliverable: string
  doneWhen: readonly string[]
  handoffTo: string
  charterVersion: typeof TEAM_CHARTER_VERSION
}

export type DeriveCharterInputs = {
  teamName: string
  /** Free-text team description (the legacy field). */
  description?: string
  /** Structured fields — when present they win over derivation. */
  objective?: string
  successCriteria?: readonly string[]
  createdAt: number
}

/**
 * Build the charter deterministically. Structured inputs win; otherwise the
 * objective derives from the description; the fallback is honest about being
 * underspecified rather than inventing goals.
 */
export function deriveTeamCharter(i: DeriveCharterInputs): TeamCharter {
  const objective =
    i.objective?.trim() ||
    i.description?.trim() ||
    `Complete the operator's task that created team ${i.teamName} (no objective was stated — the lead should set one before spawning).`
  return {
    version: TEAM_CHARTER_VERSION,
    teamName: i.teamName,
    objective,
    successCriteria: [...(i.successCriteria ?? [])],
    synthesisOwner: TEAM_LEAD_NAME,
    createdAt: i.createdAt,
  }
}

/**
 * Tolerant migration parse: pre-charter team files (or foreign shapes) return
 * null and the team keeps working; only a well-formed v1 charter round-trips
 * (unknown fields are ignored).
 */
export function parseTeamCharter(raw: unknown): TeamCharter | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.version !== TEAM_CHARTER_VERSION) return null
  if (typeof o.teamName !== 'string' || typeof o.objective !== 'string') return null
  if (typeof o.synthesisOwner !== 'string') return null
  if (typeof o.createdAt !== 'number') return null
  const criteria = Array.isArray(o.successCriteria)
    ? o.successCriteria.filter((c): c is string => typeof c === 'string')
    : []
  return {
    version: TEAM_CHARTER_VERSION,
    teamName: o.teamName,
    objective: o.objective,
    successCriteria: criteria,
    synthesisOwner: o.synthesisOwner,
    createdAt: o.createdAt,
  }
}

/** The charter as compact teammate-context text (composes it after
 *  the role contract, before the task message). */
export function formatCharterForContext(c: TeamCharter): string {
  const criteria =
    c.successCriteria.length > 0
      ? c.successCriteria.map(s => `  - ${s}`).join('\n')
      : '  - (none stated — report evidence of completion to the lead)'
  return [
    `# Team charter — ${c.teamName} (v${c.version})`,
    `Objective: ${c.objective}`,
    `Success criteria:`,
    criteria,
    `Synthesis owner: ${c.synthesisOwner} — report conclusions and evidence there, not raw transcripts.`,
  ].join('\n')
}

/** One teammate's assignment, formatted for its initial context. */
export function formatRolePacketForContext(p: TeamRolePacket): string {
  const list = (xs: readonly string[], empty: string): string =>
    xs.length > 0 ? xs.join(' · ') : empty
  return [
    `# Your assignment — ${p.teammateName} (${p.agentType})`,
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
