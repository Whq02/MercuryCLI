import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { stripGroundNote, GROUND_NOTE_MARK } from './isolationNote.js'
import { sliceHeadAtGrapheme } from '../../platform/text/textSegments.js'
import {
  extractJsonStringField,
  extractLastJsonStringField,
  LITE_READ_BUF_SIZE,
  readHeadAndTail,
  scanTailForEndedOnError,
  validateUuid,
} from './sessionStoragePortable.js'
import { readTranscriptTailSync } from './transcriptReader.js'
import { getErrnoCode } from '../../platform/errors/errors.js'
import { passedOver } from '../../platform/errors/passedOver.js'

function isAbsenceError(error: unknown): boolean {
  const code = getErrnoCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export type IndexedSession = {
  sessionId: string
  path: string
  mtime: number
  ctime: number
  size: number
}

export async function sessionFiles(
  projectDir: string,
  options: { stat?: boolean; concurrency?: number; failed?: (path: string, error?: unknown) => void } = {},
): Promise<IndexedSession[]> {
  let entries
  try {
    entries = await readdir(projectDir, { withFileTypes: true })
  } catch (error) {
    passedOver(error)
    if (!isAbsenceError(error)) options.failed?.(projectDir, error)
    return []
  }
  const candidates = entries.flatMap(entry => {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) return []
    const sessionId = validateUuid(entry.name.slice(0, -6))
    return sessionId ? [{ sessionId, path: join(projectDir, entry.name), mtime: 0, ctime: 0, size: 0 }] : []
  })
  if (options.stat === false) return candidates
  const rows: Array<IndexedSession | null> = new Array(candidates.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(candidates.length, options.concurrency ?? 32) }, async () => {
    while (cursor < candidates.length) {
      const index = cursor++
      const row = candidates[index]!
      try {
        const info = await stat(row.path)
        rows[index] = { ...row, mtime: info.mtimeMs, ctime: info.birthtimeMs, size: info.size }
      } catch (error) {
        passedOver(error)
        if (!isAbsenceError(error)) options.failed?.(row.path, error)
        rows[index] = null
      }
    }
  }))
  return rows.filter((row): row is IndexedSession => row !== null)
}

function flatPrompt(text: string): string {
  return text.replace(/\n/g, ' ').trim()
}

function clippedPrompt(flat: string): string {
  return flat.length > 200 ? sliceHeadAtGrapheme(flat, 200).trim() + '…' : flat
}

export function promptLabel(text: string): string {
  return clippedPrompt(flatPrompt(text))
}

export function sessionPromptFromWindow(chunk: string, builtIn: (name: string) => boolean = () => true): string {
  let commandFallback = ''
  for (const line of chunk.split('\n')) {
    if (!/"kind":\s*"input"/.test(line) || line.includes('"tool_result"') || /"isMeta":\s*true/.test(line)) continue
    try {
      const record = JSON.parse(line)
      const payload = record.payload
      if (payload?.kind !== 'input') continue
      const meta = payload.meta ?? {}
      if (meta.hiddenFromTranscript === true || meta.isVirtual === true || meta.isCompactSummary === true || meta.toolUseResult !== undefined) continue
      const texts = typeof payload.content === 'string' ? [stripGroundNote(payload.content)] : Array.isArray(payload.content)
        ? payload.content.flatMap((block: { kind?: string; text?: string }) => block.kind === 'text' && typeof block.text === 'string' && !block.text.startsWith(GROUND_NOTE_MARK) ? [block.text] : []) : []
      for (const text of texts) {
        if (!text) continue
        const flat = flatPrompt(text)
        const command = /<command-name>([\s\S]*?)<\/command-name>/.exec(flat)?.[1]
        if (command) {
          if (builtIn(command.replace(/^\//, ''))) continue
          commandFallback ||= command
          const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(flat)?.[1]?.trim()
          if (!args) continue
          return `${command} ${args}`
        }
        const shell = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(flat)?.[1]
        if (shell) return `! ${shell}`
        if (/^(?:\s*<[a-z][\w-]*[\s>]|\[Request (?:interrupted by user|cut off)[^\]]*\])/.test(flat)) continue
        return clippedPrompt(flat)
      }
    } catch (error) { passedOver(error) }
  }
  return commandFallback
}

function firstField(head: string, field: string): unknown {
  for (const line of head.split('\n').slice(0, 80)) {
    if (!line.includes(`"${field}"`)) continue
    try {
      const record = JSON.parse(line)
      if (record && typeof record === 'object' && field in record) return record[field]
    } catch (error) { passedOver(error) }
  }
  return undefined
}
function isConversationActivityRecord(record: Record<string, unknown>): boolean {
  const payload = record.payload
  if (payload === null || typeof payload !== 'object') return false
  const kind = (payload as { kind?: unknown }).kind
  if (kind === 'output') return true
  if (kind === 'session-meta') return (payload as { metaKind?: unknown }).metaKind === 'turn-end'
  if (kind !== 'input') return false
  const annotations = record.annotations
  if (annotations !== null && typeof annotations === 'object') {
    const a = annotations as { isMeta?: unknown; hiddenFromTranscript?: unknown; isVirtual?: unknown }
    if (a.isMeta === true || a.hiddenFromTranscript === true || a.isVirtual === true) return false
  }
  const meta = (payload as { meta?: unknown }).meta
  if (meta !== null && typeof meta === 'object') {
    const m = meta as { isMeta?: unknown; hiddenFromTranscript?: unknown; isVirtual?: unknown }
    if (m.isMeta === true || m.hiddenFromTranscript === true || m.isVirtual === true) return false
  }
  return true
}

export function lastConversationActivityMs(tail: string): number | null {
  if (!tail) return null
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (!line || line.charCodeAt(0) !== 123) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      passedOver(error)
      continue
    }
    if (parsed === null || typeof parsed !== 'object') continue
    const record = parsed as Record<string, unknown>
    if (!isConversationActivityRecord(record)) continue
    if (typeof record.occurredAt !== 'string') continue
    const ms = Date.parse(record.occurredAt)
    if (Number.isFinite(ms)) return ms
  }
  return null
}

