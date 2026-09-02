// ============================================================================
//  ownerKey — the canonical owner identity for mutable run/context/IDE state
//
//
//  ONE stable key answers "whose state is this?" for every owner-scoped store
//  (verification sequence, context usage/forecast, compaction hysteresis,
//  debug sessions, run events). It distinguishes:
//    · workspace/project identity (the boot cwd — NOT the drifting live cwd);
//    · the Mercury session/conversation id;
//    · the lane — main thread vs a specific agent id (both coexist in one
//      process);
//    · the query source ONLY when it changes lifecycle semantics (sdk vs
//      repl share 'main'; a forked bookkeeping agent is its own lane).
//
//  The key is a canonical STRING (deterministic serializer, URI-component
//  escaping so '|' can never forge a boundary) — usable as a Map key and in
//  sidecar filenames. Never derive identity from a display label; never
//  compare identities except through this module.
//
//  Pure + React-free (provable). Derivation from live process state lives in
//  resolveOwner.ts so this module stays import-cycle-free for proof scripts.
// ============================================================================

const KEY_PREFIX = 'mo1' // mercury owner, schema 1

export interface OwnerIdentity {
  /** Workspace/project root — the ORIGINAL boot cwd, not the live cwd. */
  workspace: string
  /** Mercury session/conversation id. */
  sessionId: string
  /** 'main' for the main thread, `agent:<id>` for a subagent lane. */
  lane: string
  /** Query source, ONLY when it changes lifecycle semantics ('' otherwise). */
  querySource?: string
}

/** Branded canonical owner key. Construct only via makeOwnerKey(). */
export type OwnerKey = string & { readonly __ownerKey: unique symbol }

const enc = (s: string): string => encodeURIComponent(s)
const dec = (s: string): string => decodeURIComponent(s)

/** The canonical serializer — the ONE way an OwnerKey is minted. */
export function makeOwnerKey(id: OwnerIdentity): OwnerKey {
  return [
    KEY_PREFIX,
    enc(id.workspace),
    enc(id.sessionId),
    enc(id.lane),
    enc(id.querySource ?? ''),
  ].join('|') as OwnerKey
}

/** True when the string is a well-formed canonical owner key. */
export function isOwnerKey(value: unknown): value is OwnerKey {
  if (typeof value !== 'string') return false
  const parts = value.split('|')
  return parts.length === 5 && parts[0] === KEY_PREFIX
}

/** The canonical comparator (keys are canonical strings — equality IS ===). */
export function ownerEquals(a: OwnerKey, b: OwnerKey): boolean {
  return a === b
}

export function parseOwnerKey(key: OwnerKey): OwnerIdentity {
  const parts = key.split('|')
  if (parts.length !== 5 || parts[0] !== KEY_PREFIX) {
    throw new Error(`not a canonical owner key: ${key.slice(0, 40)}`)
  }
  return {
    workspace: dec(parts[1]!),
    sessionId: dec(parts[2]!),
    lane: dec(parts[3]!),
    querySource: parts[4] ? dec(parts[4]!) : undefined,
  }
}

/** The main-thread lane constant. */
export const MAIN_LANE = 'main'

/** Lane name for a subagent. */
export function agentLane(agentId: string): string {
  return `agent:${agentId}`
}

/** A short, filesystem-safe digest of the key (sidecar filenames, labels).
 *  NOT identity — display/storage naming only; collisions only cost a shared
 *  filename prefix, never shared state (full keys are stored inside records). */
export function ownerKeyFileStem(key: OwnerKey): string {
  let h = 5381
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0
  const id = parseOwnerKey(key)
  const lane = id.lane.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24)
  return `${id.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 36)}-${lane}-${(h >>> 0).toString(36)}`
}
