import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { durableAtomicPublishSync } from '../../../substrate/durablePublish.js'
import { flagEnv } from '../../../substrate/flagRegistry.js'
import { getAuthConfigHomeDir } from '../../../utils/envUtils.js'
import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getEssentialTrafficOnlyReason, isLoopbackUrl, isProofShapeRun, proofShapeReason } from '../../../utils/privacyLevel.js'

export const ANTIGRAVITY_OAUTH_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'
export const ANTIGRAVITY_OAUTH_CLIENT_SECRET = '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'
export const ANTIGRAVITY_OAUTH_SCOPE = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
].join(' ')
export const ANTIGRAVITY_CLIENT_CONTRACT_VERSION = '2.28.2'
export const ANTIGRAVITY_CLIENT_CONTRACT_CHANGELIST = '963137146'
export const ANTIGRAVITY_CLIENT_CONTRACT_AS_OF = '2026-10-30'
export const ANTIGRAVITY_CLIENT_OS = 'darwin'
export const ANTIGRAVITY_CLIENT_ARCH = 'arm64'
export const ANTIGRAVITY_MANIFEST_DEFAULT_BASE = 'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app'
export const ANTIGRAVITY_MANIFEST_PATH = '/manifest/latest-arm64-mac.yml'
export const ANTIGRAVITY_CLIENT_CONTRACT_FILE = '.antigravity-client-contract.json'
export const ANTIGRAVITY_MANIFEST_DEADLINE_MS = 5_000
export const ANTIGRAVITY_CLIENT_PEEK_EVERY_MS = 24 * 60 * 60 * 1000

const RECORD_MAX_BYTES = 8_192
const ANSWER_MAX_BYTES = 64 * 1024
const VERSION_SHAPE = /^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/
const VERSION_LINE = /^\s*version\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$/

export interface LearnedAntigravityClient {
  version: string
  learnedAtMs: number
  from: string
}

export type AntigravityClientPresented = { version: string; changelist: string; source: 'constant' | 'learned'; asOf: string }

export interface AntigravityClientRecord {
  learned?: LearnedAntigravityClient
  lastPeekAtMs?: number
  lastFailure?: { atMs: number; words: string }
}

export type AntigravityManifestAnswer = { ok: true; version: string; from: string } | { ok: false; words: string }

export type AntigravityClientPeek =
  | { kind: 'read'; answer: AntigravityManifestAnswer; learned: boolean }
  | { kind: 'skipped'; why: 'traffic-off' | 'today' | 'in-flight' | 'proof-shape' }

export interface AntigravityClientIo {
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  now?: () => number
}

export function compareAntigravityVersions(a: string, b: string): number {
  const left = a.split('.')
  const right = b.split('.')
  for (let i = 0; i < 3; i++) {
    const l = Number(left[i] ?? 0)
    const r = Number(right[i] ?? 0)
    if (l !== r) return l < r ? -1 : 1
  }
  return 0
}

export function antigravityIsoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function antigravityClientContractPath(): string {
  return join(getAuthConfigHomeDir(), ANTIGRAVITY_CLIENT_CONTRACT_FILE)
}

function isVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION_SHAPE.test(value)
}

function isStamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 8_640_000_000_000_000
}

function decodeLearned(value: unknown): LearnedAntigravityClient | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  if (!isVersion(row.version) || !isStamp(row.learnedAtMs)) return undefined
  const from = typeof row.from === 'string' && row.from.length > 0 && row.from.length <= 2048 ? row.from : ANTIGRAVITY_MANIFEST_DEFAULT_BASE
  return { version: row.version, learnedAtMs: row.learnedAtMs, from }
}

export function decodeAntigravityClientRecord(value: unknown): AntigravityClientRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const raw = value as Record<string, unknown>
  const record: AntigravityClientRecord = {}
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

