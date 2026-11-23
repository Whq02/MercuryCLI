import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { durableAtomicPublishSync } from '../../../platform/substrate/durablePublish.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { errorMessage } from '../../../platform/errors/errors.js'
import { getAuthConfigHomeDir } from '../../../platform/environment/envUtils.js'
import { passedOver } from '../../../platform/errors/passedOver.js'
import { startMicrotask } from '../../../platform/async/timers.js'

export const SIGN_IN_LEDGER_FILE = '.sign-ins.json'
const SIGN_IN_LEDGER_VERSION = 1

export type SignInKind = 'oauth' | 'subscription' | 'api-key' | 'operator-switch'

interface SignInRecord {
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

let fanOutQueued = false
function bumpEpoch(): void {
  epoch += 1
  if (fanOutQueued) return
  fanOutQueued = true
  startMicrotask(() => {
    fanOutQueued = false
    for (const listener of [...epochListeners]) {
      try {
        listener()
      } catch (error) {
        passedOver(error)
      }
    }
  })
}

export function noteCredentialChange(): void {
  bumpEpoch()
}

function normaliseFamily(family: string): string | undefined {
  const trimmed = family.trim().toLowerCase()
  return FAMILY_RE.test(trimmed) ? trimmed : undefined
}

function ledgerPath(io?: SignInLedgerIo): string {
  if (io?.home !== undefined) return join(io.home, SIGN_IN_LEDGER_FILE)
  const { signInLedgerPath } =
    require('./providerSecrets.js') as typeof import('./providerSecrets.js')
  return signInLedgerPath(SIGN_IN_LEDGER_FILE)
}

function readFile(io?: SignInLedgerIo): SignInLedgerFile | null {
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath(io), 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as SignInLedgerFile
  } catch (error) {
    passedOver(error)
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

export function publishSignInRecord(path: string, text: string): void {
  durableAtomicPublishSync(path, text, { mode: 0o600 })
}

export function signInRefusalPath(family: string, home: string): string | undefined {
  return /^(?:[a-z][a-z0-9-]{0,31}|compat-[a-z0-9-]{1,32})$/.test(family) ? join(home, '.sign-in-refusals', `${family}.json`) : undefined
}

function clearSignInRefusal(family: string, home = getAuthConfigHomeDir()): void {
  try {
    const path = signInRefusalPath(family, home)
    if (!path) return
    publishSignInRecord(path, JSON.stringify({ version: 1, generation: randomUUID() }) + '\n')
  } catch (error) {
    logForDebugging(`[accounts] the refusal record of ${family} could not be cleared after its sign-in, so it still reads refused until a later answer succeeds: ${errorMessage(error)}`, { level: 'warn' })
  }
}

export function signInRecordRestorer(family: string, io?: SignInLedgerIo): () => void {
  const name = normaliseFamily(family)
  const previous = name === undefined ? undefined : readFile(io)?.signIns?.[name]
  return () => {
    if (name === undefined) return
    try {
      const existing = readFile(io)
      if (existing === null || typeof existing.signIns !== 'object' || existing.signIns === null) return
      const signIns: Record<string, unknown> = { ...existing.signIns }
      if (previous === undefined) delete signIns[name]
      else signIns[name] = previous
      durableAtomicPublishSync(ledgerPath(io), JSON.stringify({ ...existing, version: SIGN_IN_LEDGER_VERSION, signIns }, null, 2) + '\n', { mode: 0o600 })
      bumpEpoch()
    } catch (error) {
      logForDebugging(`[accounts] the sign-in of ${name} that was refused could not be taken out of the sign-in ledger: ${errorMessage(error)}`, { level: 'warn' })
    }
  }
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
    if (kind !== 'operator-switch') {
      clearSignInRefusal(name, io?.home)
    }
    bumpEpoch()
    return true
  } catch (error) {
    logForDebugging(`[accounts] the sign-in of ${name} could not be recorded in the sign-in ledger, so the default provider and the refusal clearing do not see it: ${errorMessage(error)}`, { level: 'warn' })
    return false
  }
}