function sessionLastUsedMs(tail: string, mtimeMs: number): number {
  return lastConversationActivityMs(tail) ?? Math.floor(mtimeMs)
}

export function readSessionLastUsedMsSync(filePath: string, mtimeMs: number): number {
  return sessionLastUsedMs(readTranscriptTailSync(filePath, LITE_READ_BUF_SIZE), mtimeMs)
}

export function compareSessionRecency(
  a: { lastUsedMs: number; mtimeMs: number; createdMs?: number; sessionId?: string },
  b: { lastUsedMs: number; mtimeMs: number; createdMs?: number; sessionId?: string },
): number {
  if (b.lastUsedMs !== a.lastUsedMs) return b.lastUsedMs - a.lastUsedMs
  const ma = Math.floor(a.mtimeMs)
  const mb = Math.floor(b.mtimeMs)
  if (mb !== ma) return mb - ma
  if (a.createdMs !== undefined && b.createdMs !== undefined) {
    const ca = Math.floor(a.createdMs)
    const cb = Math.floor(b.createdMs)
    if (cb !== ca) return cb - ca
  }
  return (a.sessionId ?? '').localeCompare(b.sessionId ?? '')
}

function sessionLabelFacts(head: string, tail: string, builtIn: (name: string) => boolean) {
  const first = (field: string) => extractJsonStringField(head, field)
  const last = (field: string) => extractLastJsonStringField(tail, field)
  const cwd = firstField(head, 'cwd')
  let prNumber = parseInt(last('prNumber') ?? '', 10) || undefined
  if (!prNumber) {
    const index = tail.lastIndexOf('"prNumber":')
    if (index >= 0) {
      const numeric = parseInt(tail.slice(index + 11, index + 25).trim(), 10)
      if (numeric > 0) prNumber = numeric
    }
  }
  return {
    firstPrompt: sessionPromptFromWindow(head, builtIn) || last('lastPrompt') || '',
    gitBranch: last('gitBranch') ?? first('gitBranch'),
    isSidechain: firstField(head, 'isSidechain') === true,
    projectPath: typeof cwd === 'string' && cwd ? cwd : first('cwd'),
    customTitle: last('customTitle') ?? extractLastJsonStringField(head, 'customTitle') ?? last('aiTitle') ?? extractLastJsonStringField(head, 'aiTitle'),
    summary: last('summary'),
    tag: last('tag'),
    agentSetting: first('agentSetting'),
    prNumber,
    prUrl: last('prUrl'),
    prRepository: last('prRepository'),
    endedOnError: scanTailForEndedOnError(tail),
    lastTimestamp: last('timestamp') ?? first('timestamp'),
    lastUsedAt: lastConversationActivityMs(tail) ?? undefined,
  }
}

export async function readSessionLabelFacts(
  filePath: string,
  fileSize: number,
  buffer: Buffer,
  builtIn: (name: string) => boolean,
  onReadError?: (path: string, error: unknown) => void,
) {
  const { head, tail } = await readHeadAndTail(filePath, fileSize, buffer, onReadError)
  return head ? sessionLabelFacts(head, tail, builtIn) : { firstPrompt: '', isSidechain: false }
}
