// Message identity derivation — deterministic ids derived from message uuids.
// Owned Mercury module.

import { createHash } from 'node:crypto'
import type { UUID } from 'crypto'

/**
 * Deterministic UUID derivation: parent uuid + content-block index → a stable
 * uuid-shaped key. normalizeMessages splits multi-block messages into
 * one-block messages and keys the splits with this, so the same input always
 * derives the same uuids (ordering-stable, duplicate-free).
 *
 * The first 24 chars stay the parent's (prefix recovery — the unseen divider
 * and settlement lookups match rows back to their parent by that prefix).
 * The node segment is a HASH of the whole parent identity + index — never
 * the bare index: a bare-index tail collided with any OTHER row whose uuid
 * differed from the parent's only in the node segment (sequential-uuid
 * transcripts: fixtures, imports from other tools), and duplicate React keys
 * in one transcript list corrupt reconciliation — the /clear zombie row and
 * the switch-fence stale pane were exactly that residue.
 */
export function deriveUUID(parentUUID: UUID, index: number): UUID {
  const suffix = createHash('sha1').update(`${parentUUID}:${index}`).digest('hex').slice(0, 12)
  return `${parentUUID.slice(0, 24)}${suffix}` as UUID
}

/**
 * Short stable message id (≤6-char base36) from a uuid — the [id:…] tags the
 * snip tool injects into API-bound messages. Deterministic by construction.
 */
export function deriveShortMessageId(uuid: string): string {
  const leadingHex = uuid.replace(/-/g, '').slice(0, 10)
  return parseInt(leadingHex, 16).toString(36).slice(0, 6)
}
