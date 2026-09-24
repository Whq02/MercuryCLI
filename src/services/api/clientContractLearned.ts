import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { defineStore, StoreLockLostError } from '../../substrate/fileStore.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { logForDebugging } from '../../utils/debug.js'
import { getAuthConfigHomeDir } from '../../utils/envUtils.js'
import { isFirstPartyAnthropicBaseUrl } from '../../utils/model/providers.js'
import { getEssentialTrafficOnlyReason } from '../../utils/privacyLevel.js'
import { sleep } from '../../utils/sleep.js'
import { getMercuryUserAgent } from '../../utils/userAgent.js'

export const CLIENT_CONTRACT_RECORD_FILE = 'client-contract.json'
export const NPM_REGISTRY_DEFAULT_BASE = 'https://registry.npmjs.org'
export const CLIENT_CONTRACT_REGISTRY_PATH = '/@anthropic-ai/claude-code/latest'
export const REGISTRY_READ_DEADLINE_MS = 3_000
export const REGISTRY_QUIET_WINDOW_MS = 10 * 60 * 1000
export const CLIENT_CONTRACT_PEEK_EVERY_MS = 24 * 60 * 60 * 1000

const RECORD_MAX_BYTES = 16_384
const ANSWER_MAX_BYTES = 256 * 1024
const LATEST_STAMP_MS = 8_640_000_000_000_000
const PEER_WAIT_MS = REGISTRY_READ_DEADLINE_MS + 2_000
const PEER_POLL_MS = 100
const STABLE_VERSION = /^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/
const WIRE_VERSION = /(\d+\.\d+\.\d+) does not support this model/
const LINE_VERSION = /cc_version=(\d+\.\d+\.\d+)\./
const LOCK_LOST = 'the record lock was lost'

export type ClientContractSource = 'constant' | 'learned' | 'override'
export type ClientContractPresented = { presented: string; source: ClientContractSource }
export type ClientContractActor = 'heal' | 'peek'
export type RegistryFailure = { kind: 'timeout' | 'status' | 'shape' | 'network'; words: string }
export type RegistryAnswer = { ok: true; version: string } | { ok: false; failure: RegistryFailure }

export type LearnedClientContract = {
  version: string
  learnedAtMs: number
  from: string
  by: ClientContractActor
}

export type ClientContractRead = {
  atMs: number
  by: ClientContractActor
  from: string
  answer?: { version: string } | { failure: RegistryFailure }
}

export type ClientContractRecord = {
  learned?: LearnedClientContract
  lastRead?: ClientContractRead
  lastPeekAtMs?: number
}

export type ClientContractHeal =
  | { kind: 'override'; sent: ClientContractPresented }
  | { kind: 'retry'; sent: ClientContractPresented; to: string; via: 'registry' | 'stored' | 'peer'; unsaved?: string }
  | { kind: 'not-newer'; sent: ClientContractPresented; said: string }
  | { kind: 'failed'; sent: ClientContractPresented; failure: RegistryFailure }
  | { kind: 'windowed'; sent: ClientContractPresented; last: ClientContractRead }
  | { kind: 'unclaimed'; sent: ClientContractPresented; why: string }
  | { kind: 'off'; sent: ClientContractPresented; why: string }

export type ClientContractPeekSkip = 'override' | 'traffic-off' | 'no-credential' | 'lane' | 'today' | 'window' | 'unclaimed' | 'error'

export type ClientContractPeek =
  | { kind: 'read'; answer: RegistryAnswer; learned: boolean; unsaved?: string }
  | { kind: 'skipped'; why: ClientContractPeekSkip; adopted?: string }

type ClaimVerdict =
  | { kind: 'claimed'; claim: ClientContractRead; previous: ClientContractRead | undefined }
  | { kind: 'today' }
  | { kind: 'windowed'; last: ClientContractRead }
  | { kind: 'unclaimed'; why: string }

