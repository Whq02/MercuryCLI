import { historyHead, historyRange } from './sessionStorage/historyParts.js'
import { createHash, type UUID } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { getMercuryHome } from './envUtils.js'
import { PROJECT_CONFIG_DIR_NAMES } from './projectConfig.js'
import { djb2Hash } from './hash.js'
import { sliceHeadAtGrapheme } from './intl.js'
import { errorMessage, getErrnoCode } from './errors.js'
import { projectDirectoryIdentity, resolveDirectoryIdentity, resolveProjectStore, type ProjectStoreReadFailure, type StoreSpellingRules } from './projectStoreIdentity.js'
import { setStoreHealth, transcriptStoreHealth } from './sessionStorage/writer/storeHealth.js'
import { stripGroundNote } from './isolationNote.js'
import { passedOver } from './passedOver.js'


export const LITE_READ_BUF_SIZE = 65536
export const MAX_SANITIZED_LENGTH = 200
export const SKIP_PRECOMPACT_THRESHOLD = 5 * 1024 * 1024


const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function validateUuid(maybeUuid: unknown): UUID | null {
  if (typeof maybeUuid !== 'string') return null
  return UUID_PATTERN.test(maybeUuid) ? (maybeUuid as UUID) : null
}

export function isTranscriptFileName(name: string): boolean {
  return name.length > 6 && name.endsWith('.jsonl') && !name.slice(0, -6).includes('.')
}

export function unescapeJsonString(raw: string): string {
  if (!raw.includes('\\')) return raw
  try {
    return JSON.parse(`"${raw}"`) as string
  } catch {
    return raw
  }
}

function scanQuotedValue(text: string, start: number): string | null {
  let index = start
  while (index < text.length) {
    const ch = text.charCodeAt(index)
    if (ch === 92 ) {
      index += 2
      continue
    }
    if (ch === 34 ) return text.slice(start, index)
    index++
  }
  return null
}

function fieldPatterns(key: string): [string, string] {
  return [`"${key}":"`, `"${key}": "`]
}

export function extractJsonStringField(text: string, key: string): string | undefined {
  const [tight, spaced] = fieldPatterns(key)
  let best = -1
  let valueStart = -1
  for (const pattern of [tight, spaced]) {
    const index = text.indexOf(pattern)
    if (index !== -1 && (best === -1 || index < best)) {
      best = index
      valueStart = index + pattern.length
    }
  }
  if (best === -1) return undefined
  const raw = scanQuotedValue(text, valueStart)
  return raw === null ? undefined : unescapeJsonString(raw)
}

export function extractLastJsonStringField(text: string, key: string): string | undefined {
  const [tight, spaced] = fieldPatterns(key)
  let best = -1
  let valueStart = -1
  for (const pattern of [tight, spaced]) {
    const index = text.lastIndexOf(pattern)
    if (index > best) {
      best = index
      valueStart = index + pattern.length
    }
  }
  if (best === -1) return undefined
  const raw = scanQuotedValue(text, valueStart)
  return raw === null ? undefined : unescapeJsonString(raw)
}


export function scanTailForEndedOnError(tail: string): boolean | undefined {
  if (tail === '') return undefined
  const lines = tail.split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index] as string
    if (!line.includes('"kind":"output"') && !line.includes('"noticeKind":"api_error"')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      passedOver(error)
      continue
    }
    if (parsed === null || typeof parsed !== 'object') continue
    const record = parsed as {
      schemaVersion?: unknown
      payload?: { kind?: unknown; noticeKind?: unknown } | null
      annotations?: { error?: unknown; isApiErrorMessage?: unknown } | null
    }
    if (typeof record.schemaVersion !== 'number' || !record.payload || typeof record.payload !== 'object') continue
    if (record.payload.kind === 'output') {
      const ann = record.annotations
      return (ann != null && ann.error != null) || ann?.isApiErrorMessage === true
    }
    if (record.payload.kind === 'notice' && record.payload.noticeKind === 'api_error') return true
  }
  return undefined
}


const INTERRUPT_MARKER = '[Request interrupted by user'
const CUT_MARKER = '[Request cut off'
const FIRST_PROMPT_MAX = 200

type TextBlockish = { type?: unknown; text?: unknown }

