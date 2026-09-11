import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { renameWithWin32RetrySync } from '../../substrate/durablePublish.js'
import { logForDebugging } from '../../utils/debug.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import {
  SAMPLE_GLYPH_DEFAULT,
  stateAfterVerdict,
  type SampleMarksV1,
  type SampleRecordV1,
  type SampleState,
  type SampleVersionV1,
} from './contracts.js'
import { renderSampleShell } from './shell.js'

const RECORD_FILE = 'sample.json'
const SAMPLE_ID_RE = /^[a-z0-9]{6,32}$/
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/
const STATES: ReadonlySet<string> = new Set<SampleState>(['open', 'approved', 'changes-needed'])

let listenerAddress: { port: number; token: string } | null = null

const sessionOfId = new Map<string, string>()

let tmpSeq = 0
let lastStampMs = 0

export function samplesRoot(sessionId: string): string {
  return join(getMercuryHome(), 'sessions', assertSessionId(sessionId), 'samples')
}

export function sampleDir(sessionId: string, id: string): string {
  return join(samplesRoot(sessionId), assertSampleId(id))
}

export function slugOf(name: string): string {
  const slug = String(name)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
  return slug.length > 0 ? slug : 'sample'
}

export interface CreateOrAppendSampleInput {
  sessionId: string
  name: string
  title?: string
  html: string
}

export function createOrAppendSample(input: CreateOrAppendSampleInput): { record: SampleRecordV1; version: number } {
  const sessionId = assertSessionId(input.sessionId)
  const slug = slugOf(input.name)
  const html = String(input.html)
  const givenTitle = cleanTitle(input.title)
  const now = stamp()
  mkdirSync(samplesRoot(sessionId), { recursive: true, mode: 0o700 })
  const existing = listSamples(sessionId).find(r => r.slug === slug)
  if (existing !== undefined) {
    const n = existing.latestVersion + 1
    const dir = sampleDir(sessionId, existing.id)
    writeAtomic(join(dir, `v${n}.html`), html)
    const record: SampleRecordV1 = {
      ...existing,
      title: givenTitle ?? existing.title,
      updatedAt: now,
      latestVersion: n,
      state: 'open',
      versions: [...existing.versions, { n, createdAt: now }],
    }
    writeRecord(dir, record)
    return { record, version: n }
  }
  const id = freshId(sessionId)
  const dir = sampleDir(sessionId, id)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeAtomic(join(dir, 'v1.html'), html)
  const record: SampleRecordV1 = {
    id,
    slug,
    title: givenTitle ?? cleanTitle(input.name) ?? slug,
    sessionId,
    createdAt: now,
    updatedAt: now,
    latestVersion: 1,
    state: 'open',
    glyph: SAMPLE_GLYPH_DEFAULT,
    versions: [{ n: 1, createdAt: now }],
  }
  writeRecord(dir, record)
  return { record, version: 1 }
}

export function listSamples(sessionId: string): SampleRecordV1[] {
  const root = samplesRoot(sessionId)
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  const out: SampleRecordV1[] = []
  for (const name of names) {
    if (!SAMPLE_ID_RE.test(name)) continue
    const record = readRecord(join(root, name), sessionId, name)
    if (record !== null) out.push(record)
  }
  out.sort(newestFirst)
  return out
}

export function getSample(sessionId: string, id: string): SampleRecordV1 | null {
  if (!SAMPLE_ID_RE.test(id)) return null
  return readRecord(sampleDir(sessionId, id), sessionId, id)
}

export function readVersion(sessionId: string, id: string, n: number): string | null {
  if (!Number.isInteger(n) || n < 1) return null
  try {
    return readFileSync(join(sampleDir(sessionId, id), `v${n}.html`), 'utf8')
  } catch {
    return null
  }
}

export function readMarks(sessionId: string, id: string, n: number): SampleMarksV1[] {
  if (!Number.isInteger(n) || n < 1) return []
  try {
    const raw: unknown = JSON.parse(readFileSync(join(sampleDir(sessionId, id), `marks-v${n}.json`), 'utf8'))
    return Array.isArray(raw) ? (raw as SampleMarksV1[]) : []
  } catch {
    return []
  }
}

export function appendMarks(
  sessionId: string,
  id: string,
  marks: SampleMarksV1,
): { record: SampleRecordV1; count: number } {
  const record = getSample(sessionId, id)
  if (record === null) throw new Error(`no sample ${id} in session ${sessionId}`)
  if (!Number.isInteger(marks.version) || marks.version < 1 || marks.version > record.latestVersion) {
    throw new Error(`sample ${id} has no version ${String(marks.version)}`)
  }
  const dir = sampleDir(sessionId, id)
  const all = readMarks(sessionId, id, marks.version)
  all.push(marks)
  writeAtomic(join(dir, `marks-v${marks.version}.json`), JSON.stringify(all, null, 2) + '\n')
  const next: SampleRecordV1 = { ...record, state: stateAfterVerdict(record.state, marks.verdict) }
  writeRecord(dir, next)
  return { record: next, count: all.length }
}

