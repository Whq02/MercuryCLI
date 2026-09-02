import { createHash, type UUID } from 'node:crypto'
import { readdirSync, realpathSync, statSync } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { getMercuryHome } from './envUtils.js'
import { PROJECT_CONFIG_DIR_NAMES } from './projectConfig.js'
import { getWorktreePathsPortable } from './getWorktreePathsPortable.js'
import { djb2Hash } from './hash.js'

/**
 * Dependency-free transcript/session-store primitives, shared with an
 * out-of-process consumer (the editor extension): no logging, no
 * experiments, no feature flags — Node builtins, the home resolver, the
 * worktree helper and the hash helper only.
 */

export const LITE_READ_BUF_SIZE = 65536
export const MAX_SANITIZED_LENGTH = 200
/** Below this size precompact filtering is skipped by CALLERS (a small file is near-certain not to hold a boundary). */
export const SKIP_PRECOMPACT_THRESHOLD = 5 * 1024 * 1024

// ---------------------------------------------------------------------------
// UUIDs and raw field extraction
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function validateUuid(maybeUuid: unknown): UUID | null {
  if (typeof maybeUuid !== 'string') return null
  return UUID_PATTERN.test(maybeUuid) ? (maybeUuid as UUID) : null
}

/** Allocates only when a backslash is present; falls back to the raw text if the unescape fails. */
export function unescapeJsonString(raw: string): string {
  if (!raw.includes('\\')) return raw
  try {
    return JSON.parse(`"${raw}"`) as string
  } catch {
    return raw
  }
}

/** Scan forward from `start`, honouring backslash escapes, to the closing quote; null when unterminated. */
function scanQuotedValue(text: string, start: number): string | null {
  let index = start
  while (index < text.length) {
    const ch = text.charCodeAt(index)
    if (ch === 92 /* backslash */) {
      index += 2
      continue
    }
    if (ch === 34 /* quote */) return text.slice(start, index)
    index++
  }
  return null
}

/** Both spacings must be tried — different writers emit differently. */
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

/**
 * Last occurrence — comparing byte positions ACROSS both spacing patterns,
 * keeping the highest index (a later no-space match must beat an earlier
 * spaced one). Used for fields appended over a session's life.
 */
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

// ---------------------------------------------------------------------------
// End-state scan
// ---------------------------------------------------------------------------

/**
 * Did the session's last assistant turn end on an unrecovered error — true,
 * false, or UNKNOWN. The pre-filter is only a filter: the verdict reads the
 * PARSED record's own envelope fields, which is what makes the scan
 * spoof-proof (a pasted transcript in user text lives inside a string on a
 * line whose own payload kind is input, and is skipped). The walk STOPS at
 * the first parsed output record. No qualifying line ⇒ unknown — a
 * truncated or foreign window must not be reported as "ended cleanly".
 */
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
      // Normal twice per window: a tail read starts mid-record, and the
      // last line can race an unfinished append.
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

// ---------------------------------------------------------------------------
// First-prompt extraction
// ---------------------------------------------------------------------------

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