function collectTexts(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  const texts: string[] = []
  for (const block of content as TextBlockish[]) {
    if (block && block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
  }
  return texts
}

export function extractFirstPromptFromHead(head: string, opts: { promptsOnly?: boolean } = {}): string {
  let commandNameFallback: string | null = null
  for (const line of head.split('\n')) {
    if (!line.includes('"kind":"input"')) continue
    if (line.includes('"tool_result"') || line.includes('"kind":"tool-result"')) continue
    if (line.includes('"isMeta":true') || line.includes('"isMeta": true')) continue
    if (line.includes('"isCompactSummary":true') || line.includes('"isCompactSummary": true')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      passedOver(error)
      continue
    }
    if (parsed === null || typeof parsed !== 'object') continue
    const record = parsed as {
      schemaVersion?: unknown
      payload?: { kind?: unknown; content?: unknown } | null
    }
    let content: unknown
    if (typeof record.schemaVersion === 'number' && record.payload && record.payload.kind === 'input') {
      const payloadContent = record.payload.content
      if (Array.isArray(payloadContent)) {
        content = payloadContent.map(block => {
          const candidate = block as { kind?: unknown; text?: unknown }
          if (candidate && candidate.kind === 'text' && typeof candidate.text === 'string') {
            return { type: 'text', text: candidate.text }
          }
          return block
        })
      } else {
        content = payloadContent
      }
    } else {
      continue
    }
    for (const rawText of collectTexts(content)) {
      const text = stripGroundNote(rawText).replace(/\n/g, ' ').trim()
      if (text === '') continue
      const commandName = /<command-name>(.*?)<\/command-name>/.exec(text)
      if (commandName) {
        if (commandNameFallback === null) commandNameFallback = commandName[1] as string
        continue
      }
      const bashInput = /<bash-input>(.*?)<\/bash-input>/.exec(text)
      if (bashInput) return `! ${bashInput[1] as string}`
      if (/^\s*<[a-z]/.test(text)) continue
      if (text.startsWith(INTERRUPT_MARKER) || text.startsWith(CUT_MARKER)) continue
      if (text.length > FIRST_PROMPT_MAX) return `${sliceHeadAtGrapheme(text, FIRST_PROMPT_MAX).trim()}…`
      return text
    }
  }
  return opts.promptsOnly === true ? '' : (commandNameFallback ?? '')
}


function decodeWindow(buffer: Buffer, length: number, trimLeading: boolean, trimTrailing: boolean): string {
  let start = 0
  let end = length
  if (trimLeading) {
    while (start < end && (buffer[start]! & 0xc0) === 0x80) start++
  }
  if (trimTrailing) {
    let index = end - 1
    let continuations = 0
    while (index >= start && (buffer[index]! & 0xc0) === 0x80) {
      continuations++
      index--
    }
    if (index >= start) {
      const lead = buffer[index]!
      const expected = (lead & 0xf8) === 0xf0 ? 3 : (lead & 0xf0) === 0xe0 ? 2 : (lead & 0xe0) === 0xc0 ? 1 : 0
      if (expected > continuations) end = index
    }
  }
  return buffer.toString('utf8', start, end)
}

function isAbsenceError(error: unknown): boolean {
  const code = getErrnoCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export async function readHeadAndTail(
  filePath: string,
  fileSize: number,
  buf: Buffer,
  onReadError?: (path: string, error: unknown) => void,
): Promise<{ head: string; tail: string }> {
  try {
    const extent = historyHead(filePath)
    if (extent.before) {
      const size = extent.before + extent.end - extent.start
      const window = Math.min(buf.length, LITE_READ_BUF_SIZE)
      const first = historyRange(extent, 0, Math.min(window, size))
      const head = decodeWindow(first, first.length, false, first.length < size)
      const last = size > window ? historyRange(extent, size - window, size) : null
      return { head, tail: last ? decodeWindow(last, last.length, true, false) : head }
    }
    const handle = await open(filePath, 'r')
    try {
      const window = Math.min(buf.length, LITE_READ_BUF_SIZE)
      const headRead = await handle.read(buf, 0, Math.min(window, fileSize), 0)
      if (headRead.bytesRead === 0) return { head: '', tail: '' }
      const moreFollows = fileSize > headRead.bytesRead
      const head = decodeWindow(buf, headRead.bytesRead, false, moreFollows)
      if (fileSize <= window) return { head, tail: head }
      const tailRead = await handle.read(buf, 0, window, fileSize - window)
      const tail = decodeWindow(buf, tailRead.bytesRead, true, false)
      return { head, tail }
    } finally {
      await handle.close()
    }
  } catch (error) {
    passedOver(error)
    if (!isAbsenceError(error)) onReadError?.(filePath, error)
    return { head: '', tail: '' }
  }
}

export type LiteSessionFile = { mtime: number; size: number; head: string; tail: string }

export async function readSessionLite(
  filePath: string,
  onReadError?: (path: string, error: unknown) => void,
): Promise<LiteSessionFile | null> {
  try {
    const handle = await open(filePath, 'r')
    try {
      const stats = await handle.stat()
      const buf = Buffer.allocUnsafe(LITE_READ_BUF_SIZE)
      const extent = historyHead(filePath)
      if (extent.before) {
        const size = extent.before + extent.end - extent.start
        const { head, tail } = await readHeadAndTail(filePath, size, buf, onReadError)
        return { mtime: stats.mtimeMs, size, head, tail }
      }
      const headRead = await handle.read(buf, 0, Math.min(LITE_READ_BUF_SIZE, stats.size), 0)
      if (headRead.bytesRead === 0) return null
      const moreFollows = stats.size > headRead.bytesRead
      const head = decodeWindow(buf, headRead.bytesRead, false, moreFollows)
      let tail = head
      if (stats.size > LITE_READ_BUF_SIZE) {
        const tailRead = await handle.read(buf, 0, LITE_READ_BUF_SIZE, stats.size - LITE_READ_BUF_SIZE)
        tail = decodeWindow(buf, tailRead.bytesRead, true, false)
      }
      return { mtime: stats.mtimeMs, size: stats.size, head, tail }
    } finally {
      await handle.close()
    }
  } catch (error) {
    passedOver(error)
    if (!isAbsenceError(error)) onReadError?.(filePath, error)
    return null
  }
}


export function sanitizePath(name: string): string {
  return capSanitizedName(name.replace(/[^a-zA-Z0-9]/g, '-'), name)
}

export function capSanitizedName(sanitized: string, original: string): string {
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return sanitized
  const bun = (globalThis as { Bun?: { hash?: (input: string) => number | bigint } }).Bun
  const hash = bun?.hash ? bun.hash(original).toString(36) : Math.abs(djb2Hash(original)).toString(36)
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${hash}`
}

export function getProjectsDir(): string {
  return join(getMercuryHome(), 'projects')
}

export function shortProjectHash(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex').slice(0, 8)
}

export function projectSlug(canonical: string): string {
  return `${sanitizePath(canonical)}-${shortProjectHash(canonical)}`
}

export function projectSlugMatches(name: string, spelling: string): boolean {
  const sanitized = spelling.replace(/[^a-zA-Z0-9]/g, '-')
  const tail = `-${shortProjectHash(spelling)}`
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return name === sanitized + tail
  if (!name.startsWith(`${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-`) || !name.endsWith(tail)) return false
  return /^[a-z0-9]+$/i.test(name.slice(MAX_SANITIZED_LENGTH + 1, -tail.length))
}

export async function canonicalizePath(dir: string): Promise<string> {
  return resolveDirectoryIdentity(dir).canonical
}

async function directoryExists(
  path: string,
  onReadError?: (path: string, error: unknown) => void,
): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    passedOver(error)
    if (!isAbsenceError(error)) onReadError?.(path, error)
    return false
  }
}

const projectDirMemo = new Map<string, string>()

export function foldProjectConfigHomeTail(dir: string): string {
  const base = basename(dir)
  if (!(PROJECT_CONFIG_DIR_NAMES as readonly string[]).includes(base)) return dir
  const parent = dirname(dir)
  const parentBase = basename(parent)
  if (parentBase.length === 0 || parentBase === base) return dir
  return parent
}

const storeSpellingRules: StoreSpellingRules = { fold: foldProjectConfigHomeTail, slugMatches: projectSlugMatches }

const reportedStoreReadFailures = new Set<string>()

export function getProjectDir(projectDir: string): string {
  const projects = getProjectsDir()
  const spelled = `${projects}\0${projectDir}`
  const memoised = projectDirMemo.get(spelled)
  if (memoised !== undefined) return memoised
  const identity = projectDirectoryIdentity(projectDir, foldProjectConfigHomeTail)
  const canonicalKey = `${projects}\0${identity.canonical}`
  const byCanonical = projectDirMemo.get(canonicalKey)
  if (byCanonical !== undefined) {
    if (identity.exists) projectDirMemo.set(spelled, byCanonical)
    return byCanonical
  }
  let readFailure: ProjectStoreReadFailure | null = null
  const resolved = resolveProjectStore(projects, identity, projectSlug(identity.canonical), storeSpellingRules, failure => {
    readFailure = failure
  })
  if (readFailure !== null) {
    const failure: ProjectStoreReadFailure = readFailure
    if (!reportedStoreReadFailures.has(failure.path)) {
      reportedStoreReadFailures.add(failure.path)
      if (!transcriptStoreHealth().failing) {
        setStoreHealth({
          failing: true,
          sentence: `${failure.path} could not be read (${errorMessage(failure.error)}), so this project's earlier sessions may not be listed — restore read permission on it.`,
        })
      }
    }
  } else if (identity.exists) {
    projectDirMemo.set(spelled, resolved)
    projectDirMemo.set(canonicalKey, resolved)
  }
  return resolved
}

