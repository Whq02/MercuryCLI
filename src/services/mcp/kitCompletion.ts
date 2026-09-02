// ============================================================================
//  kitCompletion — PROVISIONAL → RESOLVED, the runner's half.
//
//  A kit the DAEMON derived (a coordinator launch_session, another
//  terminal's door, a record-less resume) is stamped UNRESOLVED: deltas +
//  provisional lists nothing may read as membership. THE ONLY ROAD to
//  resolved (the lead-ruled law, typed on SessionKitV1): the runner
//  completes the snapshot at its FIRST BOOT against the roster IT resolves
//  — the merged MCP config it will connect, the post-overlay command table,
//  the active extension set (skills, extensions, .mcp.json approval and
//  policy are the runner's own walk; the daemon never re-runs them) — and
//  reports the RESOLVED kit back through session_facts; the daemon stamps
//  it onto the record (sessionSeat → sessionKit's one pen), once.
//
//  The composer applies the deltas the same way the membership owner and
//  the skills overlay do (their agreement is pinned), excludes ORGANS from
//  the closed lists (organs are never kit-governed — they mount outside the
//  predicate), and filters every name through the kit grammars (the
//  deriveSessionKitForWorkspace precedent: a roster spelling the wire's
//  narrowing would refuse must not poison the whole snapshot).
// ============================================================================
import type { Command } from '../../commands.js'
import { isKitMcpName, isKitExtensionName, isKitSkillName, type SessionKitV1 } from '../../daemon/sessionKit.js'
import { isKitGovernedSkillCommand } from '../../skills/kitGovernance.js'
import { isMcpOrgan, kitMembership } from './membership.js'

/** The roster the runner resolved in its own process. */
export interface KitCompletionRoster {
  /** Every configured MCP name the runner's resolution produced (regular +
   *  sdk planes, extension spellings included). */
  mcpNames: readonly string[]
  /** The session's command table AFTER the tri-state overlay (off skills
   *  already absent; kit-invocable ones carrying their mark). */
  commands: readonly Command[]
  /** The active extensions' manifest names (the switch door's product). */
  extensions: readonly string[]
}

const extensionOwnerOf = (mcpName: string): string | null => {
  if (!mcpName.startsWith('ext:')) return null
  return mcpName.split(':')[1] ?? null
}

/**
 * PURE: the resolved kit for this session — the unresolved stamp's deltas
 * applied to the runner's own roster. The result omits `resolved` (a
 * resolved kit is the closed membership) and always passes the wire's
 * narrowing over a wire-legal roster.
 */
export function completeSessionKitFromRoster(unresolved: SessionKitV1, roster: KitCompletionRoster): SessionKitV1 {
  const deltas = unresolved.deltas ?? { mcpOff: [], skillStates: {}, extensionsOff: [] }
  const mcp: string[] = []
  for (const name of roster.mcpNames) {
    if (mcp.includes(name)) continue
    if (!isKitMcpName(name)) continue
    if (isMcpOrgan(name)) continue
    // The deltas' own subtraction — the same arm the membership owner reads.
    if (!kitMembership(unresolved, name)) continue
    // An extension server under an OFF master contributes nothing (the
    // switch door removes it at the source; subtracted here too so a
    // completion composed before that door's pass stays lawful).
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
  // Deltas can name a master the active set no longer lists — the off word
  // survives (the record's own state, not the roster's).
  for (const name of deltas.extensionsOff) {
    if (isKitExtensionName(name) && !(name in extensions)) extensions[name] = 'off'
  }
  const resolved: SessionKitV1 = { schema: 1, mcp, skills, invocable }
  // THE OFF-CARRY: the deltas' explicit skill-offs survive
  // resolution as skillsOff rows — absence alone covers only what the boot
  // roster saw, and a dial-completion mid-session (the pre-kit session's
  // first dial) must keep a born-later skill's off durable (the lead's Q4
  // ruling; without this the composer dropped the off and the skill came
  // back ambient). Assigned BEFORE extensions — the validator rebuilds the
  // kit in the schema's declaration order, and the daemon stamps the
  // composer's exact bytes: a key-order drift would unequal two equal kits.
  const skillsOff = Object.entries(deltas.skillStates)
    .filter(([, state]) => state === 'off')
    .map(([name]) => name)
    .filter(name => isKitSkillName(name) && !skills.includes(name) && !invocable.includes(name))
  if (skillsOff.length > 0) resolved.skillsOff = skillsOff
  if (Object.keys(extensions).length > 0) resolved.extensions = extensions
  return resolved
}
