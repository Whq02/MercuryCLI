import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { durableAtomicPublishSync } from '../../../platform/substrate/durablePublish.js'
import { flagEnv } from '../../../platform/substrate/flagRegistry.js'
import { getAuthConfigHomeDir } from '../../../platform/environment/envUtils.js'
import { getUserAgent } from '../requestHeaders.js'
import { getApiFetch, getProxyFetchOptions } from '../../../platform/network/proxy.js'
import { getEssentialTrafficOnlyReason, isLoopbackUrl, isProofShapeRun, proofShapeReason } from '../privacyLevel.js'
import { passedOver, passedOverAs } from '../../../platform/errors/passedOver.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'
import { startTimeout, stopTimeout } from '../../../platform/async/timers.js'

export const NOUS_PORTAL_CLIENT_ID = 'hermes-cli'
export const NOUS_PORTAL_SIGNIN_SCOPE = 'inference:invoke'
export const NOUS_CLIENT_CONTRACT_RELEASE = '0.23.3'
export const NOUS_CLIENT_CONTRACT_AS_OF = '2026-11-22'
export const NOUS_CLIENT_SOURCE_DEFAULT_BASE = 'https://api.github.com'
export const NOUS_CLIENT_SOURCE_REPO = 'NousResearch/hermes-agent'
export const NOUS_CLIENT_SOURCE_FILE = 'hermes_cli/auth_constants.py'
export const NOUS_CLIENT_CONTRACT_FILE = '.nous-client-contract.json'
export const NOUS_CLIENT_SOURCE_DEADLINE_MS = 3_000
export const NOUS_CLIENT_PEEK_EVERY_MS = 24 * 60 * 60 * 1000

const RECORD_MAX_BYTES = 8_192
const ANSWER_MAX_BYTES = 256 * 1024
const RELEASE_SHAPE = /^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/
const CLIENT_ID_LINE = /^DEFAULT_NOUS_CLIENT_ID\s*=\s*"([A-Za-z0-9._:-]{1,128})"\s*$/m
const SCOPE_LINE = /^NOUS_INFERENCE_INVOKE_SCOPE\s*=\s*"([A-Za-z0-9._:-]{1,128}(?: [A-Za-z0-9._:-]{1,128}){0,7})"\s*$/m

export interface NousClientFacts {
  clientId: string
  scope: string
  release: string
}

export interface LearnedNousClient extends NousClientFacts {
  learnedAtMs: number
  from: string
}

export type NousClientPresented = NousClientFacts & { source: 'constant' | 'learned'; asOf: string }

export interface NousClientRecord {
  learned?: LearnedNousClient
  lastPeekAtMs?: number
  lastFailure?: { atMs: number; words: string }
}

export type NousClientSourceAnswer = { ok: true; facts: NousClientFacts; from: string } | { ok: false; words: string }

export type NousClientPeek =
  | { kind: 'read'; answer: NousClientSourceAnswer; learned: boolean }
  | { kind: 'skipped'; why: 'traffic-off' | 'today' | 'in-flight' | 'proof-shape' }

export interface NousClientIo {
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  now?: () => number
}

export function compareNousReleases(a: string, b: string): number {
  const left = a.split('.')
  const right = b.split('.')
  for (let i = 0; i < 3; i++) {
    const l = Number(left[i] ?? 0)
    const r = Number(right[i] ?? 0)
    if (l !== r) return l < r ? -1 : 1
  }
  return 0
}

export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function nousClientContractPath(): string {
  return join(getAuthConfigHomeDir(), NOUS_CLIENT_CONTRACT_FILE)
}

function isRelease(value: unknown): value is string {
  return typeof value === 'string' && RELEASE_SHAPE.test(value)
}

function isWord(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
}

function isScope(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}(?: [A-Za-z0-9._:-]{1,128}){0,7}$/.test(value)
}

function isStamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 8_640_000_000_000_000
}

function decodeLearned(value: unknown): LearnedNousClient | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  if (!isWord(row.clientId) || !isScope(row.scope) || !isRelease(row.release) || !isStamp(row.learnedAtMs)) return undefined
  const from = typeof row.from === 'string' && row.from.length > 0 && row.from.length <= 2048 ? row.from : NOUS_CLIENT_SOURCE_DEFAULT_BASE
  return { clientId: row.clientId, scope: row.scope, release: row.release, learnedAtMs: row.learnedAtMs, from }
}