/** The first meaningful user prompt from a head window, or empty. */
export function extractFirstPromptFromHead(head: string): string {
  let commandNameFallback: string | null = null
  for (const line of head.split('\n')) {
    if (!line.includes('"kind":"input"')) continue
    // Cheap byte pre-filters.
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
        // Fabric blocks project onto the common text-block shape; other
        // kinds pass through and are ignored by the text collector.
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
      // The bash form must be recognised BEFORE the generic tag skip.
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

// ---------------------------------------------------------------------------
// Head/tail reads
// ---------------------------------------------------------------------------

/**
 * UTF-8 edge correctness: exclude — never decode to a replacement glyph — a
 * leading run of orphaned continuation bytes (the tail read always begins
 * mid-character) and a trailing incomplete sequence (the head read does,
 * but only when more file follows; an end-of-file edge is complete).
 */
function decodeWindow(buffer: Buffer, length: number, trimLeading: boolean, trimTrailing: boolean): string {
  let start = 0
  let end = length
  if (trimLeading) {
    while (start < end && (buffer[start]! & 0xc0) === 0x80) start++
  }
  if (trimTrailing) {
    // Walk back over a trailing incomplete multi-byte sequence.
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

/** The caller-supplied-buffer variant: one open, head from 0, tail only when the file exceeds the window (else tail IS head). */
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

/** The self-allocating variant: stats the descriptor itself (safe for concurrent use). */
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

// ---------------------------------------------------------------------------
// Path sanitisation and project keying
// ---------------------------------------------------------------------------

/** Every non-alphanumeric ASCII character becomes a hyphen; overlong names truncate and append a base-36 hash of the ORIGINAL string. */
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

/** A cross-runtime hash (standard crypto, never the bundling runtime's — its divergence forced the prefix-scan fallback). */
export function shortProjectHash(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex').slice(0, 8)
}

/**
 * The injective slug: sanitised canonical spelling, hyphen, short content
 * hash — the sanitiser folds all punctuation to one hyphen, so short paths
 * differing only in punctuation would otherwise collide.
 */
export function projectSlug(canonical: string): string {
  return `${sanitizePath(canonical)}-${shortProjectHash(canonical)}`
}

/** Real path then NFC; NFC alone when resolution fails (the directory may not exist yet). */
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

/** Sync twin of canonicalizePath for the synchronous derivation below —
 *  with the SUCCESS FACT beside the spelling: a failed resolution (the
 *  directory missing, unmaterialized, or momentarily unreadable) is an
 *  ANSWER but not an identity, and the memo below must never freeze it. */
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

/**
 * A directory only counts as a legacy TRANSCRIPT STORE when it holds at
 * least one transcript file. Bare existence is not enough: memdir plants its
 * memory estate under the same `projects/` namespace with a DIFFERENT,
 * hashless key (sanitizePathComponent keeps `_` where sanitizePath folds it),
 * so adopting any directory at the hashless path cross-wired two
 * punctuation-sibling projects into ONE store — `--continue` in one project
 * resumed the other's conversation (FC-007).
 */
function legacyTranscriptStoreExistsSync(path: string): boolean {
  try {
    return readdirSync(path).some(name => name.endsWith('.jsonl'))
  } catch {
    return false
  }
}

const projectDirMemo = new Map<string, string>()

/**
 * THE CONFIG-HOME FOLD (the concourse re-home bug, ruled): a directory that
 * IS a project-config home (`.mercury`) is never a project of its own — it
 * keys to its PARENT, exactly as the ruled naming precedent already displays
 * it (projectDisplayName wears the parent's name). Before this fold the name
 * and the key contradicted on one frame: a session whose workspace was the
 * config home classed as ANOTHER project while every surface named it by the
 * parent — the board said "N running in <project>" on that project's own
 * board. Applied to the given spelling AND to the canonical one (a symlink
 * resolving into a config home folds too), with the naming rule's own guard:
 * a root-level or self-named config dir stands unfolded.
 */
export function foldProjectConfigHomeTail(dir: string): string {
  const base = basename(dir)
  if (!(PROJECT_CONFIG_DIR_NAMES as readonly string[]).includes(base)) return dir
  const parent = dirname(dir)
  const parentBase = basename(parent)
  if (parentBase.length === 0 || parentBase === base) return dir
  return parent
}

/**
 * The adoption ladder — existing stores are honoured in place, never
 * migrated: the hashed directory; the legacy hash-less directory on the
 * canonical spelling; the legacy directory on the raw spelling when
 * canonicalisation changed the path; else the hashed directory (to
 * create). A project-config-home tail folds to its parent FIRST (the
 * config-home fold above), so the ladder only ever adopts stores of real
 * project roots. Synchronous; returns the resolved ABSOLUTE project
 * directory path.
 *
 * THE MEMO KEYS IDENTITY, NOT SPELLING (the key-stability law): the
 * resolution is shared under the CANONICAL spelling, so two aliases of one
 * folder answer one key regardless of which was asked first or what stores
 * existed at each first call (the straddle class: a store born between two
 * first calls split one project into two keys for the process lifetime).
 * A resolution built on a FAILED canonicalization is answered but never
 * memoised — a missing or momentarily unreadable folder re-resolves on the
 * next call instead of freezing a wrong raw-slug key (such a spelling costs
 * its two stats per call, the price of an honest answer).
 */
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
    // The legacy arms demand a real store (a transcript inside), never bare
    // directory existence — see legacyTranscriptStoreExistsSync (FC-007).
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

/**
 * The tolerant lookup: the directory only if readable. For overlong paths —
 * where two runtimes may have produced different hash suffixes — scan for a
 * prefix-plus-hyphen match.
 */
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

// ---------------------------------------------------------------------------
// Compact-boundary transcript load
// ---------------------------------------------------------------------------

const LOAD_CHUNK = 1024 * 1024
// Record lines open with the envelope's first key (compact JSON, fixed
// serialization order). A raw double-quote cannot occur inside a JSON
// string value (it serializes escaped), so the structural payload-open
// sequences below can only match at structural positions; the search bound
// keeps a record EMBEDDED in another record's fields (which sits past the
// host envelope) from matching.
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
    // Believe the marker only after parsing confirms a boundary record.
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
      // Content, not a boundary.
    }
  }
  return { kind: 'keep' }
}

/**
 * One forward chunked read: strips attribution-snapshot lines (remembering
 * the LAST and re-appending it at end of file), truncates at each confirmed
 * non-preserving compact boundary, and never holds more than the output.
 */
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

      // Resolve the carried straddle first: the carried tail plus this
      // chunk's head form one logical line.
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
        // A carried head too short to rule out a snapshot prefix fell
        // through to concatenation above by construction; on the seam path
        // a boundary is parsed only when the head begins with the
        // system-record prefix.
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

      // In-chunk lines.
      let lineStart = 0
      for (;;) {
        const newline = data.indexOf(0x0a, lineStart)
        if (newline === -1) break
        const line = data.subarray(lineStart, newline)
        const withNewline = data.subarray(lineStart, newline + 1)
        const disposition = classifyLine(line, false)
        if (disposition.kind === 'snapshot') {
          // A later in-chunk snapshot beats one remembered from the straddle.
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

    // A final line without a newline.
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

    // Re-append the last surviving snapshot; consumers read only the last
    // one in the loaded list, never its position. Insert a newline when the
    // output does not end with one (a writer that died mid-append).
    if (lastSnapshot) {
      if (outputLength > 0 && output[outputLength - 1] !== 0x0a) {
        append(Buffer.from('\n'))
      }
      append(lastSnapshot)
    }

    return {
      boundaryStartOffset,
      // A view onto the buffer, not a copy — callers must not assume ownership.
      postBoundaryBuf: output.subarray(0, outputLength),
      hasPreservedSegment,
    }
  } finally {
    await handle.close()
  }
}
