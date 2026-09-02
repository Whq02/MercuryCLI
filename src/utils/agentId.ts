/**
 * Deterministic agent and request identity.
 *
 * Agent ids are `<agentName>@<teamName>` (contract data — parsed by other
 * processes): respawning the same-named agent in the same team reproduces
 * its id (reconnection after crashes), the id stays human-readable, and a
 * lead can compute a teammate's id without a lookup. `@` is the separator,
 * so agent names must not contain it; callers sanitise names before
 * formatting.
 */

export function formatAgentId(agentName: string, teamName: string): string {
  return `${agentName}@${teamName}`
}

/**
 * Split at the FIRST `@`; null when there is none. A team name may itself
 * contain `@` and still round-trip.
 */
export function parseAgentId(agentId: string): { agentName: string; teamName: string } | null {
  const separator = agentId.indexOf('@')
  if (separator === -1) return null
  return {
    agentName: agentId.slice(0, separator),
    teamName: agentId.slice(separator + 1),
  }
}

// Millisecond timestamps alone let a same-millisecond dispatch burst mint
// identical ids; downstream consumers key ledger entries by request id and
// mark messages read by a text/timestamp/sender triple, so colliding ids
// silently merged two dispatches — corrupting the in-flight count and able
// to drop a duplicate-text dispatch. The per-process monotonic suffix makes
// every mint unique.
let requestIdSequence = 0

/** `<requestType>-<timestampMillis>.<seqBase36>@<agentId>` (contract data). */
export function generateRequestId(requestType: string, agentId: string): string {
  requestIdSequence += 1
  return `${requestType}-${Date.now()}.${requestIdSequence.toString(36)}@${agentId}`
}

/**
 * Parse a request id, staying compatible with ids that lack the sequence
 * suffix: split at the first `@`; within the prefix, split at the LAST
 * hyphen; the base-10 parse of the timestamp naturally stops at the `.`
 * separator. Null when there is no `@`, no hyphen, or no numeric timestamp.
 */
export function parseRequestId(
  requestId: string,
): { requestType: string; timestamp: number; agentId: string } | null {
  const at = requestId.indexOf('@')
  if (at === -1) return null
  const prefix = requestId.slice(0, at)
  const agentId = requestId.slice(at + 1)
  const hyphen = prefix.lastIndexOf('-')
  if (hyphen === -1) return null
  const requestType = prefix.slice(0, hyphen)
  const timestamp = parseInt(prefix.slice(hyphen + 1), 10)
  if (Number.isNaN(timestamp)) return null
  return { requestType, timestamp, agentId }
}
