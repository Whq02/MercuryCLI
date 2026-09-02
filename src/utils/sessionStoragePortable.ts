import { createHash, type UUID } from 'node:crypto'
import { readdirSync, realpathSync, statSync } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { getMercuryHome } from './envUtils.js'
import { PROJECT_CONFIG_DIR_NAMES } from './projectConfig.js'
import { getWorktreePathsPortable } from './getWorktreePathsPortable.js'
import { djb2Hash } from './hash.js'


export const LITE_READ_BUF_SIZE = 65536
export const MAX_SANITIZED_LENGTH = 200
export const SKIP_PRECOMPACT_THRESHOLD = 5 * 1024 * 1024


const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function validateUuid(maybeUuid: unknown): UUID | null {
  if (typeof maybeUuid !== 'string') return null
  return UUID_PATTERN.test(maybeUuid) ? (maybeUuid as UUID) : null
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
    } catch {
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

export function extractFirstPromptFromHead(head: string): string {
  let commandNameFallback: string | null = null
  for (const line of head.split('\n')) {
    if (!line.includes('"kind":"input"')) continue
    if (line.includes('"tool_result"') || line.includes('"kind":"tool-result"')) continue
    if (line.includes('"isMeta":true') || line.includes('"isMeta": true')) continue
    if (line.includes('"isCompactSummary":true') || line.includes('"isCompactSummary": true')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
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
      const text = rawText.replace(/\n/g, ' ').trim()
      if (text === '') continue
      const commandName = /<command-name>(.*?)<\/command-name>/.exec(text)
      if (commandName) {
        if (commandNameFallback === null) commandNameFallback = commandName[1] as string
        continue
      }
      const bashInput = /<bash-input>(.*?)<\/bash-input>/.exec(text)
      if (bashInput) return `! ${bashInput[1] as string}`
      if (/^\s*<[a-z]/.test(text)) continue
      if (text.startsWith(INTERRUPT_MARKER)) continue
      if (text.length > FIRST_PROMPT_MAX) return `${text.slice(0, FIRST_PROMPT_MAX).trim()}…`
      return text
    }
  }
  return commandNameFallback ?? ''
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

export async function readHeadAndTail(filePath: string, fileSize: number, buf: Buffer): Promise<{ head: string; tail: string }> {
  try {
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
  } catch {
    return { head: '', tail: '' }
  }
}

export type LiteSessionFile = { mtime: number; size: number; head: string; tail: string }

export async function readSessionLite(filePath: string): Promise<LiteSessionFile | null> {
  try {
    const handle = await open(filePath, 'r')
    try {
      const stats = await handle.stat()
      const buf = Buffer.allocUnsafe(LITE_READ_BUF_SIZE)
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
  } catch {
    return null
  }
}


export function sanitizePath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return sanitized
  const bun = (globalThis as { Bun?: { hash?: (input: string) => number | bigint } }).Bun
  const hash = bun?.hash ? bun.hash(name).toString(36) : Math.abs(djb2Hash(name)).toString(36)
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

export async function canonicalizePath(dir: string): Promise<string> {
  try {
    return (await realpath(dir)).normalize('NFC')
  } catch {
    return dir.normalize('NFC')
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function canonicalizePathSyncFacts(dir: string): { canonical: string; canonicalized: boolean } {
  try {
    return { canonical: realpathSync(dir).normalize('NFC'), canonicalized: true }
  } catch {
    return { canonical: dir.normalize('NFC'), canonicalized: false }
  }
}

function directoryExistsSync(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function legacyTranscriptStoreExistsSync(path: string): boolean {
  try {
    return readdirSync(path).some(name => name.endsWith('.jsonl'))
  } catch {
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

export function getProjectDir(projectDir: string): string {
  const memoised = projectDirMemo.get(projectDir)
  if (memoised !== undefined) return memoised
  const projects = getProjectsDir()
  const folded = foldProjectConfigHomeTail(projectDir)
  const facts = canonicalizePathSyncFacts(folded)
  const canonical = foldProjectConfigHomeTail(facts.canonical)
  const byCanonical = projectDirMemo.get(canonical)
  if (byCanonical !== undefined) {
    if (facts.canonicalized) projectDirMemo.set(projectDir, byCanonical)
    return byCanonical
  }
  const hashed = join(projects, projectSlug(canonical))
  let resolved = hashed
  if (!directoryExistsSync(hashed)) {
    const legacyCanonical = join(projects, sanitizePath(canonical))
    if (legacyTranscriptStoreExistsSync(legacyCanonical)) {
      resolved = legacyCanonical
    } else if (canonical !== folded) {
      const legacyRaw = join(projects, sanitizePath(folded))
      if (legacyTranscriptStoreExistsSync(legacyRaw)) resolved = legacyRaw
    }
  }
  if (facts.canonicalized) {
    projectDirMemo.set(projectDir, resolved)
    projectDirMemo.set(canonical, resolved)
  }
  return resolved
}

export async function findProjectDir(projectPath: string): Promise<string | undefined> {
  const canonical = await canonicalizePath(projectPath)
  const candidate = getProjectDir(canonical)
  if (await directoryExists(candidate)) return candidate
  const sanitized = sanitizePath(canonical)
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return undefined
  try {
    const { readdir } = await import('node:fs/promises')
    const prefix = `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-`
    for (const entry of await readdir(getProjectsDir())) {
      if (entry.startsWith(prefix)) return join(getProjectsDir(), entry)
    }
  } catch {
    return undefined
  }
  return undefined
}


const LOAD_CHUNK = 1024 * 1024
const RECORD_PREFIX = Buffer.from('{"schemaVersion":')
const SNAPSHOT_MARKER = Buffer.from('"payload":{"kind":"session-meta","metaKind":"attribution-snapshot"')
const BOUNDARY_MARKER = Buffer.from('"payload":{"kind":"boundary","boundaryKind":"compact"')
const PAYLOAD_SEARCH_BOUND = 600
const OUTPUT_START_MAX = 8 * 1024 * 1024

export type TranscriptLoadResult = {
  boundaryStartOffset: number
  postBoundaryBuf: Buffer
  hasPreservedSegment: boolean
}

type LineDisposition =
  | { kind: 'keep' }
  | { kind: 'snapshot' }
  | { kind: 'boundary'; preserved: boolean }

const hasRecordPrefix = (line: Buffer): boolean =>
  line.length >= RECORD_PREFIX.length && line.subarray(0, RECORD_PREFIX.length).equals(RECORD_PREFIX)

function classifyLine(line: Buffer, requirePrefix: boolean): LineDisposition {
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
    } catch {
    }
  }
  return { kind: 'keep' }
}

export async function readTranscriptForLoad(filePath: string, fileSize: number): Promise<TranscriptLoadResult> {
  const handle = await open(filePath, 'r')
  try {
    let output = Buffer.allocUnsafe(Math.min(fileSize, OUTPUT_START_MAX))
    let outputLength = 0
    let boundaryStartOffset = 0
    let hasPreservedSegment = false
    let lastSnapshot: Buffer | null = null
    let carried: Buffer | null = null
    let position = 0
    const chunk = Buffer.allocUnsafe(LOAD_CHUNK)

    const ensureRoom = (extra: number): void => {
      if (outputLength + extra <= output.length) return
      const grown = Buffer.allocUnsafe(Math.min(Math.max(output.length * 2, outputLength + extra), fileSize + 1))
      output.copy(grown, 0, 0, outputLength)
      output = grown
    }

    const append = (bytes: Buffer): void => {
      ensureRoom(bytes.length)
      bytes.copy(output, outputLength)
      outputLength += bytes.length
    }

    const resetAtBoundary = (fileOffset: number): void => {
      outputLength = 0
      boundaryStartOffset = fileOffset
      hasPreservedSegment = false
      lastSnapshot = null
    }

    while (position < fileSize) {
      const toRead = Math.min(LOAD_CHUNK, fileSize - position)
      const { bytesRead } = await handle.read(chunk, 0, toRead, position)
      if (bytesRead === 0) break
      const chunkStart = position
      position += bytesRead
      let data = chunk.subarray(0, bytesRead)

      if (carried) {
        const newline = data.indexOf(0x0a)
        if (newline === -1) {
          carried = Buffer.concat([carried, data])
          continue
        }
        const headPart = data.subarray(0, newline + 1)
        const full = Buffer.concat([carried, headPart])
        const carriedStartOffset = chunkStart - carried.length
        carried = null
        const lineNoNewline = full.subarray(0, full.length - 1)
        const disposition = classifyLine(lineNoNewline, true)
        if (disposition.kind === 'snapshot') {
          lastSnapshot = Buffer.from(lineNoNewline)
        } else if (disposition.kind === 'boundary') {
          if (disposition.preserved) {
            hasPreservedSegment = true
            append(full)
          } else {
            resetAtBoundary(carriedStartOffset)
          }
        } else {
          append(full)
        }
        data = data.subarray(newline + 1)
      }

      let lineStart = 0
      for (;;) {
        const newline = data.indexOf(0x0a, lineStart)
        if (newline === -1) break
        const line = data.subarray(lineStart, newline)
        const withNewline = data.subarray(lineStart, newline + 1)
        const disposition = classifyLine(line, false)
        if (disposition.kind === 'snapshot') {
          lastSnapshot = Buffer.from(line)
        } else if (disposition.kind === 'boundary') {
          if (disposition.preserved) {
            hasPreservedSegment = true
            append(withNewline)
          } else {
            resetAtBoundary(chunkStart + (bytesRead - data.length) + lineStart)
          }
        } else {
          append(withNewline)
        }
        lineStart = newline + 1
      }
      if (lineStart < data.length) {
        carried = Buffer.from(data.subarray(lineStart))
      }
    }

    if (carried) {
      const disposition = classifyLine(carried, true)
      if (disposition.kind === 'snapshot') {
        lastSnapshot = Buffer.from(carried)
      } else if (disposition.kind === 'boundary' && !disposition.preserved) {
        resetAtBoundary(fileSize - carried.length)
      } else if (disposition.kind === 'boundary') {
        hasPreservedSegment = true
        append(carried)
      } else {
        append(carried)
      }
    }

    if (lastSnapshot) {
      if (outputLength > 0 && output[outputLength - 1] !== 0x0a) {
        append(Buffer.from('\n'))
      }
      append(lastSnapshot)
    }

    return {
      boundaryStartOffset,
      postBoundaryBuf: output.subarray(0, outputLength),
      hasPreservedSegment,
    }
  } finally {
    await handle.close()
  }
}
