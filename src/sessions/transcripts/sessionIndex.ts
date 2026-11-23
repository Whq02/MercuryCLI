import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { stripGroundNote, GROUND_NOTE_MARK } from './isolationNote.js'
import { sliceHeadAtGrapheme } from '../../platform/text/textSegments.js'
import {
  extractJsonStringField,
  extractLastJsonStringField,
  readHeadAndTail,
  scanTailForEndedOnError,
  validateUuid,
} from './sessionStoragePortable.js'
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

export function sessionPromptFromWindow(chunk: string, builtIn: (name: string) => boolean = () => true, portable = false): string {
  let commandFallback = ''
  for (const line of chunk.split('\n')) {
    if (!/"kind":\s*"input"/.test(line) || line.includes('"tool_result"') || /"isMeta":\s*true/.test(line)) continue
    if (portable && (!line.includes('"kind":"input"') || line.includes('"kind":"tool-result"') || /"isCompactSummary":\s*true/.test(line))) continue
    try {
      const record = JSON.parse(line)
      const payload = record.payload
      if (payload?.kind !== 'input' || (portable && typeof record.schemaVersion !== 'number')) continue
      const meta = payload.meta ?? {}
      if (!portable && (meta.hiddenFromTranscript === true || meta.isVirtual === true || meta.isCompactSummary === true || meta.toolUseResult !== undefined)) continue
      const texts = typeof payload.content === 'string' ? [stripGroundNote(payload.content)] : Array.isArray(payload.content)
        ? payload.content.flatMap((block: { kind?: string; text?: string }) => block.kind === 'text' && typeof block.text === 'string' && (portable || !block.text.startsWith(GROUND_NOTE_MARK)) ? [portable ? stripGroundNote(block.text) : block.text] : []) : []
      for (const text of texts) {
        if (!text) continue
        const flat = flatPrompt(text)
        if (portable && (flat === '' || /^\s*<[a-z]/.test(flat) && !flat.includes('<command-name>') && !flat.includes('<bash-input>'))) continue
        const command = /<command-name>([\s\S]*?)<\/command-name>/.exec(flat)?.[1]
        if (command) {
          commandFallback ||= command
          const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(flat)?.[1]?.trim()
          if (builtIn(command.replace(/^\//, '')) || !args) continue
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