export function decodeNousClientRecord(value: unknown): NousClientRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const raw = value as Record<string, unknown>
  const record: NousClientRecord = {}
  const learned = decodeLearned(raw.learned)
  if (learned !== undefined) record.learned = learned
  if (isStamp(raw.lastPeekAtMs)) record.lastPeekAtMs = raw.lastPeekAtMs
  const failure = raw.lastFailure
  if (typeof failure === 'object' && failure !== null) {
    const f = failure as Record<string, unknown>
    if (isStamp(f.atMs) && typeof f.words === 'string' && f.words.length > 0 && f.words.length <= 256) record.lastFailure = { atMs: f.atMs, words: f.words }
  }
  return record
}

function readNousClientRecordState(): { state: 'ok'; record: NousClientRecord } | { state: 'unreadable'; error: unknown } {
  const path = nousClientContractPath()
  let raw: string
  try {
    if (statSync(path).size > RECORD_MAX_BYTES) return { state: 'ok', record: {} }
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'ok', record: {} }
    return { state: 'unreadable', error }
  }
  try {
    return { state: 'ok', record: decodeNousClientRecord(JSON.parse(raw)) }
  } catch (error) {
    passedOver(error)
    return { state: 'ok', record: {} }
  }
}

export function readNousClientRecord(): NousClientRecord {
  const read = readNousClientRecordState()
  if (read.state === 'unreadable') {
    passedOver(read.error)
    return {}
  }
  return read.record
}

function writeNousClientRecord(next: NousClientRecord): void {
  mkdirSync(getAuthConfigHomeDir(), { recursive: true })
  durableAtomicPublishSync(nousClientContractPath(), JSON.stringify({ ...next, version: 1 }) + '\n', { mode: 0o600 })
}

export function learnedNousClient(): LearnedNousClient | null {
  return readNousClientRecord().learned ?? null
}

export function presentedNousClient(): NousClientPresented {
  const learned = learnedNousClient()
  if (learned !== null && compareNousReleases(learned.release, NOUS_CLIENT_CONTRACT_RELEASE) > 0) {
    return { clientId: learned.clientId, scope: learned.scope, release: learned.release, source: 'learned', asOf: isoDay(learned.learnedAtMs) }
  }
  return { clientId: NOUS_PORTAL_CLIENT_ID, scope: NOUS_PORTAL_SIGNIN_SCOPE, release: NOUS_CLIENT_CONTRACT_RELEASE, source: 'constant', asOf: NOUS_CLIENT_CONTRACT_AS_OF }
}

export function nousClientSourceBase(env: NodeJS.ProcessEnv = hostEnv()): string {
  const pinned = (env === hostEnv() ? flagEnv('MERCURY_NOUS_CLIENT_SOURCE_BASE') : flagEnv('MERCURY_NOUS_CLIENT_SOURCE_BASE', env))?.trim()
  return pinned && /^https?:\/\//i.test(pinned) ? pinned.replace(/\/+$/, '') : NOUS_CLIENT_SOURCE_DEFAULT_BASE
}

export function nousClientReleaseUrl(env: NodeJS.ProcessEnv = hostEnv()): string {
  return `${nousClientSourceBase(env)}/repos/${NOUS_CLIENT_SOURCE_REPO}/releases/latest`
}

export function nousClientSourceUrl(tag: string, env: NodeJS.ProcessEnv = hostEnv()): string {
  return `${nousClientSourceBase(env)}/repos/${NOUS_CLIENT_SOURCE_REPO}/contents/${NOUS_CLIENT_SOURCE_FILE}?ref=${encodeURIComponent(tag)}`
}

export function decodeNousClientFacts(text: string, release: string): NousClientFacts | undefined {
  const clientId = CLIENT_ID_LINE.exec(text)?.[1]
  const scope = SCOPE_LINE.exec(text)?.[1]
  if (clientId === undefined || scope === undefined || !isRelease(release)) return undefined
  return { clientId, scope, release }
}

export function releaseOfTag(tag: unknown): string | undefined {
  if (typeof tag !== 'string') return undefined
  const bare = tag.replace(/^v/, '')
  return isRelease(bare) ? bare : undefined
}

async function boundedText(response: Response): Promise<string | null> {
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.byteLength
    if (size > ANSWER_MAX_BYTES) {
      await reader.cancel().catch(passedOverAs(undefined))
      return null
    }
    chunks.push(next.value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readSource(url: string, accept: string, io: NousClientIo | undefined, signal: AbortSignal): Promise<{ ok: true; text: string } | { ok: false; words: string }> {
  const fetchImpl = io?.fetchImpl ?? getApiFetch()
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept, 'user-agent': getUserAgent() },
      redirect: 'follow',
      signal,
      ...(io?.fetchImpl ? {} : getProxyFetchOptions()),
    } as RequestInit)
  } catch (error) {
    if (signal.aborted) return { ok: false, words: `timeout after ${NOUS_CLIENT_SOURCE_DEADLINE_MS / 1000} s` }
    const code = (error as { code?: unknown; cause?: { code?: unknown } })?.cause?.code ?? (error as { code?: unknown })?.code
    return { ok: false, words: typeof code === 'string' ? `no network (${code})` : 'no network' }
  }
  if (!response.ok) {
    await response.body?.cancel().catch(passedOverAs(undefined))
    return { ok: false, words: `HTTP ${response.status}` }
  }
  const text = await boundedText(response)
  if (text === null) return { ok: false, words: `the answer ran past ${ANSWER_MAX_BYTES / 1024} KiB` }
  return { ok: true, text }
}

