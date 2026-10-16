import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, mkdirSync, readdirSync, rmdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { getAuthConfigHomeDir } from '../envUtils.js'
import { dropSignInEntry, readSignInEntries, recordSignInEntry, type SignInKind, type SignInLedgerIo } from './signInLedger.js'

export const SIGN_INS_DIR = 'sign-ins'
export const KEY_IDENTITY_MARK = '…'
const FAMILY_RE = /^[a-z][a-z0-9-]{0,31}$/
const SLUG_KEEP = /[^a-z0-9@._+-]/g
const SLUG_MAX = 80

export interface SignInChoice {
  identity: string
  dir: string | null
  kind?: string
}

export type SignInLanding = 'first' | 'replaced' | 'added'

export interface SignInLandingReceipt {
  landed: SignInLanding
  family: string
  identity: string
  dir: string | null
  defaultIdentity: string | undefined
  replaced?: string
}

const sessionChoices = new Map<string, SignInChoice>()
const projectChoices = new Map<string, SignInChoice>()
const transientHomes = new Map<string, string>()
const pinnedHomes = new AsyncLocalStorage<Map<string, string>>()
const choiceListeners = new Set<() => void>()

function familyWord(family: string): string | undefined {
  const trimmed = family.trim().toLowerCase()
  return FAMILY_RE.test(trimmed) ? trimmed : undefined
}

export function isKeyIdentity(identity: string): boolean {
  return identity.startsWith(KEY_IDENTITY_MARK)
}

export function pocketSlug(identity: string): string {
  const base = isKeyIdentity(identity) ? `key-${identity.slice(KEY_IDENTITY_MARK.length)}` : identity
  const slug = base.trim().toLowerCase().replace(SLUG_KEEP, '_').slice(0, SLUG_MAX)
  return slug === '' || slug === '.' || slug === '..' ? 'sign-in' : slug
}

export function signInsEstate(): string {
  return getAuthConfigHomeDir()
}

export function signInsRoot(home: string = getAuthConfigHomeDir()): string {
  return join(home, SIGN_INS_DIR)
}

export function pocketDir(family: string, slug: string, home: string = getAuthConfigHomeDir()): string {
  return join(signInsRoot(home), family, slug)
}

export function isPocketDir(dir: string, home: string = getAuthConfigHomeDir()): boolean {
  const root = resolve(signInsRoot(home))
  const target = resolve(dir)
  return target.startsWith(root + '/') || target.startsWith(root + '\\')
}

export function listPocketSlugs(family: string, home: string = getAuthConfigHomeDir()): string[] {
  const name = familyWord(family)
  if (name === undefined) return []
  try {
    return readdirSync(join(signInsRoot(home), name))
      .filter(entry => {
        try {
          return statSync(join(signInsRoot(home), name, entry)).isDirectory()
        } catch {
          return false
        }
      })
      .sort()
  } catch {
    return []
  }
}

export function freePocketSlug(family: string, identity: string, home: string = getAuthConfigHomeDir()): string {
  const base = pocketSlug(identity)
  const taken = new Set(listPocketSlugs(family, home))
  if (!taken.has(base)) return base
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}

export function ensurePocketDir(family: string, slug: string, home: string = getAuthConfigHomeDir()): string {
  const dir = pocketDir(family, slug, home)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

export function removePocketDir(family: string, slug: string, home: string = getAuthConfigHomeDir()): boolean {
  const dir = pocketDir(family, slug, home)
  if (!isPocketDir(dir, home) || !existsSync(dir)) return false
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    return false
  }
  for (const parent of [join(signInsRoot(home), familyWord(family) ?? family), signInsRoot(home)]) {
    try {
      if (readdirSync(parent).length === 0) rmdirSync(parent)
    } catch {
      break
    }
  }
  return true
}

function fanOut(): void {
  for (const listener of [...choiceListeners]) {
    try {
      listener()
    } catch {
      continue
    }
  }
}

export function subscribeSignInChoice(listener: () => void): () => void {
  choiceListeners.add(listener)
  return () => {
    choiceListeners.delete(listener)
  }
}

export function setSessionSignIn(family: string, choice: SignInChoice | null): void {
  const name = familyWord(family)
  if (name === undefined) return
  if (choice === null) sessionChoices.delete(name)
  else sessionChoices.set(name, { ...choice })
  fanOut()
}

export function setProjectSignIn(family: string, choice: SignInChoice | null): void {
  const name = familyWord(family)
  if (name === undefined) return
  if (choice === null) projectChoices.delete(name)
  else projectChoices.set(name, { ...choice })
  fanOut()
}

export function clearSignInChoices(): void {
  sessionChoices.clear()
  projectChoices.clear()
  fanOut()
}

export function sessionSignIn(family: string): SignInChoice | undefined {
  const name = familyWord(family)
  return name === undefined ? undefined : sessionChoices.get(name)
}

