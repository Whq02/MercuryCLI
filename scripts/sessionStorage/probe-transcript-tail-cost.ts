#!/usr/bin/env bun
// ============================================================================
//  scripts/sessionStorage/probe-transcript-tail-cost.ts — the measurement
//  behind the transcript reader: what one growth of a large transcript
//  costs the readers, before (the kill switch: every read is the cold
//  ladder — the old behaviour) and after (the reader folds the appended
//  bytes). A measurement, not a gate: it prints, it never fails.
//
//  The transcript is BUILT in a scratch directory through the writer's own
//  encoder — never an operator's file (a read may refresh the resume
//  snapshot beside the transcript it reads).
//
//    bun run scripts/sessionStorage/probe-transcript-tail-cost.ts [MB] [growths]
// ============================================================================
import { appendFileSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(tmpdir(), 'transcript-probe-home-'))
const SCRATCH = mkdtempSync(join(tmpdir(), 'transcript-probe-'))
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
delete process.env.MERCURY_TRANSCRIPT_READER
delete process.env.MERCURY_RESUME_SNAPSHOT

const reader = await import('../../src/utils/sessionStorage/transcriptReader.ts')
const loading = await import('../../src/utils/sessionStorage/loading.ts')
const vnext = await import('../../src/utils/sessionStorage/vnext.ts')

const targetMb = Number(process.argv[2] ?? '5')
const growths = Number(process.argv[3] ?? '20')
const SID = '00000000-aaaa-4000-8000-00000000f00d'
let n = 0
const uid = (): string => `00000000-0000-4000-8000-${String(100000000000 + ++n).slice(1)}`
let clock = Date.parse('2026-01-01T00:00:00.000Z')
const encode = (file: string, entry: Record<string, unknown>): string =>
  (vnext.encodeTranscriptLine(file, entry) as { line: string }).line
const base = (uuid: string, parent: string | null): Record<string, unknown> => ({
  uuid,
  parentUuid: parent,
  isSidechain: false,
  userType: 'external',
  cwd: SCRATCH,
  sessionId: SID,
  version: '1.0.0',
  timestamp: new Date((clock += 1000)).toISOString(),
})
const turn = (file: string, parent: string | null, pad: number): string => {
  const u = uid()
  appendFileSync(file, encode(file, { ...base(u, parent), type: 'user', message: { role: 'user', content: `ask ${'u'.repeat(pad)}` } }))
  const a = uid()
  appendFileSync(
    file,
    encode(file, {
      ...base(a, u),
      type: 'assistant',
      message: {
        id: `msg_${a.slice(-6)}`,
        role: 'assistant',
        model: 'm',
        stop_reason: 'end_turn',
        stop_sequence: null,
        content: [{ type: 'text', text: `reply ${'a'.repeat(pad * 3)}` }],
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }),
  )
  return a
}

const file = join(SCRATCH, `${SID}.jsonl`)
writeFileSync(file, '')
let leaf: string | null = null
while (statSync(file).size < targetMb * 1024 * 1024) leaf = turn(file, leaf, 400)
const seedSize = statSync(file).size
console.log(`transcript: ${(seedSize / 1024 / 1024).toFixed(2)} MB, ${n} records, ${growths} growths of one turn each\n`)

type Row = { road: string; ask: string; wallMs: number; perGrowthMs: number; bytesRead: number; coldReads: number; growthReads: number }
const rows: Row[] = []
const census = reader.transcriptReaderCensus
const zero = (): void => {
  census.coldReads = 0
  census.growthReads = 0
  census.resets = 0
  census.bytesRead = 0
  census.chainDerivations = 0
}

async function measure(road: string, ask: string, one: () => Promise<unknown>): Promise<void> {
  reader._resetTranscriptReaderForTesting()
  // The first read is the cold one on both roads; it is not the growth cost.
  await one()
  zero()
  const t0 = performance.now()
  for (let g = 0; g < growths; g++) {
    leaf = turn(file, leaf, 400)
    await one()
  }
  const wallMs = performance.now() - t0
  rows.push({ road, ask, wallMs, perGrowthMs: wallMs / growths, bytesRead: census.bytesRead, coldReads: census.coldReads, growthReads: census.growthReads })
}

const chainAsk = (): (() => Promise<unknown>) => {
  let cursor: Awaited<ReturnType<typeof reader.readTranscriptChainSince>>['cursor'] | null = null
  return async () => {
    const r = await reader.readTranscriptChainSince(file, cursor)
    cursor = r.cursor
    return r
  }
}

process.env.MERCURY_TRANSCRIPT_READER = '0'
await measure('before (reader off)', 'loadTranscriptFile', () => loading.loadTranscriptFile(file))
await measure('before (reader off)', 'chain since cursor', chainAsk())
delete process.env.MERCURY_TRANSCRIPT_READER
await measure('after (reader on)', 'loadTranscriptFile', () => loading.loadTranscriptFile(file))
await measure('after (reader on)', 'chain since cursor', chainAsk())

const finalSize = statSync(file).size
console.log(`file after the growths: ${(finalSize / 1024 / 1024).toFixed(2)} MB\n`)
const pad = (s: string, w: number): string => s.padEnd(w)
console.log(`${pad('road', 20)}${pad('ask', 20)}${pad('per growth', 14)}${pad('bytes read', 16)}${pad('cold', 6)}growth`)
for (const r of rows) {
  console.log(`${pad(r.road, 20)}${pad(r.ask, 20)}${pad(`${r.perGrowthMs.toFixed(2)} ms`, 14)}${pad(`${(r.bytesRead / 1024 / 1024).toFixed(2)} MB`, 16)}${pad(String(r.coldReads), 6)}${r.growthReads}`)
}
const before = rows.find(r => r.road.startsWith('before') && r.ask === 'chain since cursor')!
const after = rows.find(r => r.road.startsWith('after') && r.ask === 'chain since cursor')!
console.log(`\nthe chat's ask per growth: ${before.perGrowthMs.toFixed(2)} ms → ${after.perGrowthMs.toFixed(2)} ms (${(before.perGrowthMs / Math.max(after.perGrowthMs, 0.001)).toFixed(0)}×), bytes ${(before.bytesRead / 1024 / 1024).toFixed(1)} MB → ${(after.bytesRead / 1024).toFixed(0)} KB over ${growths} growths`)