export function compareClientContractVersions(a: string, b: string): number {
  const left = a.split('.')
  const right = b.split('.')
  for (let i = 0; i < 3; i++) {
    const l = Number(left[i] ?? 0)
    const r = Number(right[i] ?? 0)
    if (l !== r) return l < r ? -1 : 1
  }
  return 0
}

function isNewer(a: string, b: string): boolean {
  return compareClientContractVersions(a, b) > 0
}

function newestOf(versions: ReadonlyArray<string | undefined>): string {
  let newest = '0.0.0'
  for (const version of versions) if (version !== undefined && isNewer(version, newest)) newest = version
  return newest
}

export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function isStableVersion(value: unknown): value is string {
  return typeof value === 'string' && STABLE_VERSION.test(value)
}

function isStamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < LATEST_STAMP_MS
}

function boundedText(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined
}

function isFailureKind(value: unknown): value is RegistryFailure['kind'] {
  return value === 'timeout' || value === 'status' || value === 'shape' || value === 'network'
}

function isActor(value: unknown): value is ClientContractActor {
  return value === 'heal' || value === 'peek'
}

function parseFailure(value: unknown): RegistryFailure | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as { kind?: unknown; words?: unknown }
  const words = boundedText(row.words, 256)
  if (words === undefined || !isFailureKind(row.kind)) return undefined
  return { kind: row.kind, words }
}

function parseLearned(value: unknown): LearnedClientContract | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as { version?: unknown; learnedAtMs?: unknown; from?: unknown; by?: unknown }
  if (!isStableVersion(row.version) || !isStamp(row.learnedAtMs)) return undefined
  return {
    version: row.version,
    learnedAtMs: row.learnedAtMs,
    from: boundedText(row.from, 2048) ?? NPM_REGISTRY_DEFAULT_BASE,
    by: row.by === 'peek' ? 'peek' : 'heal',
  }
}

function parseRead(value: unknown): ClientContractRead | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as { atMs?: unknown; by?: unknown; from?: unknown; answer?: unknown }
  if (!isStamp(row.atMs) || !isActor(row.by)) return undefined
  const read: ClientContractRead = { atMs: row.atMs, by: row.by, from: boundedText(row.from, 2048) ?? NPM_REGISTRY_DEFAULT_BASE }
  if (typeof row.answer === 'object' && row.answer !== null) {
    const answer = row.answer as { version?: unknown; failure?: unknown }
    const failure = parseFailure(answer.failure)
    if (isStableVersion(answer.version)) read.answer = { version: answer.version }
    else if (failure !== undefined) read.answer = { failure }
  }
  return read
}

function decodeRecord(value: unknown): ClientContractRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as { learned?: unknown; lastRead?: unknown; lastPeekAtMs?: unknown }
  const record: ClientContractRecord = {}
  const learned = parseLearned(raw.learned)
  if (learned !== undefined) record.learned = learned
  const lastRead = parseRead(raw.lastRead)
  if (lastRead !== undefined) record.lastRead = lastRead
  if (isStamp(raw.lastPeekAtMs)) record.lastPeekAtMs = raw.lastPeekAtMs
  return record
}

export function clientContractRecordPath(home: string = getAuthConfigHomeDir()): string {
  return join(home, CLIENT_CONTRACT_RECORD_FILE)
}

const clientContractStore = defineStore<ClientContractRecord, [home: string]>({
  name: 'client-contract',
  path: home => clientContractRecordPath(home),
  schemaVersion: 1,
  decode: raw => decodeRecord(raw),
  empty: () => ({}),
  onReadFailure: 'empty',
})

async function storedRecord(home: string): Promise<ClientContractRecord> {
  try {
    return await clientContractStore(home).read()
  } catch {
    return {}
  }
}

function learnedOnDisk(home: string): LearnedClientContract | null {
  const path = clientContractRecordPath(home)
  try {
    if (statSync(path).size > RECORD_MAX_BYTES) return null
    return decodeRecord(JSON.parse(readFileSync(path, 'utf8')))?.learned ?? null
  } catch {
    return null
  }
}

