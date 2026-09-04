import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { durableAtomicPublishSync } from '../../substrate/durablePublish.js'

export const SIGN_IN_LEDGER_FILE = '.sign-ins.json'
const SIGN_IN_LEDGER_VERSION = 1

export type SignInKind = 'oauth' | 'subscription' | 'api-key' | 'operator-switch'

export interface SignInRecord {
  at: number
  kind: SignInKind
}

interface SignInLedgerFile {
  version: number
  signIns?: Record<string, unknown>
  [k: string]: unknown
}

export interface SignInLedgerIo {
  home?: string
  now?: () => number
}

const FAMILY_RE = /^[a-z][a-z0-9-]{0,31}$/
const KINDS: ReadonlySet<string> = new Set<SignInKind>(['oauth', 'subscription', 'api-key', 'operator-switch'])

let epoch = 0

export function signInLedgerEpoch(): number {
  return epoch
}

const epochListeners = new Set<() => void>()

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
    }
  }
}

export function noteCredentialChange(): void {
  bumpEpoch()
}

export function noteCredentialRemoval(): void {
  noteCredentialChange()
}

function normaliseFamily(family: string): string | undefined {
  const trimmed = family.trim().toLowerCase()
  return FAMILY_RE.test(trimmed) ? trimmed : undefined
}

function ledgerPath(io?: SignInLedgerIo): string {
  if (io?.home !== undefined) return join(io.home, SIGN_IN_LEDGER_FILE)
  const { signInLedgerPath } =
    require('../router/providerSecrets.js') as typeof import('../router/providerSecrets.js')
  return signInLedgerPath(SIGN_IN_LEDGER_FILE)
}

function readFile(io?: SignInLedgerIo): SignInLedgerFile | null {
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath(io), 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as SignInLedgerFile
  } catch {
    return null
  }
}

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

export function readSignInRecord(family: string, io?: SignInLedgerIo): SignInRecord | undefined {
  const name = normaliseFamily(family)
  return name === undefined ? undefined : readSignInLedger(io)[name]
}

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
