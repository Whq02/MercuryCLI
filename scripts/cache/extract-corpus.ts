#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..')
const transcriptsArg = process.argv.indexOf('--transcripts')
const transcriptDir = transcriptsArg >= 0 ? process.argv[transcriptsArg + 1] : undefined
if (!transcriptDir) {
  console.error('usage: bun run scripts/cache/extract-corpus.ts --transcripts <dir-of-session-jsonls>')
  process.exit(1)
}

interface CorpusEvent {
  d: number
  p: number
  o: number
}
interface CorpusSession {
  id: string
  startMs: number
  events: CorpusEvent[]
}

const MIN_EVENTS = 5
const sessions: CorpusSession[] = []
let rowsSeen = 0

for (const f of readdirSync(transcriptDir).filter(f => f.endsWith('.jsonl'))) {
  let raw: string
  try {
    raw = readFileSync(join(transcriptDir, f), 'utf8')
  } catch {
    continue
  }
  const points: { t: number; p: number; o: number }[] = []
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue
    let row: {
      type?: string
      isSidechain?: boolean
      timestamp?: string
      message?: {
        usage?: {
          input_tokens?: number
          cache_read_input_tokens?: number
          cache_creation_input_tokens?: number
          output_tokens?: number
        }
      }
    }
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row.type !== 'assistant' || row.isSidechain !== false) continue
    const u = row.message?.usage
    if (!u || !row.timestamp) continue
    rowsSeen++
    const t = Date.parse(row.timestamp)
    const p =
      (u.input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0)
    if (!Number.isFinite(t) || p <= 0) continue
    points.push({ t, p, o: u.output_tokens ?? 0 })
  }
  if (points.length < MIN_EVENTS) continue
  points.sort((a, b) => a.t - b.t)
  const round16 = (n: number): number => Math.round(n / 16) * 16
  const events: CorpusEvent[] = points.map((pt, i) => ({
    d: i === 0 ? 0 : Math.round((pt.t - points[i - 1]!.t) / 250) * 250,
    p: round16(pt.p),
    o: round16(pt.o),
  }))
  sessions.push({
    id: createHash('sha256').update(f).digest('hex').slice(0, 12),
    startMs: points[0]!.t,
    events,
  })
}

sessions.sort((a, b) => a.startMs - b.startMs)

const outDir = join(root, 'docs', 'benchmarks', 'cache-clock')
mkdirSync(outDir, { recursive: true })
const corpus = {
  v: 1,
  name: 'cache-clock-corpus-v1',
  extractedIso: new Date().toISOString(),
  project: 'orchard-src',
  note: 'shape-only real-session traces: per main-chain assistant message, {d: ms since previous, p: prompt tokens, o: output tokens}; ids hashed, tokens rounded to 16, dt to 250ms',
  sessions,
}
const outPath = join(outDir, 'corpus.json')
writeFileSync(outPath, JSON.stringify(corpus))

const requests = sessions.reduce((n, s) => n + s.events.length, 0)
const spanDays =
  sessions.length > 0
    ? (sessions[sessions.length - 1]!.startMs - sessions[0]!.startMs) / 86_400_000
    : 0
console.log(
  `corpus: ${sessions.length} sessions, ${requests} requests (rows seen ${rowsSeen}), span ${spanDays.toFixed(1)}d → ${outPath}`,
)
