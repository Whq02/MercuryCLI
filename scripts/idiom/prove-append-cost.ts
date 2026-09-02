#!/usr/bin/env bun
// ============================================================================
//  scripts/idiom/prove-append-cost.ts — win (c): production append is
//  O(new records), proven by visited-message instrumentation rather than
//  wall clock. The QueryEngine delta recorder submits only the un-recorded
//  tail with the threaded parent hint; this prover drives the SAME writer
//  contract (slice + startingParentUuidHint) and pins:
//    §A a 300-append session visits ~300 messages TOTAL (linear), never the
//       ~45,150 a full-array-per-append pattern visits (quadratic);
//    §B the parent chain stays intact across delta submissions (each new
//       message chains to the previous — no forks from the slice pattern).
// ============================================================================
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'idiom-append-cost-'))
process.env.MERCURY_CONFIG_DIR = HOME

await import('../../src/tasks.js')
const { recordTranscript, getTranscriptMessagesVisited, getProject, setSessionFileForTesting } = await import(
  '../../src/utils/sessionStorage/writer.js'
)
const { createUserMessage } = await import('../../src/utils/messages/factories.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const N = 300
const file = join(HOME, 'append-cost.jsonl')
setSessionFileForTesting(file)

const before = getTranscriptMessagesVisited()
let hint: string | undefined
for (let i = 0; i < N; i++) {
  const msg = createUserMessage({ content: `turn ${i}` })
  const parent = await recordTranscript([msg] as never, undefined, hint as never)
  if (parent) hint = parent as string
}
await getProject().flush()
const visited = getTranscriptMessagesVisited() - before

console.log(`\n  visited=${visited} for ${N} appends (quadratic would be ${(N * (N + 1)) / 2})`)
check(`§A visited is O(new): ${visited} ≤ 2×${N}`, visited <= 2 * N, String(visited))

const { decodeTranscriptBuffer } = await import('../../src/fabric/transcriptDecode.js')
const lines = decodeTranscriptBuffer<{ type?: string; uuid: string; parentUuid: string | null }>(
  readFileSync(file),
).entries.filter(l => l.type === 'user')
check(`§B all ${N} messages landed once`, lines.length === N, String(lines.length))
let chained = true
for (let i = 1; i < lines.length; i++) {
  if (lines[i]!.parentUuid !== lines[i - 1]!.uuid) { chained = false; break }
}
check('§B the parent chain is intact across delta submissions (no forks)', chained)

console.log(failures === 0 ? '\n ✅ APPEND COST O(new) PROVEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
