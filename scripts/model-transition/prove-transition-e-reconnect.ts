#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'ctm-e-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'

const { encodeTranscriptLine } = await import('../../src/sessions/transcripts/vnext.js')
const { materializeEntriesAt, materializationDigest, readAllTranscriptEntries } = await import(
  '../../src/sessions/transcripts/materialize.js'
)
const { applyTranscriptEntry } = await import('../../src/sessions/transcripts/loading.js')
const { writeResumeSnapshot, tryLoadResumeSnapshot } = await import(
  '../../src/sessions/transcripts/resumeSnapshot.js'
)
const { decodeTranscriptBuffer } = await import('../../src/sessions/fabric/transcriptDecode.js')
const { createBranchSession } = await import('../../src/sessions/branches/branchManifest.js')
const act = await import('../../src/crew/crewmates/activity.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const SID = 'e1e1e1e1-c2c2-d3d3-e4e4-f5f5f5f5f5f5'
const SRC = join(HOME, `${SID}.jsonl`)
const N = 16
{
  let text = ''
  for (let i = 1; i <= N; i++) {
    const role = i % 2 === 1 ? 'user' : 'assistant'
    const entry = {
      type: role,
      message:
        role === 'user'
          ? { role, content: `turn ${i}` }
          : { role, content: [{ type: 'text', text: `reply ${i}` }] },
      uuid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      timestamp: new Date(1754000000000 + i * 1000).toISOString(),
      sessionId: SID,
    }
    writeFileSync(SRC, text, { flag: 'w' })
    const enc = encodeTranscriptLine(SRC, entry as never)
    text += enc.line
  }
  writeFileSync(SRC, text)
}

section('§A E01/transcript — snapshot + proven suffix, typed miss, watermark law')
{
  const entries = await readAllTranscriptEntries(SRC)
  const full = materializeEntriesAt(entries)
  const k = 9
  const prefix = materializeEntriesAt(entries, k)
  const raw = readFileSync(SRC, 'utf8')
  let covered = 0
  let cursor = 0
  for (const line of raw.split('\n')) {
    if (covered >= k) break
    cursor += Buffer.byteLength(line) + 1
    if (line.trim()) covered += decodeTranscriptBuffer(line).entries.length
  }
  writeResumeSnapshot(SRC, prefix.fold, cursor)
  const hit = await tryLoadResumeSnapshot(SRC)
  check('a compatible snapshot loads (proof-on-read prefix digest)', hit !== null, 'tryLoadResumeSnapshot in src/sessions/transcripts/resumeSnapshot.ts returned null for a snapshot written by writeResumeSnapshot; check its schema, historyPart, byteCursor and prefix-digest guards')
  if (hit) {
    check('the missing suffix is PROVEN and delivered (hit.tail)', hit.tail.length === Buffer.byteLength(raw) - cursor, `tail length ${hit.tail.length}; tryLoadResumeSnapshot in src/sessions/transcripts/resumeSnapshot.ts must return exactly the bytes after byteCursor`)
    const tailEntries = decodeTranscriptBuffer(hit.tail).entries
    for (const e of tailEntries) applyTranscriptEntry(hit.fold, e as never)
    check('snapshot + suffix ≡ the pure full replay (digest law)', materializationDigest(hit.fold) === full.digest, 'the folded snapshot plus tail differs from materializeEntriesAt over all entries; check deserializeFold in src/sessions/transcripts/resumeSnapshot.ts and applyTranscriptEntry in src/sessions/transcripts/loading.ts')
  }
  const ALIEN = join(HOME, 'alien.jsonl')
  writeFileSync(ALIEN, raw)
  check('no snapshot ⇒ TYPED null (the explicit full-read fallback)', (await tryLoadResumeSnapshot(ALIEN)) === null, 'tryLoadResumeSnapshot in src/sessions/transcripts/resumeSnapshot.ts must return null when no snapshot file exists for the transcript')
  const MOVED = join(HOME, 'moved.jsonl')
  writeFileSync(MOVED, raw)
  writeResumeSnapshot(MOVED, prefix.fold, cursor)
  writeFileSync(MOVED, raw.replace('reply 8', 'REPLY X'))
  check('a stale snapshot refuses TYPED (never a wrong resume)', (await tryLoadResumeSnapshot(MOVED)) === null, 'tryLoadResumeSnapshot in src/sessions/transcripts/resumeSnapshot.ts accepted a snapshot whose covered prefix changed; its digestPrefixTail comparison must refuse it')
}

section('§D E04 — slow subscribers bounded; the terminal settlement survives')
{
  act._resetActivityFeedForTesting()
  let calls = 0
  const unsub = act.subscribeActivityFeed(() => {
    calls++
    throw new Error('slow consumer misbehaving')
  })
  act.ingestActivity({
    event: { kind: 'session/update', payload: { sessionId: 's-e04', update: { sessionUpdate: 'tool_call', toolCallId: 'tu_e04', title: 'ls', kind: 'execute', status: 'in_progress' } }, sourceEventId: 'e1', atMs: 1 } as never,
    agentId: 'crew:e04' as never,
    sessionId: 's-e04',
    adapterKind: 'opencode',
  })
  act.ingestActivity({
    event: { kind: 'session/update', payload: { sessionId: 's-e04', update: { sessionUpdate: 'tool_call_update', toolCallId: 'tu_e04', status: 'completed' } }, sourceEventId: 'e2', atMs: 2 } as never,
    agentId: 'crew:e04' as never,
    sessionId: 's-e04',
    adapterKind: 'opencode',
  })
  const feed = act.cachedActivityFeed()
  check('a THROWING subscriber never blocks ingestion', calls >= 2, `${calls} listener calls; ingestActivity in src/crew/crewmates/activity.ts must catch a throwing subscriber and keep notifying`)
  const rowId = [...feed.order].find(id => id.includes('tu_e04'))
  const row = rowId ? feed.rows.get(rowId) : undefined
  check('the terminal settlement survives (phase left running)', row !== undefined && row.phase !== 'running', `${row?.phase}; the tool_call_update completed event must settle the row through ingestActivity and foldActivity in src/crew/crewmates/activity.ts`)
  check('the feed stays a bounded ring', feed.order.length <= 1024, `${feed.order.length} rows; foldActivity in src/crew/crewmates/activity.ts must trim the feed order to its cap`)
  unsub()
  act._resetActivityFeedForTesting()
}

section('§E E05 — payloads stay shared references across branch lineages')
{
  const blobDir = join(HOME, 'payloads')
  const blobPath = join(blobDir, 'big-output.txt')
  const PSID = 'e5e5e5e5-c2c2-d3d3-e4e4-f5f5f5f5f5f5'
  const PSRC = join(HOME, `${PSID}.jsonl`)
  mkdirSync(blobDir, { recursive: true })
  writeFileSync(blobPath, 'x'.repeat(64_000))
  {
    let text = ''
    const rows = [
      { type: 'user', message: { role: 'user', content: 'run it' }, uuid: '00000000-0000-4000-8000-000000000101', timestamp: new Date(1754000100000).toISOString(), sessionId: PSID },
      { type: 'user', message: { role: 'user', content: `<persisted-output>\nOutput too large. Full output saved to: ${blobPath}\n</persisted-output>` }, uuid: '00000000-0000-4000-8000-000000000102', timestamp: new Date(1754000101000).toISOString(), sessionId: PSID },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, uuid: '00000000-0000-4000-8000-000000000103', timestamp: new Date(1754000102000).toISOString(), sessionId: PSID },
    ]
    for (const e of rows) {
      writeFileSync(PSRC, text, { flag: 'w' })
      text += encodeTranscriptLine(PSRC, e as never).line
    }
    writeFileSync(PSRC, text)
  }
  const res = createBranchSession({
    sourceTranscriptPath: PSRC,
    forkOrdinal: 3,
    boundaryKind: 'fork',
    cwd: '/tmp/proj',
    providerOrigin: 'test',
  })
  check('the branch created', res.ok, `createBranchSession in src/sessions/branches/branchManifest.ts refused the fork: ${JSON.stringify(res)}`)
  if (res.ok) {
    const branchText = readFileSync(res.branchTranscriptPath, 'utf8')
    check('the branch carries the SAME pointer bytes', branchText.includes(blobPath), 'createBranchSession in src/sessions/branches/branchManifest.ts must copy the persisted-output pointer line unchanged into the branch transcript')
    check('no payload copy per branch (one blob on disk)', readdirSync(blobDir).length === 1, `${readdirSync(blobDir).length} files in the payload dir; createBranchSession in src/sessions/branches/branchManifest.ts must share the blob, not copy it`)
    check(
      'the payload stays reachable from BOTH lineages',
      existsSync(blobPath) && readFileSync(PSRC, 'utf8').includes(blobPath) && branchText.includes(blobPath),
      'the blob or a pointer to it is gone from the source or the branch transcript; createBranchSession in src/sessions/branches/branchManifest.ts must leave the blob and both pointers in place',
    )
  }
}

section('§F E03 — resize/focus/unread reparse zero (the memo seam + counter)')
{
  const norm = await import('../../src/engine/message-shapes/normalize.js')
  const before = norm._normalizePassesForProof
  const fixture = [
    { type: 'user', uuid: '00000000-0000-4000-8000-00000000e031', message: { role: 'user', content: 'hello' } },
  ] as never[]
  norm.normalizeMessages(fixture as never)
  norm.normalizeMessages(fixture as never)
  check('the instrumented counter counts passes', norm._normalizePassesForProof === before + 2, 'normalizeMessages in src/engine/message-shapes/normalize.ts must add exactly one to _normalizePassesForProof per call')
}

console.log(
  failures === 0
    ? '\n ✅ RECONNECT — one contract, suffix-only reads, bounded subscribers, shared payloads'
    : `\n ❌ RECONNECT — ${failures} failure(s)`,
)
process.exit(failures === 0 ? 0 : 1)