export function sessionOfSample(id: string): string | null {
  return sessionOfId.get(id) ?? null
}

export function setSampleListenerAddress(address: { port: number; token: string } | null): void {
  listenerAddress = address
}

export function sampleUrl(id: string): string | null {
  const sessionId = sessionOfId.get(id)
  if (sessionId === undefined) return null
  if (listenerAddress !== null) {
    return `http://127.0.0.1:${listenerAddress.port}/s/${id}?t=${listenerAddress.token}`
  }
  const record = getSample(sessionId, id)
  if (record === null) return null
  const page = fallbackPagePath(sessionId, record)
  return existsSync(page) ? pathToFileURL(page).href : null
}

export function writeFallbackPage(sessionId: string, id: string): string | null {
  const record = getSample(sessionId, id)
  if (record === null) return null
  const versionHtml: Record<number, string> = {}
  for (const version of record.versions) {
    const html = readVersion(sessionId, id, version.n)
    if (html !== null) versionHtml[version.n] = html
  }
  const page = renderSampleShell({ record, versions: record.versions, token: null, inline: true, versionHtml })
  const path = fallbackPagePath(sessionId, record)
  writeAtomic(path, page)
  return path
}

function fallbackPagePath(sessionId: string, record: SampleRecordV1): string {
  return join(sampleDir(sessionId, record.id), `v${record.latestVersion}.page.html`)
}

function assertSessionId(sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error('a sample session id must be one plain path segment')
  return sessionId
}

function assertSampleId(id: string): string {
  if (!SAMPLE_ID_RE.test(id)) throw new Error('a sample id is 6 to 32 lower-case letters and digits')
  return id
}

function cleanTitle(title: string | undefined): string | undefined {
  if (typeof title !== 'string') return undefined
  const clean = title.replace(/\s+/g, ' ').trim().slice(0, 120)
  return clean.length > 0 ? clean : undefined
}

function stamp(): string {
  const ms = Math.max(Date.now(), lastStampMs + 1)
  lastStampMs = ms
  return new Date(ms).toISOString()
}

function freshId(sessionId: string): string {
  for (;;) {
    const id = randomBytes(5).toString('hex')
    if (!existsSync(sampleDir(sessionId, id))) return id
  }
}

function newestFirst(a: SampleRecordV1, b: SampleRecordV1): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function writeRecord(dir: string, record: SampleRecordV1): void {
  writeAtomic(join(dir, RECORD_FILE), JSON.stringify(record, null, 2) + '\n')
  sessionOfId.set(record.id, record.sessionId)
}

function readRecord(dir: string, sessionId: string, id: string): SampleRecordV1 | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(join(dir, RECORD_FILE), 'utf8'))
  } catch (err) {
    if (existsSync(join(dir, RECORD_FILE))) {
      logForDebugging(`samples: the record of ${id} could not be read — ${err instanceof Error ? err.message : String(err)}`)
    }
    return null
  }
  const record = decodeRecord(raw, sessionId, id)
  if (record !== null) sessionOfId.set(record.id, sessionId)
  return record
}

function decodeRecord(raw: unknown, sessionId: string, id: string): SampleRecordV1 | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.id !== id || typeof r.slug !== 'string' || typeof r.title !== 'string') return null
  if (typeof r.createdAt !== 'string' || typeof r.updatedAt !== 'string') return null
  if (!Number.isInteger(r.latestVersion) || (r.latestVersion as number) < 1) return null
  const state = typeof r.state === 'string' && STATES.has(r.state) ? (r.state as SampleState) : 'open'
  const versions: SampleVersionV1[] = Array.isArray(r.versions)
    ? (r.versions as unknown[])
        .filter((v): v is { n: number; createdAt: string } => {
          const x = v as Record<string, unknown> | null
          return x !== null && typeof x === 'object' && Number.isInteger(x.n) && typeof x.createdAt === 'string'
        })
        .map(v => ({ n: v.n, createdAt: v.createdAt }))
    : []
  return {
    id,
    slug: r.slug,
    title: r.title,
    sessionId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    latestVersion: r.latestVersion as number,
    state,
    glyph: typeof r.glyph === 'string' && r.glyph.length > 0 ? r.glyph : SAMPLE_GLYPH_DEFAULT,
    versions,
  }
}

function writeAtomic(path: string, text: string): void {
  const temp = `${path}.tmp-${process.pid}-${++tmpSeq}`
  try {
    writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600, flush: true })
    renameWithWin32RetrySync(temp, path)
  } catch (err) {
    try {
      unlinkSync(temp)
    } catch {
    }
    throw err
  }
}