function recordFailureCode(error: unknown): string {
  if (error instanceof StoreLockLostError) return LOCK_LOST
  const record = error as { fsCode?: unknown; code?: unknown } | null
  const code = record?.fsCode ?? record?.code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? code : 'EIO'
}

function claimRefusal(error: unknown): string {
  const code = recordFailureCode(error)
  if (code === LOCK_LOST) return `${LOCK_LOST} before the claim was saved`
  if (code === 'ELOCKED') return 'another Mercury held the record lock'
  const path = (error as { path?: unknown } | null)?.path
  return typeof path === 'string' && path.endsWith('.lock')
    ? `the config home refused the record lock (${code})`
    : `the config home refused its record (${code})`
}

const presentedByHome = new Map<string, LearnedClientContract | null>()
const readsThisProcess = new Map<string, ClientContractRead>()
const readsInFlight = new Map<string, Promise<void>>()
const troubleByHome = new Map<string, string>()

function presentedFor(home: string): LearnedClientContract | null {
  if (!presentedByHome.has(home)) presentedByHome.set(home, learnedOnDisk(home))
  return presentedByHome.get(home) ?? null
}

export function learnedClientContract(): LearnedClientContract | null {
  return presentedFor(getAuthConfigHomeDir())
}

function raisePresented(home: string, learned: LearnedClientContract): boolean {
  const current = presentedFor(home)
  if (current !== null && !isNewer(learned.version, current.version)) return false
  presentedByHome.set(home, learned)
  return true
}

function noteTrouble(home: string, clause: string | null): void {
  if (clause === null) troubleByHome.delete(home)
  else troubleByHome.set(home, clause)
}

function latestRead(home: string, stored: ClientContractRead | undefined): ClientContractRead | undefined {
  const local = readsThisProcess.get(home)
  if (local === undefined) return stored
  if (stored === undefined) return local
  return local.atMs >= stored.atMs ? local : stored
}

function withinQuietWindow(atMs: number, nowMs: number): boolean {
  return Math.abs(nowMs - atMs) < REGISTRY_QUIET_WINDOW_MS
}

function peekedWithinDay(record: ClientContractRecord, at: number): boolean {
  const since = record.lastPeekAtMs === undefined ? undefined : at - record.lastPeekAtMs
  return since !== undefined && since >= 0 && since < CLIENT_CONTRACT_PEEK_EVERY_MS
}

function namedRegistryBase(): string | undefined {
  const pinned = flagEnv('MERCURY_NPM_REGISTRY_BASE')?.trim()
  return pinned && /^https?:\/\//i.test(pinned) ? pinned.replace(/\/+$/, '') : undefined
}

export function npmRegistryBase(): string {
  return namedRegistryBase() ?? NPM_REGISTRY_DEFAULT_BASE
}

export function clientContractRegistryUrl(): string {
  return `${npmRegistryBase()}${CLIENT_CONTRACT_REGISTRY_PATH}`
}

function registrySource(): string {
  try {
    const url = new URL(clientContractRegistryUrl())
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return NPM_REGISTRY_DEFAULT_BASE
  }
}

function shapeFailure(words: string): RegistryAnswer {
  return { ok: false, failure: { kind: 'shape', words } }
}

function networkCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth++) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_]{1,40}$/.test(code)) return code
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