let projectSource: (() => void) | undefined
let projectLoaded = false
let projectLoading = false

export function registerProjectSignInSource(source: () => void): void {
  projectSource = source
  projectLoaded = false
}

function loadProjectChoices(): void {
  if (projectLoaded || projectLoading || projectSource === undefined) return
  projectLoading = true
  try {
    projectSource()
  } catch {
    projectLoaded = true
  } finally {
    projectLoaded = true
    projectLoading = false
  }
}

export function projectChoicesLoading(): boolean {
  return projectLoading
}

export function chosenSignIn(family: string): SignInChoice | undefined {
  const name = familyWord(family)
  if (name === undefined) return undefined
  loadProjectChoices()
  return sessionChoices.get(name) ?? projectChoices.get(name)
}

export function chosenSourceKind(family: string): string | undefined {
  return chosenSignIn(family)?.kind
}

export function signInHome(family: string): string {
  const home = getAuthConfigHomeDir()
  const name = familyWord(family)
  if (name === undefined) return home
  const transient = transientHomes.get(name)
  if (transient !== undefined) return transient
  const pinned = pinnedHomes.getStore()?.get(name)
  if (pinned !== undefined) return pinned
  loadProjectChoices()
  const choice = sessionChoices.get(name) ?? projectChoices.get(name)
  if (choice === undefined || choice.dir === null) return home
  return existsSync(choice.dir) ? choice.dir : home
}

export function withPinnedSignInHome<T>(family: string, dir: string, run: () => T): T {
  const name = familyWord(family)
  if (name === undefined) return run()
  const next = new Map(pinnedHomes.getStore() ?? [])
  next.set(name, dir)
  return pinnedHomes.run(next, run)
}

export function pocketInUse(family: string): string | undefined {
  const dir = signInHome(family)
  return resolve(dir) === resolve(getAuthConfigHomeDir()) ? undefined : dir
}

export function chosenSignInStands(family: string): boolean {
  const choice = chosenSignIn(family)
  return choice === undefined || choice.dir === null || existsSync(choice.dir)
}

export function withSignInHome<T>(family: string, dir: string | null, run: () => T): T {
  const name = familyWord(family)
  if (name === undefined) return run()
  const previous = transientHomes.get(name)
  transientHomes.set(name, dir ?? getAuthConfigHomeDir())
  try {
    return run()
  } finally {
    if (previous === undefined) transientHomes.delete(name)
    else transientHomes.set(name, previous)
  }
}

export function transientSignInHome(family: string): string | undefined {
  const name = familyWord(family)
  return name === undefined ? undefined : transientHomes.get(name)
}

const peeks = new Map<string, number>()

export function peekSignInHome<T>(family: string, dir: string | null, run: () => T): T {
  const name = familyWord(family)
  if (name === undefined) return run()
  peeks.set(name, (peeks.get(name) ?? 0) + 1)
  try {
    return withSignInHome(name, dir, run)
  } finally {
    const depth = (peeks.get(name) ?? 1) - 1
    if (depth <= 0) peeks.delete(name)
    else peeks.set(name, depth)
  }
}

export function peekingSignIn(family: string): boolean {
  const name = familyWord(family)
  return name !== undefined && (peeks.get(name) ?? 0) > 0
}

export interface LandSignInInput {
  family: string
  identity: string
  kind: string
  ledgerKind: SignInKind
  homeIdentity: () => string | undefined
  write: () => void
  home?: string
  ledger?: SignInLedgerIo
  stable?: boolean
}

let lastLanding: SignInLandingReceipt | undefined

export function takeLastLanding(): SignInLandingReceipt | undefined {
  const receipt = lastLanding
  lastLanding = undefined
  return receipt
}

function landed(receipt: SignInLandingReceipt): SignInLandingReceipt {
  lastLanding = receipt
  return receipt
}