export function readAntigravityClientRecord(): AntigravityClientRecord {
  const path = antigravityClientContractPath()
  try {
    if (statSync(path).size > RECORD_MAX_BYTES) return {}
    return decodeAntigravityClientRecord(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return {}
  }
}

function writeAntigravityClientRecord(next: AntigravityClientRecord): void {
  mkdirSync(getAuthConfigHomeDir(), { recursive: true })
  durableAtomicPublishSync(antigravityClientContractPath(), JSON.stringify({ ...next, version: 1 }) + '\n', { mode: 0o600 })
}

export function learnedAntigravityClient(): LearnedAntigravityClient | null {
  return readAntigravityClientRecord().learned ?? null
}

export function presentedAntigravityClient(): AntigravityClientPresented {
  const learned = learnedAntigravityClient()
  if (learned !== null && compareAntigravityVersions(learned.version, ANTIGRAVITY_CLIENT_CONTRACT_VERSION) > 0) {
    return { version: learned.version, changelist: ANTIGRAVITY_CLIENT_CONTRACT_CHANGELIST, source: 'learned', asOf: antigravityIsoDay(learned.learnedAtMs) }
  }
  return { version: ANTIGRAVITY_CLIENT_CONTRACT_VERSION, changelist: ANTIGRAVITY_CLIENT_CONTRACT_CHANGELIST, source: 'constant', asOf: ANTIGRAVITY_CLIENT_CONTRACT_AS_OF }
}

export function antigravityUserAgent(presented: AntigravityClientPresented = presentedAntigravityClient()): string {
  return `antigravity/hub/${presented.version} (aidev_client; os_type=${ANTIGRAVITY_CLIENT_OS}; arch=${ANTIGRAVITY_CLIENT_ARCH}; cl=${presented.changelist})`
}

export function antigravityManifestBase(env: NodeJS.ProcessEnv = process.env): string {
  const pinned = (env === process.env ? flagEnv('MERCURY_ANTIGRAVITY_MANIFEST_BASE') : env['MERCURY_ANTIGRAVITY_MANIFEST_BASE'])?.trim()
  return pinned && /^https?:\/\//i.test(pinned) ? pinned.replace(/\/+$/, '') : ANTIGRAVITY_MANIFEST_DEFAULT_BASE
}

export function antigravityManifestUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${antigravityManifestBase(env)}${ANTIGRAVITY_MANIFEST_PATH}`
}

export function decodeAntigravityManifestVersion(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const match = VERSION_LINE.exec(line)
    if (!match) continue
    const version = (match[1] ?? match[2] ?? match[3] ?? '').trim()
    return isVersion(version) ? version : undefined
  }
  return undefined
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
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(next.value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function readAntigravityVersionFromManifest(io?: AntigravityClientIo): Promise<AntigravityManifestAnswer> {
  const env = io?.env ?? process.env
  const url = antigravityManifestUrl(env)
  if (isProofShapeRun() && !isLoopbackUrl(url)) return { ok: false, words: proofShapeReason() }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ANTIGRAVITY_MANIFEST_DEADLINE_MS)
  timer.unref?.()
  try {
    const fetchImpl = io?.fetchImpl ?? getApiFetch()
    let response: Response
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'text/yaml, text/plain;q=0.9, */*;q=0.8', 'cache-control': 'no-cache', 'user-agent': 'electron-builder' },
        redirect: 'follow',
        signal: controller.signal,
        ...(io?.fetchImpl ? {} : getProxyFetchOptions()),
      } as RequestInit)
    } catch (error) {
      if (controller.signal.aborted) return { ok: false, words: `timeout after ${ANTIGRAVITY_MANIFEST_DEADLINE_MS / 1000} s` }
      const code = (error as { code?: unknown; cause?: { code?: unknown } })?.cause?.code ?? (error as { code?: unknown })?.code
      return { ok: false, words: typeof code === 'string' ? `no network (${code})` : 'no network' }
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return { ok: false, words: `HTTP ${response.status}` }
    }
    const text = await boundedText(response)
    if (text === null) return { ok: false, words: `the manifest ran past ${ANSWER_MAX_BYTES / 1024} KiB` }
    const version = decodeAntigravityManifestVersion(text)
    if (version === undefined) return { ok: false, words: 'the manifest named no three-part version' }
    return { ok: true, version, from: url }
  } finally {
    clearTimeout(timer)
  }
}

let peekInFlight: Promise<AntigravityClientPeek> | null = null

export function peekAntigravityClient(io?: AntigravityClientIo & { force?: boolean }): Promise<AntigravityClientPeek> {
  if (peekInFlight) return peekInFlight
  const env = io?.env ?? process.env
  const now = io?.now ?? Date.now
  if (getEssentialTrafficOnlyReason(env) !== null) return Promise.resolve({ kind: 'skipped', why: 'traffic-off' })
  if (isProofShapeRun() && !isLoopbackUrl(antigravityManifestUrl(env))) return Promise.resolve({ kind: 'skipped', why: 'proof-shape' })
  const before = readAntigravityClientRecord()
  const at = now()
  if (!io?.force && before.lastPeekAtMs !== undefined && at - before.lastPeekAtMs >= 0 && at - before.lastPeekAtMs < ANTIGRAVITY_CLIENT_PEEK_EVERY_MS) {
    return Promise.resolve({ kind: 'skipped', why: 'today' })
  }
  const work = (async (): Promise<AntigravityClientPeek> => {
    const answer = await readAntigravityVersionFromManifest(io)
    const fresh = readAntigravityClientRecord()
    if (!answer.ok) {
      try { writeAntigravityClientRecord({ ...fresh, lastFailure: { atMs: now(), words: answer.words.slice(0, 256) } }) } catch {}
      return { kind: 'read', answer, learned: false }
    }
    const newest = compareAntigravityVersions(answer.version, fresh.learned?.version ?? ANTIGRAVITY_CLIENT_CONTRACT_VERSION) > 0
    const next: AntigravityClientRecord = { ...fresh, lastPeekAtMs: now() }
    delete next.lastFailure
    if (newest) next.learned = { version: answer.version, learnedAtMs: now(), from: answer.from }
    try { writeAntigravityClientRecord(next) } catch {}
    return { kind: 'read', answer, learned: newest }
  })().finally(() => {
    peekInFlight = null
  })
  peekInFlight = work
  return work
}

export function antigravityClientContractWords(presented: AntigravityClientPresented = presentedAntigravityClient()): string {
  const record = readAntigravityClientRecord()
  const parts = [`the plan sign-in presents Google's Antigravity client ${presented.version} (${presented.source}, ${presented.asOf})`]
  if (record.lastFailure !== undefined) parts.push(`the last manifest read failed ${antigravityIsoDay(record.lastFailure.atMs)}: ${record.lastFailure.words}`)
  return parts.join(' · ')
}
