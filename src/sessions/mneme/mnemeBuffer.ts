
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { isENOENT } from '../../platform/errors/errors.js'
import { mnemeEnabled, mnemeLibraryDir } from './mnemeGates.js'
import { estimateTokens } from './mnemeTopicDocs.js'
import { clearMnemeUnread, clearMnemeUnreadWhere, recordMnemeUnread } from './mnemeUnread.js'
import { validatedApplicability, type MemoryApplicability } from './memoryApplicability.js'
import { passedOver } from '../../platform/errors/passedOver.js'

export interface MnemeObservation {
  ts: string
  source: string
  text: string
  topicHint?: string
  pin?: true
  asked?: true
  applicability?: MemoryApplicability
  replaces?: number
  history?: PendingHistory
}

interface PendingHistory {
  ts: string
  text: string
}

function validatedHistory(input: unknown): PendingHistory | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const { ts, text } = input as Record<string, unknown>
  if (typeof ts !== 'string' || typeof text !== 'string' || !ts.trim() || !text.trim()) return undefined
  return { ts, text: clamp(text, OBSERVATION_TEXT_LIMIT) }
}

const OBSERVATION_TEXT_LIMIT = 2000
const CAP = { source: 60, topicHint: 60 } as const
const clamp = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const withThousands = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ')
const sigSafe = (s: string): string => s.replace(/[,<>\r\n]+/g, '-')

export function observationText(text: string): string {
  return oneLine(String(text ?? '')).trim()
}

export function observationOverflow(text: string): string | null {
  const chars = observationText(text).length
  if (chars <= OBSERVATION_TEXT_LIMIT) return null
  return `${withThousands(chars)} characters; the limit is ${withThousands(OBSERVATION_TEXT_LIMIT)} per fact — split it into facts under the limit`
}

export function currentBufferPath(dir: string = mnemeLibraryDir()): string {
  return join(dir, 'current.jsonl')
}

let lastObservationMs = 0

function observationStamp(): string {
  const now = Math.max(Date.now(), lastObservationMs + 1)
  lastObservationMs = now
  return new Date(now).toISOString()
}

export function appendObservation(
  input: { text: string; source: string; topicHint?: string; pin?: boolean; asked?: boolean; replaces?: number; applicability?: MemoryApplicability; history?: PendingHistory },
  dir: string = mnemeLibraryDir(),
): boolean {
  if (!mnemeEnabled()) return false
  try {
    const text = observationText(input.text)
    const source = clamp(sigSafe(String(input.source ?? '')).trim(), CAP.source)
    if (!text || !source || text.length > OBSERVATION_TEXT_LIMIT) return false
    const replaces = input.pin === true && Number.isInteger(input.replaces) && (input.replaces as number) > 0 ? { replaces: input.replaces as number } : {}
    const row: MnemeObservation = {
      ts: observationStamp(),
      source,
      text,
      ...(input.topicHint ? { topicHint: clamp(String(input.topicHint).trim(), CAP.topicHint) } : {}),
      ...(input.pin === true ? { pin: true as const } : {}),
      ...(input.pin === true && input.asked === true ? { asked: true as const } : {}),
      ...replaces,
      ...(input.pin && input.asked && validatedApplicability(input.applicability) ? { applicability: validatedApplicability(input.applicability) } : {}),
      ...(validatedHistory(input.history) ? { history: validatedHistory(input.history) } : {}),
    }
    mkdirSync(dir, { recursive: true })
    appendFileSync(currentBufferPath(dir), JSON.stringify(row) + '\n', 'utf8')
    return true
  } catch (e) {
    logForDebugging(`mneme appendObservation failed: ${String(e)}`)
    return false
  }
}

export function readBuffer(dir: string = mnemeLibraryDir()): MnemeObservation[] {
  const p = currentBufferPath(dir)
  if (!existsSync(p)) {
    clearMnemeUnread(p)
    return []
  }
  const out: MnemeObservation[] = []
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line) as MnemeObservation
        if (typeof row?.text === 'string' && typeof row?.source === 'string' && typeof row?.ts === 'string') {
          out.push(row)
        }
      } catch {
        logForDebugging('mneme readBuffer: skipped malformed row')
      }
    }
    clearMnemeUnread(p)
  } catch (error) {
    if (isENOENT(error)) clearMnemeUnread(p)
    else recordMnemeUnread(p, error)
    passedOver(error)
    return []
  }
  return out
}

export function bufferTokens(dir: string = mnemeLibraryDir()): number {
  return readBuffer(dir).reduce((n, r) => n + estimateTokens(r.text), 0)
}

export function readConsumingRows(dir: string = mnemeLibraryDir()): MnemeObservation[] {
  const out: MnemeObservation[] = []
  const resolvedDir = resolve(dir)
  const dirPrefix = resolvedDir.endsWith(sep) ? resolvedDir : `${resolvedDir}${sep}`
  let names: string[] = []
  try {
    names = readdirSync(dir).filter(n => /^consuming-.*\.jsonl$/.test(n)).sort()
    clearMnemeUnread(dir)
  } catch (error) {
    if (isENOENT(error)) {
      clearMnemeUnread(dir)
      clearMnemeUnreadWhere(key => key.startsWith(dirPrefix) && /^consuming-.*\.jsonl$/.test(key.slice(dirPrefix.length)))
    } else {
      recordMnemeUnread(dir, error)
    }
    passedOver(error)
    return []
  }
  const present = new Set(names.map(name => resolve(join(dir, name))))
  clearMnemeUnreadWhere(key => key.startsWith(dirPrefix) && /^consuming-.*\.jsonl$/.test(key.slice(dirPrefix.length)) && !present.has(key))
  for (const name of names) {
    const filePath = join(dir, name)
    try {
      for (const line of readFileSync(filePath, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const row = JSON.parse(line) as MnemeObservation
          if (typeof row?.text === 'string' && typeof row?.source === 'string' && typeof row?.ts === 'string') out.push(row)
        } catch {
          logForDebugging('mneme readConsumingRows: skipped malformed row')
        }
      }
      clearMnemeUnread(filePath)
    } catch (error) {
      if (isENOENT(error)) clearMnemeUnread(filePath)
      else recordMnemeUnread(filePath, error)
      passedOver(error)
    }
  }
  return out
}

export function pendingRows(dir: string = mnemeLibraryDir()): MnemeObservation[] {
  const consuming = readConsumingRows(dir)
  const current = readBuffer(dir)
  return consuming.length === 0 ? current : [...consuming, ...current]
}

export function recentObservations(n: number, dir: string = mnemeLibraryDir()): MnemeObservation[] {
  const rows = pendingRows(dir)
  return rows.slice(Math.max(0, rows.length - n))
}