async function readAnswerText(response: Response): Promise<string | null> {
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.byteLength
    if (size > ANSWER_MAX_BYTES) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(next.value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function readClientContractFromRegistry(signal?: AbortSignal): Promise<RegistryAnswer> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, REGISTRY_READ_DEADLINE_MS)
  timer.unref?.()
  const cancel = (): void => controller.abort()
  if (signal?.aborted === true) controller.abort()
  else signal?.addEventListener('abort', cancel, { once: true })
  try {
    const { getApiFetch, getProxyFetchOptions } = require('../../utils/proxy.js') as typeof import('../../utils/proxy.js')
    const response = await getApiFetch()(clientContractRegistryUrl(), {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': getMercuryUserAgent() },
      redirect: 'follow',
      signal: controller.signal,
      ...getProxyFetchOptions(),
    } as RequestInit)
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return { ok: false, failure: { kind: 'status', words: `HTTP ${response.status}` } }
    }
    const text = await readAnswerText(response)
    if (text === null) return shapeFailure(`the answer ran past ${ANSWER_MAX_BYTES / 1024} KiB`)
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return shapeFailure('the answer was not JSON')
    }
    const version = typeof body === 'object' && body !== null ? (body as { version?: unknown }).version : undefined
    if (version === undefined || version === null) return shapeFailure('the answer carried no version')
    if (!isStableVersion(version)) return shapeFailure('the answer carried no stable three-part version')
    return { ok: true, version }
  } catch (error) {
    if (timedOut) return { ok: false, failure: { kind: 'timeout', words: `timeout after ${REGISTRY_READ_DEADLINE_MS / 1000} s` } }
    if (signal?.aborted === true) return { ok: false, failure: { kind: 'network', words: 'the read was cancelled' } }
    const code = networkCode(error)
    return { ok: false, failure: { kind: 'network', words: code === undefined ? 'no network' : `no network (${code})` } }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
}

function presentedNow(): ClientContractPresented & { constant: string } {
  const oauth = require('../../constants/oauth.js') as typeof import('../../constants/oauth.js')
  const contract = oauth.describeAnthropicClientContract()
  return { presented: contract.presented, source: contract.source, constant: oauth.ANTHROPIC_CLIENT_CONTRACT_VERSION }
}

function hasAnthropicCredential(): boolean {
  try {
    const { hasFirstPartyCredential } = require('../../utils/auth.js') as typeof import('../../utils/auth.js')
    return hasFirstPartyCredential()
  } catch {
    return false
  }
}

function peekLaneOpen(): boolean {
  if (namedRegistryBase() !== undefined) return true
  if (flagEnv('MERCURY_SCRIPTED_STREAM')) return false
  return isFirstPartyAnthropicBaseUrl()
}

function answerOf(answer: RegistryAnswer): { version: string } | { failure: RegistryFailure } {
  return answer.ok ? { version: answer.version } : { failure: answer.failure }
}

function refusalText(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string' ? message : ''
}

async function claimRead(home: string, by: ClientContractActor, clock: () => number): Promise<ClaimVerdict> {
  try {
    const verdict = await clientContractStore(home).update<ClaimVerdict>(current => {
      const at = clock()
      if (by === 'peek' && peekedWithinDay(current, at)) return { next: current, result: { kind: 'today' } }
      const last = latestRead(home, current.lastRead)
      if (last !== undefined && withinQuietWindow(last.atMs, at)) return { next: current, result: { kind: 'windowed', last } }
      const claim: ClientContractRead = { atMs: at, by, from: registrySource() }
      return { next: { ...current, lastRead: claim }, result: { kind: 'claimed', claim, previous: current.lastRead } }
    })
    if (verdict.kind === 'claimed') readsThisProcess.set(home, verdict.claim)
    return verdict
  } catch (error) {
    const why = claimRefusal(error)
    logForDebugging(`client contract: the registry read was not claimed (${why})`, { level: 'warn' })
    return { kind: 'unclaimed', why }
  }
}

async function settleRecord(home: string, next: (fresh: ClientContractRecord) => ClientContractRecord): Promise<string | null> {
  let refused: string | null = null
  try {
    await clientContractStore(home).mutate(next)
  } catch (error) {
    refused = recordFailureCode(error)
    logForDebugging(`client contract: the record could not be saved (${refused})`, { level: 'warn' })
  }
  noteTrouble(home, refused === null ? null : `the last registry answer was not saved to the config home (${refused})`)
  return refused
}

async function releaseClaim(home: string, claim: ClientContractRead, previous: ClientContractRead | undefined): Promise<void> {
  const local = readsThisProcess.get(home)
  if (local !== undefined && local.atMs === claim.atMs && local.by === claim.by) {
    if (previous === undefined) readsThisProcess.delete(home)
    else readsThisProcess.set(home, previous)
  }
  await settleRecord(home, fresh => (fresh.lastRead?.atMs === claim.atMs && fresh.lastRead.by === claim.by ? { ...fresh, lastRead: previous } : fresh))
}

