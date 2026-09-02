// ============================================================================
//  busIdentity — the ONE source of truth for teammate-bus ADDRESSES.
//
//  THE CLASS THIS KILLS: a bus
//  address lived in three places at once — the daemon drains the inbox file
//  named by its spawn agentName ('implementer'), the packs advertise the
//  CHATROOM NAMEPLATE ('[Mercury-Implement]'), and writeToMailbox happily
//  creates `inboxes/<whatever the model typed>.json`. Every rebrand of the
//  display name silently re-broke the send side: dispatches landed unread in
//  `Mercury-Implement.json` (Jun 26) and `Mercury-Implement.json` (Jul 6) —
//  dead-letter inboxes no drain ever reads — while the operator heard
//  "nothing back yet". The address is an IDENTITY, not a string the model
//  free-types: every send seam canonicalizes through here, unknown directive
//  targets FAIL CLOSED (a loud tool error beats a silent strand), and the
//  daemon heals stranded alias mail into the canonical inbox.
//
//  A LEAF module (no imports beyond constants) so proofs bun-import it and
//  both the tool (foreground) and the daemon can share it without cycles.
//  TEAM_LEAD_NAME is mirrored from utils/swarm/constants.ts as a literal —
//  scripts/scribe/prove-bus-identity.ts drift-guards the two.
// ============================================================================

export const SCRIBE_TEAM_NAME = 'scribe'

/** Canonical bus agent names — these ARE the inbox filenames the drains read. */
export const IMPLEMENTER_AGENT_NAME = 'implementer'
export const BUS_TEAM_LEAD_NAME = 'team-lead' // mirror of swarm TEAM_LEAD_NAME (leaf copy)

/** Chatroom display nameplates (render-only — NEVER a mailbox address).
 *  Single source: UserTeammateMessage / the packs derive from here so a
 *  future rebrand cannot fork the address again. */
export const SCRIBE_DISPLAY_NAME = 'Mercury-Amanuensis'
export const IMPLEMENTER_DISPLAY_NAME = 'Mercury-Implement'

/** Per-team canonical → accepted aliases (all matched case-insensitively,
 *  after trimming and stripping one layer of [brackets] / a leading @).
 *  Aliases include every display name this project has ever advertised —
 *  the heal path uses the same table, so historical strands recover. */
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

/** Normalize a model-typed recipient for matching: trim, strip ONE layer of
 *  surrounding [brackets], strip a leading '@', case-fold, then fold every
 *  separator ('-', '_', '@', whitespace runs) to ONE space. The separator
 *  fold is load-bearing: writeToMailbox names inbox
 *  files through sanitizePathComponent, which shears spaces/'@' to '-' — so
 *  a strand to 'the implementer' lives in `the-implementer.json`, and a
 *  matcher that only collapses whitespace can never heal it. Folding both
 *  the input AND the table entries through this one function makes every
 *  alias match its own sanitize-image by construction. */
export function normalizeBusTargetKey(raw: string): string {
  let s = (raw ?? '').trim()
  if (s.startsWith('[') && s.endsWith(']') && s.length > 2) s = s.slice(1, -1).trim()
  if (s.startsWith('@')) s = s.slice(1).trim()
  return s.toLowerCase().replace(/[-_@\s]+/g, ' ').trim()
}

export interface CanonicalBusTarget {
  /** The address to actually use (canonical when known, the trimmed input otherwise). */
  name: string
  /** True when the input resolved to a canonical bus agent for this team. */
  known: boolean
}

/**
 * Resolve a recipient string to its canonical bus address for a managed team
 * (scribe). Unknown teams (crew, ad-hoc swarms — operator-named teammates)
 * pass through untouched with known:false: this function must never rewrite
 * a name it does not own.
 */
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
    // Fold BOTH sides through the same normalizer so 'team-lead' matches
    // 'team lead', and every alias matches its sanitizePathComponent image
    // ('implementer@scribe' ⇔ 'implementer-scribe' ⇔ 'implementer scribe').
    if (key === normalizeBusTargetKey(canonical)) return { name: canonical, known: true }
    for (const a of aliases) if (key === normalizeBusTargetKey(a)) return { name: canonical, known: true }
  }
  return { name: trimmed, known: false }
}

/** The valid directive targets for a managed team (for fail-closed errors). */
export function knownBusTargets(teamName: string | null | undefined): string[] {
  const table = aliasTableFor(teamName)
  return table ? Object.keys(table) : []
}

/** Is this team's addressing managed by this module (fail-closed on unknowns)? */
export function isManagedBusTeam(teamName: string | null | undefined): boolean {
  return teamName === SCRIBE_TEAM_NAME
}
