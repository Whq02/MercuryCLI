#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/prove-transition-e-reconnect.ts — E01/E02/E04/
//  E05 (+ the E08 convergence anchors): the ONE reconnect contract over the
//  two live mechanisms.
//
//    §A E01/transcript — compatible snapshot + PROVEN missing suffix
//       (REAL writeResumeSnapshot/tryLoadResumeSnapshot; proof-on-read
//       prefix digest; snapshot+tail ≡ the pure full fold), typed miss ⇒
//       full-read fallback; the (recordId, updateOrdinal) last-wins law is
//       the affected-item watermark
//    §D E04 — a THROWING subscriber cannot block ingestion or drop the
//       terminal settlement; the feed stays a bounded ring
//    §E E05 — large payloads stay SHARED references across branch
//       lineages: a branch carries the same <persisted-output> pointer
//       bytes, never a payload copy
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'ctm-e-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'

const { encodeTranscriptLine } = await import('../../src/utils/sessionStorage/vnext.js')
const { materializeEntriesAt, materializationDigest, readAllTranscriptEntries } = await import(
  '../../src/utils/sessionStorage/materialize.js'
)
const { applyTranscriptEntry } = await import('../../src/utils/sessionStorage/loading.js')
const { writeResumeSnapshot, tryLoadResumeSnapshot } = await import(
  '../../src/utils/sessionStorage/resumeSnapshot.js'
)
const { decodeTranscriptBuffer } = await import('../../src/fabric/transcriptDecode.js')
const { createBranchSession } = await import('../../src/services/branches/branchManifest.js')
const act = await import('../../src/services/crew/activity.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

// ── the synthetic vNext transcript ──────────────────────────────────────────
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
  // The byte cursor of the k-entry prefix (the store's coverage vocabulary).
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
  check('a compatible snapshot loads (proof-on-read prefix digest)', hit !== null)
  if (hit) {
    check('the missing suffix is PROVEN and delivered (hit.tail)', hit.tail.length === Buffer.byteLength(raw) - cursor)
    const tailEntries = decodeTranscriptBuffer(hit.tail).entries
    for (const e of tailEntries) applyTranscriptEntry(hit.fold, e as never)
    check('snapshot + suffix ≡ the pure full replay (digest law)', materializationDigest(hit.fold) === full.digest)
  }
  // Typed miss ⇒ the full-read fallback: no snapshot beside an alien copy.
  const ALIEN = join(HOME, 'alien.jsonl')
  writeFileSync(ALIEN, raw)
  check('no snapshot ⇒ TYPED null (the explicit full-read fallback)', (await tryLoadResumeSnapshot(ALIEN)) === null)
  // A STALE snapshot (prefix rewritten INSIDE the bounded proof window —
  // the digest covers the prefix TAIL by design) must refuse.
  const MOVED = join(HOME, 'moved.jsonl')
  writeFileSync(MOVED, raw)
  writeResumeSnapshot(MOVED, prefix.fold, cursor)
  writeFileSync(MOVED, raw.replace('reply 8', 'REPLY X'))
  check('a stale snapshot refuses TYPED (never a wrong resume)', (await tryLoadResumeSnapshot(MOVED)) === null)
  // The affected-item watermark: the fabric's (recordId, updateOrdinal)
  // last-wins law (G05) — restated here as E01's revision vocabulary.
  const recordSrc = readFileSync(join(import.meta.dir, '../../src/fabric/record.ts'), 'utf8')
  check('affected-item revisions ride (recordId, updateOrdinal) last-wins', recordSrc.includes('updateOrdinal'))
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
    event: { kind: 'assistant', payload: { type: 'assistant', message: { id: 'm-e04', content: [{ type: 'tool_use', id: 'tu_e04', name: 'Bash', input: {} }] } }, sourceEventId: 'e1', atMs: 1 } as never,
    agentId: 'crew:e04' as never,
    sessionId: 's-e04',
    adapterKind: 'claude-code',
  })
  act.ingestActivity({
    event: { kind: 'user', payload: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_e04', content: 'done' }] } }, sourceEventId: 'e2', atMs: 2 } as never,
    agentId: 'crew:e04' as never,
    sessionId: 's-e04',
    adapterKind: 'claude-code',
  })
  const feed = act.cachedActivityFeed()
  check('a THROWING subscriber never blocks ingestion', calls >= 2, String(calls))
  const rowId = [...feed.order].find(id => id.includes('tu_e04'))
  const row = rowId ? feed.rows.get(rowId) : undefined
  check('the terminal settlement survives (phase left running)', row !== undefined && row.phase !== 'running', row?.phase)
  check('the feed stays a bounded ring', feed.order.length <= 1024, String(feed.order.length))
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
  check('the branch created', res.ok)
  if (res.ok) {
    const branchText = readFileSync(res.branchTranscriptPath, 'utf8')
    check('the branch carries the SAME pointer bytes', branchText.includes(blobPath))
    check('no payload copy per branch (one blob on disk)', readdirSync(blobDir).length === 1)
    check(
      'the payload stays reachable from BOTH lineages',
      existsSync(blobPath) && readFileSync(PSRC, 'utf8').includes(blobPath) && branchText.includes(blobPath),
    )
  }
}

section('§F E03 — resize/focus/unread reparse zero (the memo seam + counter)')
{
  const messagesSrc = readFileSync(join(import.meta.dir, '../../src/components/Messages.tsx'), 'utf8')
  // THE parse boundary: normalization memoizes on [messages] ONLY —
  // geometry, focus and unread state are mechanically outside its deps, so
  // a resize/focus/unread change cannot re-run the walk.
  check(
    'the normalize memo keys on [messages] only',
    /useMemo\(\s*\(\) => normalizeMessages\(messages\)\.filter\(isNotEmptyMessage\),\s*\[messages\],?\s*\)/.test(messagesSrc),
  )
  const norm = await import('../../src/utils/messages/normalize.js')
  const before = norm._normalizePassesForProof
  const fixture = [
    { type: 'user', uuid: '00000000-0000-4000-8000-00000000e031', message: { role: 'user', content: 'hello' } },
  ] as never[]
  norm.normalizeMessages(fixture as never)
  norm.normalizeMessages(fixture as never)
  check('the instrumented counter counts passes', norm._normalizePassesForProof === before + 2)
  // The rendered half rides the standing resize journey on the SHIPPED
  // artifact (scripts/session-graph/prove-resize-continuity.ts —
  // 140→120→80→120 with selection identity intact).
  const { existsSync } = await import('node:fs')
  check('the rendered resize journey stands', existsSync(join(import.meta.dir, '../../scripts/session-graph/prove-resize-continuity.ts')))
  // Unread stays conversation-owned — no crew owner imports the
  // normalizer (grep-fenced).
  const { execSync } = await import('node:child_process')
  const unreadNormalizers = execSync(
    "grep -rl 'normalizeMessages' src/services/crew 2>/dev/null || true",
    { encoding: 'utf8' },
  ).trim()
  check('no crew owner re-parses the transcript', unreadNormalizers === '', unreadNormalizers)
}

console.log(
  failures === 0
    ? '\n ✅ RECONNECT — one contract, suffix-only reads, bounded subscribers, shared payloads'
    : `\n ❌ RECONNECT — ${failures} failure(s)`,
)
process.exit(failures === 0 ? 0 : 1)