function beginRead(home: string): () => void {
  let settle: () => void = () => undefined
  const flight = new Promise<void>(resolve => {
    settle = resolve
  })
  readsInFlight.set(home, flight)
  return () => {
    if (readsInFlight.get(home) === flight) readsInFlight.delete(home)
    settle()
  }
}

async function awaitPeerAnswer(home: string, claim: ClientContractRead, signal?: AbortSignal): Promise<ClientContractRead> {
  let last = claim
  if (last.answer !== undefined || Date.now() - claim.atMs >= PEER_WAIT_MS) return last
  for (let polls = 0; polls < PEER_WAIT_MS / PEER_POLL_MS && last.answer === undefined && signal?.aborted !== true; polls++) {
    await sleep(PEER_POLL_MS, signal)
    const read = (await storedRecord(home)).lastRead
    if (read !== undefined && read.atMs >= claim.atMs) last = read
  }
  return last
}

async function adoptKnown(home: string, sent: ClientContractPresented): Promise<string | null> {
  const stored = (await storedRecord(home)).learned
  if (stored !== undefined) raisePresented(home, stored)
  const now = presentedNow()
  return now.source !== 'override' && isNewer(now.presented, sent.presented) ? now.presented : null
}

async function adoptStored(home: string): Promise<{ adopted?: string }> {
  const stored = (await storedRecord(home)).learned
  if (stored === undefined || !raisePresented(home, stored)) return {}
  return presentedNow().presented === stored.version ? { adopted: stored.version } : {}
}

export async function healClientContractRefusal(
  error: unknown,
  signal?: AbortSignal,
  clock: () => number = Date.now,
): Promise<ClientContractHeal> {
  const now = presentedNow()
  if (now.source === 'override') return { kind: 'override', sent: { presented: now.presented, source: 'override' } }
  const echoed = WIRE_VERSION.exec(refusalText(error))?.[1]
  const sent: ClientContractPresented =
    echoed !== undefined && echoed !== now.presented
      ? { presented: echoed, source: echoed === now.constant ? 'constant' : 'learned' }
      : { presented: now.presented, source: now.source }
  const home = getAuthConfigHomeDir()
  const peer = readsInFlight.get(home)
  if (peer !== undefined) await peer
  const known = await adoptKnown(home, sent)
  if (known !== null) return { kind: 'retry', sent, to: known, via: 'stored' }
  const off = getEssentialTrafficOnlyReason()
  if (off !== null) return { kind: 'off', sent, why: off }
  const verdict = await claimRead(home, 'heal', clock)
  if (verdict.kind === 'windowed') {
    const last = await awaitPeerAnswer(home, verdict.last, signal)
    const late = await adoptKnown(home, sent)
    if (late !== null) return { kind: 'retry', sent, to: late, via: 'peer' }
    return { kind: 'windowed', sent, last }
  }
  if (verdict.kind !== 'claimed') {
    const why = verdict.kind === 'unclaimed' ? verdict.why : 'the daily peek holds the read'
    noteTrouble(home, `the heal could not claim its registry read: ${why}`)
    return { kind: 'unclaimed', sent, why }
  }
  noteTrouble(home, null)
  const done = beginRead(home)
  try {
    const answer = await readClientContractFromRegistry(signal)
    if (signal?.aborted === true) {
      await releaseClaim(home, verdict.claim, verdict.previous)
      return { kind: 'failed', sent, failure: { kind: 'network', words: 'the read was cancelled' } }
    }
    const read: ClientContractRead = { ...verdict.claim, answer: answerOf(answer) }
    readsThisProcess.set(home, read)
    if (!answer.ok) {
      await settleRecord(home, fresh => ({ ...fresh, lastRead: read }))
      return { kind: 'failed', sent, failure: answer.failure }
    }
    if (!isNewer(answer.version, sent.presented)) {
      await settleRecord(home, fresh => ({ ...fresh, lastRead: read }))
      return { kind: 'not-newer', sent, said: answer.version }
    }
    const holder: { learned: LearnedClientContract } = {
      learned: { version: answer.version, learnedAtMs: clock(), from: verdict.claim.from, by: 'heal' },
    }
    raisePresented(home, holder.learned)
    const refused = await settleRecord(home, fresh => {
      if (fresh.learned !== undefined && !isNewer(holder.learned.version, fresh.learned.version)) holder.learned = fresh.learned
      return { ...fresh, learned: holder.learned, lastRead: read }
    })
    raisePresented(home, holder.learned)
    const to = presentedNow().presented
    return { kind: 'retry', sent, to, via: 'registry', ...(refused !== null ? { unsaved: refused } : {}) }
  } finally {
    done()
  }
}