export async function readNousClientFromSource(io?: NousClientIo): Promise<NousClientSourceAnswer> {
  const env = io?.env ?? hostEnv()
  if (isProofShapeRun() && !isLoopbackUrl(nousClientSourceBase(env))) return { ok: false, words: proofShapeReason() }
  const controller = new AbortController()
  const timer = startTimeout(() => controller.abort(), NOUS_CLIENT_SOURCE_DEADLINE_MS)
  timer.unref?.()
  try {
    const release = await readSource(nousClientReleaseUrl(env), 'application/vnd.github+json', io, controller.signal)
    if (!release.ok) return { ok: false, words: `the release list: ${release.words}` }
    let tag: unknown
    try {
      tag = (JSON.parse(release.text) as { tag_name?: unknown }).tag_name
    } catch {
      return { ok: false, words: 'the release list was not JSON' }
    }
    const version = releaseOfTag(tag)
    if (version === undefined) return { ok: false, words: 'the release list named no three-part release' }
    const source = await readSource(nousClientSourceUrl(String(tag), env), 'application/vnd.github.raw+json', io, controller.signal)
    if (!source.ok) return { ok: false, words: `the release's source: ${source.words}` }
    const facts = decodeNousClientFacts(source.text, version)
    if (facts === undefined) return { ok: false, words: `the release's source named no client id or scope` }
    return { ok: true, facts, from: nousClientSourceUrl(String(tag), env) }
  } finally {
    stopTimeout(timer)
  }
}

let peekInFlight: Promise<NousClientPeek> | null = null

export function peekNousClient(io?: NousClientIo & { force?: boolean }): Promise<NousClientPeek> {
  if (peekInFlight) return peekInFlight
  const env = io?.env ?? hostEnv()
  const now = io?.now ?? Date.now
  if (getEssentialTrafficOnlyReason(env) !== null) return Promise.resolve({ kind: 'skipped', why: 'traffic-off' })
  if (isProofShapeRun() && !isLoopbackUrl(nousClientSourceBase(env))) return Promise.resolve({ kind: 'skipped', why: 'proof-shape' })
  const before = readNousClientRecord()
  const at = now()
  if (!io?.force && before.lastPeekAtMs !== undefined && at - before.lastPeekAtMs >= 0 && at - before.lastPeekAtMs < NOUS_CLIENT_PEEK_EVERY_MS) {
    return Promise.resolve({ kind: 'skipped', why: 'today' })
  }
  const work = (async (): Promise<NousClientPeek> => {
    const answer = await readNousClientFromSource(io)
    const read = readNousClientRecordState()
    if (read.state === 'unreadable') {
      passedOver(read.error)
      return { kind: 'read', answer, learned: false }
    }
    const fresh = read.record
    if (!answer.ok) {
      try { writeNousClientRecord({ ...fresh, lastFailure: { atMs: now(), words: answer.words.slice(0, 256) } }) } catch (error) { passedOver(error) }
      return { kind: 'read', answer, learned: false }
    }
    const newest = compareNousReleases(answer.facts.release, fresh.learned?.release ?? NOUS_CLIENT_CONTRACT_RELEASE) > 0
    const next: NousClientRecord = { ...fresh, lastPeekAtMs: now() }
    delete next.lastFailure
    if (newest) next.learned = { ...answer.facts, learnedAtMs: now(), from: answer.from }
    let persisted = false
    try {
      writeNousClientRecord(next)
      persisted = true
    } catch (error) {
      passedOver(error)
    }
    return { kind: 'read', answer, learned: newest && persisted }
  })().finally(() => {
    peekInFlight = null
  })
  peekInFlight = work
  return work
}

export function nousClientContractWords(presented: NousClientPresented = presentedNousClient()): string {
  const record = readNousClientRecord()
  const parts = [`the sign-in presents the Portal client ${presented.clientId} (scope ${presented.scope}) as of release ${presented.release} (${presented.source}, ${presented.asOf})`]
  if (record.lastFailure !== undefined) parts.push(`the last release read failed ${isoDay(record.lastFailure.atMs)}: ${record.lastFailure.words}`)
  return parts.join(' · ')
}
