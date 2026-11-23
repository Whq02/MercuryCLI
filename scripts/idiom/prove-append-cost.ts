#!/usr/bin/env bun
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'idiom-append-cost-'))
process.env.MERCURY_CONFIG_DIR = HOME

await import('../../src/engine/tasks/tasks.js')
const { recordTranscript, getTranscriptMessagesVisited, getProject, setSessionFileForTesting } = await import(
  '../../src/sessions/transcripts/writer.js'
)
const { createUserMessage } = await import('../../src/engine/message-shapes/factories.js')

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
check(`§A visited is O(new): ${visited} ≤ 2×${N}`, visited <= 2 * N, `${visited}; recordTranscript in src/sessions/transcripts/writer.ts must count only the messages passed to it per append, so find the code path there that walks the whole transcript on each call and make it touch only the new messages`)

const { decodeTranscriptBuffer } = await import('../../src/sessions/fabric/transcriptDecode.js')
const lines = decodeTranscriptBuffer<{ type?: string; uuid: string; parentUuid: string | null }>(
  readFileSync(file),
).entries.filter(l => l.type === 'user')
check(`§B all ${N} messages landed once`, lines.length === N, `${lines.length}; recordTranscript in src/sessions/transcripts/writer.ts must write each new message exactly once (see partitionUnwritten and insertMessageChain there)`)
let chained = true
for (let i = 1; i < lines.length; i++) {
  if (lines[i]!.parentUuid !== lines[i - 1]!.uuid) { chained = false; break }
}
check('§B the parent chain is intact across delta submissions (no forks)', chained, 'each appended message must have the previous message uuid as parentUuid; check the parent returned by recordTranscript and the startingParentUuid it passes to insertMessageChain in src/sessions/transcripts/writer.ts')

console.log(failures === 0 ? '\n ✅ APPEND COST O(new) PROVEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