export async function peekClientContract(clock: () => number = Date.now): Promise<ClientContractPeek> {
  try {
    const now = presentedNow()
    if (now.source === 'override') return { kind: 'skipped', why: 'override' }
    if (getEssentialTrafficOnlyReason() !== null) return { kind: 'skipped', why: 'traffic-off' }
    if (!hasAnthropicCredential()) return { kind: 'skipped', why: 'no-credential' }
    if (!peekLaneOpen()) return { kind: 'skipped', why: 'lane' }
    const home = getAuthConfigHomeDir()
    const at = clock()
    if (peekedWithinDay(await storedRecord(home), at)) return { kind: 'skipped', why: 'today', ...(await adoptStored(home)) }
    const peer = readsInFlight.get(home)
    if (peer !== undefined) {
      await peer
      return { kind: 'skipped', why: 'window', ...(await adoptStored(home)) }
    }
    const verdict = await claimRead(home, 'peek', clock)
    if (verdict.kind === 'today') return { kind: 'skipped', why: 'today', ...(await adoptStored(home)) }
    if (verdict.kind === 'windowed') {
      await awaitPeerAnswer(home, verdict.last)
      return { kind: 'skipped', why: 'window', ...(await adoptStored(home)) }
    }
    if (verdict.kind === 'unclaimed') {
      noteTrouble(home, `the daily peek could not claim its registry read: ${verdict.why}`)
      return { kind: 'skipped', why: 'unclaimed' }
    }
    noteTrouble(home, null)
    const done = beginRead(home)
    try {
      const answer = await readClientContractFromRegistry()
      const read: ClientContractRead = { ...verdict.claim, answer: answerOf(answer) }
      readsThisProcess.set(home, read)
      const answered: LearnedClientContract | undefined =
        answer.ok && isNewer(answer.version, newestOf([now.constant, presentedFor(home)?.version]))
          ? { version: answer.version, learnedAtMs: clock(), from: verdict.claim.from, by: 'peek' }
          : undefined
      const learned = answered !== undefined && raisePresented(home, answered)
      const refused = await settleRecord(home, fresh => ({
        ...fresh,
        lastRead: read,
        ...(answered !== undefined && (fresh.learned === undefined || isNewer(answered.version, fresh.learned.version)) ? { learned: answered } : {}),
        ...(answer.ok ? { lastPeekAtMs: read.atMs } : {}),
      }))
      return { kind: 'read', answer, learned, ...(refused !== null ? { unsaved: refused } : {}) }
    } finally {
      done()
    }
  } catch (error) {
    logForDebugging(`client contract: the daily peek stopped (${String(error)})`, { level: 'warn' })
    return { kind: 'skipped', why: 'error' }
  }
}

let bootPeek: Promise<ClientContractPeek> | null = null

export function startClientContractPeek(): Promise<ClientContractPeek> {
  if (bootPeek === null) {
    bootPeek = new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 0)
      timer.unref?.()
    }).then(() => peekClientContract())
  }
  return bootPeek
}

export function pendingClientContractPeek(): Promise<ClientContractPeek> | null {
  return bootPeek
}

const heals = new WeakMap<object, ClientContractHeal>()

export function noteClientContractHeal(error: unknown, heal: ClientContractHeal): void {
  if (typeof error === 'object' && error !== null) heals.set(error, heal)
}

