// ============================================================================
//  src/services/mcp/membership.ts — THE membership-predicate owner.
//
//  ONE question, ONE owner: may a connect road open (or keep) a connection
//  to this configured server? Every consulting road — the screen's
//  interactive registry, the headless runner batch, the reload re-seed, the
//  CLI health probe, the wire reconnect — answers through this module, so
//  the decision has exactly one spelling.
//
//  THE SWAP POINT: a process WITH a session kit (a
//  daemon-hosted runner; the consumed-once latch in sessionKitPin.ts)
//  answers from ITS KIT through kitMembership below — the live record is
//  never consulted again (a menu edit after birth must not reach a live
//  session: L24(3)). A process with NO kit (the interactive screen, a plain
//  boot, a warm runner before its claim, a pre-kit record's respawn)
//  answers today's per-project record, byte-identically — the
//  `disabledMcpServers` opt-out list and, for default-disabled built-ins,
//  the `enabledMcpServers` opt-in list (isMcpServerDisabled in config.ts).
//  Never add a second spelling of this decision.
//
//  ORGANS OUTSIDE (Q1, the lane ruling): the product's own organs — the
//  in-process coordination server and the ide bridge — are never governed
//  by a kit: a kit listing NOTHING still mounts every organ. claude.ai
//  connectors are NOT organs: they are the operator's own estate, governed
//  by the record today (the hook's connector arm consults this owner) and
//  by the kit like any member. The organ arm exists only under a kit — an
//  un-kitted process keeps today's record semantics whole.
//
//  Display surfaces (readiness rows, the cockpit gauge) and the dedup
//  narrowing deliberately keep reading the RECORD (isMcpServerDisabled):
//  they report or index record truth rather than making connect decisions.
// ============================================================================
import type { SessionKitV1 } from '../../daemon/sessionKit.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { isMcpServerDisabled } from './config.js'
import { sessionKitOf } from './sessionKitPin.js'
import type { ScopedMcpServerConfig } from './types.js'

// The organ names, spelled beside their owners (a static
// import of coordinationServer.ts would pull zod and
// the coordination service into every membership consumer's load graph;
// prove-kit-runner pins these equal to the owners' spellings):
//   · coordinationServer.ts COORDINATION_SERVER_NAME + the '=0'-only
//     off-switch of isCoordinationServerEnabled (MERCURY_COORDINATION_MCP);
//   · the ide bridge's fixed client name ('ide' — the /mcp toggle's own
//     exemption; its connect road never consults this owner, so the organ
//     arm here is belt-and-braces for config-riding spellings).
const COORDINATION_ORGAN_NAME = 'mercury'
const IDE_ORGAN_NAME = 'ide'

/** Is this name one of the product's own organs (never kit-governed)? */
export function isMcpOrgan(name: string): boolean {
  if (name === IDE_ORGAN_NAME) return true
  return name === COORDINATION_ORGAN_NAME && flagEnv('MERCURY_COORDINATION_MCP') !== '0'
}

/** Today's per-project record, verbatim — the absent-kit arm. */
function recordMembership(name: string): boolean {
  return !isMcpServerDisabled(name)
}

/**
 * Membership: is this configured server a member of THIS PROCESS's
 * effective catalogue — i.e. may a connect road open (or keep) a connection
 * to it? A process with no session kit answers exactly today's per-project
 * record semantics, unchanged; a kitted process answers its kit, with the
 * organs outside.
 */
export function isMcpCatalogueMember(name: string): boolean {
  const kit = sessionKitOf()
  if (kit === undefined) return recordMembership(name)
  return isMcpOrgan(name) || kitMembership(kit, name)
}

/**
 * THE KIT'S MEMBERSHIP — the predicate the owner above consults for a
 * kitted process (the swap):
 *   · NO kit (a pre-kit record, a warm boot before its claim) ⇒ today's
 *     record predicate — whole-config behaviour, unchanged;
 *   · a RESOLVED kit (the screen composed it, or the runner completed it)
 *     ⇒ the listed names ARE the members and nothing else is — an EMPTY
 *     list admits NOTHING, and the live record is never consulted again
 *     (a menu edit after birth must not reach a live session: L24(3));
 *   · an UNRESOLVED kit (the daemon derived it; the runner completes) ⇒ the
 *     kit's own off-deltas subtract from whatever the runner resolved — the
 *     snapshot's deltas, NEVER its provisional lists (the lead-ruled law:
 *     nothing reads an unresolved kit's lists as membership) and never the
 *     live record, for the same reason.
 * Organs are exempted by the owner BEFORE this predicate — a kit's lists
 * never name an organ, and an empty kit must not sever one.
 */
export function kitMembership(kit: SessionKitV1 | undefined, name: string): boolean {
  if (kit === undefined) return recordMembership(name)
  if (kit.resolved === false) return !(kit.deltas?.mcpOff ?? []).includes(name)
  return kit.mcp.includes(name)
}

/**
 * The runner batch's split: members connect; excluded entries surface as
 * truthful 'disabled' roster rows — the same seed the interactive registry
 * performs (disabled included, connections absent) — and are never dialed.
 * Entry order within each half preserves the batch's own order.
 */
export function partitionMcpConfigsByMembership(
  configs: Record<string, ScopedMcpServerConfig>,
): {
  members: Array<[string, ScopedMcpServerConfig]>
  excluded: Array<[string, ScopedMcpServerConfig]>
} {
  const members: Array<[string, ScopedMcpServerConfig]> = []
  const excluded: Array<[string, ScopedMcpServerConfig]> = []
  for (const entry of Object.entries(configs)) {
    ;(isMcpCatalogueMember(entry[0]) ? members : excluded).push(entry)
  }
  return { members, excluded }
}