export async function findProjectDir(
  projectPath: string,
  onReadError?: (path: string, error: unknown) => void,
): Promise<string | undefined> {
  const canonical = await canonicalizePath(projectPath)
  const candidate = getProjectDir(canonical)
  if (await directoryExists(candidate, onReadError)) return candidate
  const sanitized = sanitizePath(canonical)
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return undefined
  const projectsDir = getProjectsDir()
  try {
    const { readdir } = await import('node:fs/promises')
    const prefix = `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-`
    const suffix = candidate.slice(candidate.lastIndexOf('-'))
    for (const entry of await readdir(projectsDir)) {
      if (entry.startsWith(prefix) && entry.endsWith(suffix)) return join(projectsDir, entry)
    }
  } catch (error) {
    passedOver(error)
    if (!isAbsenceError(error)) onReadError?.(projectsDir, error)
    return undefined
  }
  return undefined
}


const RECORD_PREFIX = Buffer.from('{"schemaVersion":')
const SNAPSHOT_MARKER = Buffer.from('"payload":{"kind":"session-meta","metaKind":"attribution-snapshot"')
const BOUNDARY_MARKER = Buffer.from('"payload":{"kind":"boundary","boundaryKind":"compact"')
const PAYLOAD_SEARCH_BOUND = 600

