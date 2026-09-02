// ============================================================================
//  utils/accounts/signInLedger — the ONE record of WHEN each provider family
//  last signed in (the neutral-default ruling: "the
//  most recent sign-in acts as the default").
//
//  The computed default (utils/model/computedDefault) reads "the provider of
//  the most recent sign-in". No credential store recorded a sign-in time
//  before this ledger, so the families' sign-in owners record it here at
//  the moment a credential LANDS from a sign-in — a pasted key stored, an
//  OAuth or device-code grant exchanged, a subscription connected. A token
//  REFRESH is not a sign-in and never records; neither is an env pin (the
//  shell's word, present without a sign-in) nor a configured keyless
//  endpoint — those credentials read as UNTIMED at the resolver, which
//  orders them after every timed sign-in and says so. /defaultprovider
//  records an 'operator-switch' entry: the operator's word that a family is
//  the most recent sign-in, on the same ledger, with no other store.
//
//  Laws:
//    · the file follows the AUTH SCOPE (getAuthConfigHomeDir — the same
//      home as the credential stores it describes); ONE entry per family,
//      the latest sign-in winning (an older one is superseded, never kept);
//    · no secret ever enters it — a family id, a kind word, a time;
//    · a write never throws (a ledger failure never fails a sign-in) and a
//      read never throws (a missing or corrupt file reads as EMPTY; the next
//      record rewrites it whole); unknown keys in a readable file survive a
//      rewrite (the versioned-shape law every store here follows);
//    · every landed record bumps an in-process epoch, so a resolver memo
//      re-reads the moment a sign-in lands in this process; a sign-OUT
//      bumps the same epoch (noteCredentialRemoval — the removal owners
//      call it), and subscribers (subscribeSignInEpoch) hear every bump, so
//      a screen keyed on the epoch re-derives without a restart;
//    · the resolver, not this store, decides what an untimed credential
//      means. Pure node:fs + the atomic publish primitive — bun-loadable, so
//      the proof (scripts/default-model/) drives the real functions.
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { durableAtomicPublishSync } from '../../substrate/durablePublish.js'

export const SIGN_IN_LEDGER_FILE = '.sign-ins.json'
const SIGN_IN_LEDGER_VERSION = 1

/** The sign-in's shape — the /accounts board's slot vocabulary, plus the
 *  operator's /defaultprovider word. */
export type SignInKind = 'oauth' | 'subscription' | 'api-key' | 'operator-switch'

export interface SignInRecord {
  /** Epoch milliseconds the credential landed. */
  at: number
  kind: SignInKind
}

interface SignInLedgerFile {
  version: number
  signIns?: Record<string, unknown>
  [k: string]: unknown
}

/** Injectable seams for the proof; production callers pass nothing. */
export interface SignInLedgerIo {
  /** The home the ledger lives in — default: the auth scope's home, taken
   *  from the engines' secret store's own door (the scope-isolation law
   *  reserves the auth-scope seam for the credential stores; the ledger
   *  lives beside them and follows their bracket). */
  home?: string
  now?: () => number
}

const FAMILY_RE = /^[a-z][a-z0-9-]{0,31}$/
const KINDS: ReadonlySet<string> = new Set<SignInKind>(['oauth', 'subscription', 'api-key', 'operator-switch'])

/** Bumped on every landed record AND every removal in this process — the
 *  resolvers' memo key. */
let epoch = 0

/** The in-process count of credential moves (a memo key, never a time). */
export function signInLedgerEpoch(): number {
  return epoch
}

const epochListeners = new Set<() => void>()

/** Hear every epoch bump (a sign-in landed, a credential removed) in this
 *  process; returns the unsubscribe. A listener that throws never fails
 *  the sign-in or the removal that woke it. */
export function subscribeSignInEpoch(listener: () => void): () => void {
  epochListeners.add(listener)
  return () => {
    epochListeners.delete(listener)
  }
}

function bumpEpoch(): void {
  epoch += 1
  for (const listener of [...epochListeners]) {
    try {
      listener()
    } catch {
      /* a subscriber's failure is its own */
    }
  }
}

/**
 * A credential LEFT (a slot removed on the board, /logout, a disconnect):
 * the ledger keeps its records (a sign-out is not a sign-in, and the
 * resolver's presence read already answers absence), but the estate moved
 * — every memo keyed on the epoch re-reads, every subscriber re-derives.
 */
export function noteCredentialRemoval(): void {
  bumpEpoch()
}

/** The router family id, normalised; undefined for a spelling no family
 *  could carry (a blank, a display name, a path). */
function normaliseFamily(family: string): string | undefined {
  const trimmed = family.trim().toLowerCase()
  return FAMILY_RE.test(trimmed) ? trimmed : undefined
}

function ledgerPath(io?: SignInLedgerIo): string {
  if (io?.home !== undefined) return join(io.home, SIGN_IN_LEDGER_FILE)
  // A call-time require: the secret store imports this module (its key
  // writes record here), so the door is read when a path is needed, never
  // at load.
  const { signInLedgerPath } =
    require('../router/providerSecrets.js') as typeof import('../router/providerSecrets.js')
  return signInLedgerPath(SIGN_IN_LEDGER_FILE)
}

/** The file at rest, or null (absent · unreadable · not an object). */
function readFile(io?: SignInLedgerIo): SignInLedgerFile | null {
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath(io), 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as SignInLedgerFile
  } catch {
    return null
  }
}

/** Every recorded sign-in, family → record. A missing or corrupt file, and
 *  every malformed entry inside one, reads as absent — never a throw. */
export function readSignInLedger(io?: SignInLedgerIo): Record<string, SignInRecord> {
  const out: Record<string, SignInRecord> = {}
  const raw = readFile(io)?.signIns
  if (typeof raw !== 'object' || raw === null) return out
  for (const [family, value] of Object.entries(raw)) {
    const name = normaliseFamily(family)
    if (name === undefined || typeof value !== 'object' || value === null) continue
    const { at, kind } = value as { at?: unknown; kind?: unknown }
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) continue
    if (typeof kind !== 'string' || !KINDS.has(kind)) continue
    out[name] = { at, kind: kind as SignInKind }
  }
  return out
}

/** One family's recorded sign-in, or undefined. */
export function readSignInRecord(family: string, io?: SignInLedgerIo): SignInRecord | undefined {
  const name = normaliseFamily(family)
  return name === undefined ? undefined : readSignInLedger(io)[name]
}

/**
 * Record that `family` signed in now (the credential just landed, or the
 * operator's /defaultprovider word). The latest record for a family
 * replaces its earlier one. Answers true when the record landed; false for
 * a refused spelling or a failed write — a caller never fails its sign-in
 * over the ledger.
 */
export function recordSignIn(family: string, kind: SignInKind, io?: SignInLedgerIo): boolean {
  const name = normaliseFamily(family)
  if (name === undefined || !KINDS.has(kind)) return false
  try {
    const existing = readFile(io)
    const kept =
      existing !== null && typeof existing.signIns === 'object' && existing.signIns !== null
        ? existing.signIns
        : {}
    const signIns: Record<string, unknown> = { ...kept, [name]: { at: io?.now?.() ?? Date.now(), kind } }
    const next: SignInLedgerFile = { ...(existing ?? {}), version: SIGN_IN_LEDGER_VERSION, signIns }
    durableAtomicPublishSync(ledgerPath(io), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
    bumpEpoch()
    return true
  } catch {
    return false
  }
}
