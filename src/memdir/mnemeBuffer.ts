


import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { logForDebugging } from '../utils/debug.js'
import { mnemeEnabled, mnemeLibraryDir } from './mnemeGates.js'
import { estimateTokens } from './mnemeTopicDocs.js'

export interface MnemeObservation {
  ts: string
  source: string
  text: string
  topicHint?: string
}

const CAP = { text: 2000, source: 60, topicHint: 60 } as const
const clamp = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ')
const sigSafe = (s: string): string => s.replace(/[,<>\r\n]+/g, '-')

export function currentBufferPath(dir: string = mnemeLibraryDir()): string {
  return join(dir, 'current.jsonl')
}

export function appendObservation(
  input: { text: string; source: string; topicHint?: string },
  dir: string = mnemeLibraryDir(),
): boolean {
  if (!mnemeEnabled()) return false
  try {
    const text = clamp(oneLine(String(input.text ?? '')).trim(), CAP.text)
    const source = clamp(sigSafe(String(input.source ?? '')).trim(), CAP.source)
    if (!text || !source) return false
    const row: MnemeObservation = {
      ts: new Date().toISOString(),
      source,
      text,
      ...(input.topicHint ? { topicHint: clamp(String(input.topicHint).trim(), CAP.topicHint) } : {}),
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
  if (!existsSync(p)) return []
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
  } catch {
    return []
  }
  return out
}

export function bufferTokens(dir: string = mnemeLibraryDir()): number {
  return readBuffer(dir).reduce((n, r) => n + estimateTokens(r.text), 0)
}

export function readConsumingRows(dir: string = mnemeLibraryDir()): MnemeObservation[] {
  const out: MnemeObservation[] = []
  let names: string[] = []
  try {
    names = readdirSync(dir).filter(n => /^consuming-.*\.jsonl$/.test(n)).sort()
  } catch {
    return []
  }
  for (const name of names) {
    try {
      for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const row = JSON.parse(line) as MnemeObservation
          if (typeof row?.text === 'string' && typeof row?.source === 'string' && typeof row?.ts === 'string') out.push(row)
        } catch {
          logForDebugging('mneme readConsumingRows: skipped malformed row')
        }
      }
    } catch {
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