type LineDisposition =
  | { kind: 'keep' }
  | { kind: 'snapshot' }
  | { kind: 'boundary'; preserved: boolean }

const hasRecordPrefix = (line: Buffer): boolean =>
  line.length >= RECORD_PREFIX.length && line.subarray(0, RECORD_PREFIX.length).equals(RECORD_PREFIX)

export function classifyLoadLine(line: Buffer, requirePrefix: boolean): LineDisposition {
  const searchWindow = line.subarray(0, Math.min(line.length, PAYLOAD_SEARCH_BOUND))
  if (searchWindow.indexOf(SNAPSHOT_MARKER) !== -1) {
    if (!requirePrefix || hasRecordPrefix(line)) return { kind: 'snapshot' }
  }
  if (searchWindow.indexOf(BOUNDARY_MARKER) !== -1) {
    if (requirePrefix && !hasRecordPrefix(line)) {
      return { kind: 'keep' }
    }
    try {
      const parsed = JSON.parse(line.toString('utf8')) as {
        payload?: {
          kind?: unknown
          boundaryKind?: unknown
          fields?: { compactMetadata?: { preservedSegment?: unknown } | null } | null
        } | null
      }
      if (parsed?.payload && parsed.payload.kind === 'boundary' && parsed.payload.boundaryKind === 'compact') {
        return { kind: 'boundary', preserved: Boolean(parsed.payload.fields?.compactMetadata?.preservedSegment) }
      }
    } catch (error) {
      passedOver(error)
    }
  }
  return { kind: 'keep' }
}