export function landSignIn(input: LandSignInInput): SignInLandingReceipt {
  const home = input.home ?? getAuthConfigHomeDir()
  const family = familyWord(input.family) ?? input.family
  const ledger: SignInLedgerIo = { home, ...(input.ledger ?? {}) }
  const defaultIdentity = withSignInHome(family, home, () => input.homeIdentity())
  const unnamed = input.stable === false
  const rows = readSignInEntries(family, ledger)
  const homeUnnamed = defaultIdentity !== undefined && rows[defaultIdentity]?.unnamed === true
  const ownPocket = rows[input.identity]?.pocket
  const existing = ownPocket !== undefined && existsSync(pocketDir(family, ownPocket, home)) ? ownPocket : undefined
  if (existing === undefined && (unnamed || homeUnnamed || defaultIdentity === undefined || defaultIdentity === input.identity)) {
    withSignInHome(family, home, input.write)
    if (defaultIdentity !== undefined && defaultIdentity !== input.identity) dropSignInEntry(family, defaultIdentity, ledger)
    recordSignInEntry(family, input.identity, input.ledgerKind, undefined, ledger, unnamed)
    setSessionSignIn(family, { identity: input.identity, dir: null, kind: input.kind })
    return landed({ landed: defaultIdentity === undefined ? 'first' : 'replaced', family, identity: input.identity, dir: null, defaultIdentity: input.identity, ...(defaultIdentity !== undefined && defaultIdentity !== input.identity ? { replaced: defaultIdentity } : {}) })
  }
  const slug = existing ?? freePocketSlug(family, input.identity, home)
  const dir = ensurePocketDir(family, slug, home)
  try {
    withSignInHome(family, dir, input.write)
  } catch (error) {
    if (existing === undefined) removePocketDir(family, slug, home)
    throw error
  }
  recordSignInEntry(family, input.identity, input.ledgerKind, slug, ledger)
  setSessionSignIn(family, { identity: input.identity, dir, kind: input.kind })
  return landed({ landed: existing === slug ? 'replaced' : 'added', family, identity: input.identity, dir, defaultIdentity })
}

export interface PocketEntry {
  identity: string
  slug: string
  dir: string
  kind: SignInKind
  at: number
}

export function pocketEntries(family: string, home: string = getAuthConfigHomeDir()): PocketEntry[] {
  const name = familyWord(family)
  if (name === undefined) return []
  const rows = readSignInEntries(name, { home })
  const present = new Set(listPocketSlugs(name, home))
  const out: PocketEntry[] = []
  for (const [identity, row] of Object.entries(rows)) {
    if (row.pocket === undefined || !present.has(row.pocket)) continue
    out.push({ identity, slug: row.pocket, dir: pocketDir(name, row.pocket, home), kind: row.kind, at: row.at })
  }
  return out.sort((a, b) => a.at - b.at || a.identity.localeCompare(b.identity))
}

export function forgetPocket(family: string, entry: Pick<PocketEntry, 'identity' | 'slug' | 'dir'>, removal: () => void, home: string = getAuthConfigHomeDir()): { removed: boolean; choiceFell: boolean; fall: ChoiceFall } {
  const name = familyWord(family) ?? family
  try {
    withSignInHome(name, entry.dir, removal)
  } catch {
    return { removed: false, choiceFell: false, fall: { session: false, project: false } }
  }
  const removed = removePocketDir(name, entry.slug, home)
  dropSignInEntry(name, entry.identity, { home })
  const fall = forgetChoicesOf(name, entry.dir)
  return { removed, choiceFell: fall.session || fall.project, fall }
}

export function landingWords(receipt: SignInLandingReceipt, familyName: string, shown = true): string {
  if (!shown) {
    if (receipt.landed === 'first') return `${familyName} sign-in stored.`
    if (receipt.landed === 'replaced') return receipt.replaced === undefined ? `${familyName} sign-in replaced (same account).` : `${familyName} sign-in replaced (another account — the one without a usable name went).`
    return `${familyName} sign-in added beside the first · this session spends the new one; the default stays as it was · the Logins screen names them · /logins use <identity> switches, /logins forget <identity> drops one.`
  }
  if (receipt.landed === 'first') return `${familyName} sign-in stored as ${receipt.identity}.`
  if (receipt.landed === 'replaced' && receipt.replaced !== undefined) return `${familyName} sign-in ${receipt.identity} replaces ${receipt.replaced} (one of the two had no usable name, so the two never sit side by side).`
  if (receipt.landed === 'replaced') return `${familyName} sign-in ${receipt.identity} replaced (same account).`
  return `${familyName} sign-in ${receipt.identity} added beside ${receipt.defaultIdentity ?? 'the default'} · this session spends ${receipt.identity}; the default stays ${receipt.defaultIdentity ?? 'as it was'} · /logins use ${receipt.defaultIdentity ?? '<identity>'} switches back · /logins forget ${receipt.identity} drops it.`
}

export function useHomeSignIn(family: string, kind: string, write?: () => void): void {
  const name = familyWord(family)
  if (name === undefined) return
  if (write !== undefined) withSignInHome(name, null, write)
  setSessionSignIn(name, { identity: `${name}:${kind}`, dir: null, kind })
}

export interface ChoiceFall {
  session: boolean
  project: boolean
}

export function forgetChoicesOf(family: string, dir: string): ChoiceFall {
  const name = familyWord(family)
  const fall: ChoiceFall = { session: false, project: false }
  if (name === undefined) return fall
  for (const [layerName, layer] of [['session', sessionChoices], ['project', projectChoices]] as const) {
    const choice = layer.get(name)
    if (choice?.dir !== null && choice?.dir !== undefined && resolve(choice.dir) === resolve(dir)) {
      layer.delete(name)
      fall[layerName] = true
    }
  }
  if (fall.session || fall.project) fanOut()
  return fall
}