export function clientContractHealOf(error: unknown): ClientContractHeal | undefined {
  return typeof error === 'object' && error !== null ? heals.get(error) : undefined
}

function presentedWords(sent: ClientContractPresented): string {
  return `${sent.presented} (${sent.source})`
}

function windowedWords(last: ClientContractRead, sent: ClientContractPresented): string {
  const when = `under ${REGISTRY_QUIET_WINDOW_MS / 60_000} min ago`
  const answer = last.answer
  if (answer === undefined) return `a registry read began ${when} and has not answered`
  if ('failure' in answer) return `the last registry read, ${when}, failed: ${answer.failure.words}`
  if (isNewer(answer.version, sent.presented)) return `the last registry read, ${when}, said ${answer.version}`
  return `the last registry read, ${when}, said ${answer.version}, not newer than the presented ${sent.presented}`
}

export function clientContractStory(heal: ClientContractHeal): string {
  const presents = `Mercury presents ${presentedWords(heal.sent)}`
  if (heal.kind === 'override') return presents
  if (heal.kind === 'retry') {
    const learned =
      heal.via === 'registry'
        ? `the registry said ${heal.to}${heal.unsaved !== undefined ? `, not saved to the config home (${heal.unsaved})` : ''}`
        : heal.via === 'peer'
          ? `another session's registry read said ${heal.to}`
          : `the config home held the learned ${heal.to}`
    return `Mercury presented ${presentedWords(heal.sent)} — ${learned}; retried once — still refused`
  }
  if (heal.kind === 'not-newer') return `${presents} — the registry said ${heal.said}, not newer than the presented ${heal.sent.presented} — not retried`
  if (heal.kind === 'failed') return `${presents} — the registry read failed: ${heal.failure.words} — not retried`
  if (heal.kind === 'windowed') return `${presents} — ${windowedWords(heal.last, heal.sent)} — not retried`
  if (heal.kind === 'unclaimed') return `${presents} — the registry read was not attempted: ${heal.why} — not retried`
  return `${presents} — the registry read is off (${heal.why}) — not retried`
}

export function clientContractMoveOf(mismatch: { path?: string; before?: string; after?: string } | null | undefined): string | null {
  if (mismatch === null || mismatch === undefined) return null
  if (mismatch.path === undefined || !mismatch.path.startsWith('system[0]')) return null
  const before = mismatch.before
  const after = mismatch.after
  if (before === undefined || after === undefined) return null
  const was = LINE_VERSION.exec(before)?.[1]
  const now = LINE_VERSION.exec(after)?.[1]
  if (was === undefined || now === undefined || was === now) return null
  if (before.replace(LINE_VERSION, '') !== after.replace(LINE_VERSION, '')) return null
  return `the client-contract number the door presents moved from ${was} to ${now}`
}

export async function clientContractRecordWords(
  contract: ClientContractPresented,
  ageOf: (ms: number) => string,
  nowMs: number = Date.now(),
): Promise<string> {
  const home = getAuthConfigHomeDir()
  const record = await storedRecord(home)
  const clauses: string[] = []
  const stored = record.learned
  if (contract.source !== 'override' && stored !== undefined && isNewer(stored.version, contract.presented)) {
    clauses.push(`the config home holds ${stored.version} (learned ${isoDay(stored.learnedAtMs)}), presented from the next start or the next too-old refusal`)
  }
  const last = latestRead(home, record.lastRead)
  if (last !== undefined) {
    const who = last.by === 'peek' ? 'the daily peek' : 'the heal'
    const age = ageOf(nowMs - last.atMs)
    if (last.answer === undefined) clauses.push(`${who}'s registry read began ${age} and has no answer on record`)
    else if ('failure' in last.answer) clauses.push(`${who}'s last registry read failed ${age}: ${last.answer.failure.words}`)
  }
  const trouble = troubleByHome.get(home)
  if (trouble !== undefined) clauses.push(trouble)
  return clauses.map(clause => ` · ${clause}`).join('')
}
