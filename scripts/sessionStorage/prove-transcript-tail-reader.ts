#!/usr/bin/env bun
// ============================================================================
//  scripts/sessionStorage/prove-transcript-tail-reader.ts — the one
//  transcript reader: a growing transcript is read from its byte offset,
//  never whole; a rewrite resets honestly; the incremental fold equals the
//  full parse; every consumer's ask rides the same state.
//
//    §A one reader per path: a second read of an unmoved file reads no
//       bytes past a stat and hands back the SAME fold object.
//    §B an append of N rows reads only the appended bytes (plus the ≤4 KB
//       window that proves the prefix) through the injected io seam; the
//       chain since the cursor is exactly the appended rows, the rows
//       before it the cursor's own objects; an append still in flight (no
//       newline yet) folds nothing and folds whole once it completes.
//    §C a rewrite resets honestly: truncation below the offset, a replaced
//       file (new inode), a byte flip inside the window followed by an
//       append, and a removed middle line whose file still GREW — each is
//       a fresh cold read, and each equals a full parse of the rewritten
//       file. The documented non-goal is pinned too: a same-size in-place
//       rewrite with no growth is not observed (the product's own rewrite
//       roads shrink the file or replace its inode).
//    §D parity: five rounds of growth (messages, titles, tags, summaries,
//       pr-links, a collapse commit, a preserved-segment boundary) fold to
//       the same rows and facts as one full parse of the final file —
//       byte-identical chain rows, equal maps, no line folded twice; the
//       kill switch reads the same rows at the cold cost.
//    §E a torn tail counts once: the cold read states it; the growth that
//       completes it folds the whole record, or a writer's heal leaves it
//       malformed without a second statement.
//    §F retention: a retained path survives other loads; released, it
//       rides the two-deep recent list and is displaced.
//    §G the chain cursor names what moved: a revision of the tail row and
//       a rewind onto an earlier message both rewind from the moved index
//       and keep every earlier row's identity; the live-turn fold over a
//       settled prefix equals the one-shot fold.
//    §H the byte cursor and the backward walk: complete lines past an
//       offset with the carry law; newest lines first, an early stop reads
//       one window, a window cut inside a multi-byte character loses no
//       line.
//    §I the real connector: attach is one cold read; a tick after an
//       append is one growth read; unchanged rows keep their objects
//       (the calm law); detach releases the path.
// ============================================================================
import { appendFileSync, mkdtempSync, readFileSync, renameSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(tmpdir(), 'transcript-reader-home-'))
const SCRATCH = mkdtempSync(join(tmpdir(), 'transcript-reader-'))
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
delete process.env.MERCURY_TRANSCRIPT_READER
delete process.env.MERCURY_RESUME_SNAPSHOT

const reader = await import('../../src/utils/sessionStorage/transcriptReader.ts')
const loading = await import('../../src/utils/sessionStorage/loading.ts')
const vnext = await import('../../src/utils/sessionStorage/vnext.ts')
const recovery = await import('../../src/utils/conversationRecovery.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

// ── fixtures: real record lines through the writer's own encoder ───────────
const SID = '00000000-aaaa-4000-8000-00000000c0de'
let n = 0
const uid = (): string => `00000000-0000-4000-8000-${String(100000000000 + ++n).slice(1)}`
const at = (i: number): string => new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * 1000).toISOString()
const encode = (file: string, entry: Record<string, unknown>): string =>
  (vnext.encodeTranscriptLine(file, entry) as { line: string }).line
const base = (uuid: string, parent: string | null, i: number): Record<string, unknown> => ({
  uuid,
  parentUuid: parent,
  isSidechain: false,
  userType: 'external',
  cwd: SCRATCH,
  sessionId: SID,
  version: '1.0.0',
  timestamp: at(i),
})
const userLine = (file: string, uuid: string, parent: string | null, i: number, text: string): string =>
  encode(file, { ...base(uuid, parent, i), type: 'user', message: { role: 'user', content: text } })
const asstLine = (file: string, uuid: string, parent: string | null, i: number, text: string): string =>
  encode(file, {
    ...base(uuid, parent, i),
    type: 'assistant',
    message: {
      id: `msg_${uuid.slice(-6)}`,
      role: 'assistant',
      model: 'm',
      stop_reason: 'end_turn',
      stop_sequence: null,
      content: [{ type: 'text', text }],
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  })

/** A linear chain of `turns` user/assistant pairs appended to `file`
 *  (continuing from `parent`); returns the new leaf uuid. */
function appendTurns(file: string, parent: string | null, turns: number, tick: { i: number }, pad = 200): string {
  let p = parent
  for (let t = 0; t < turns; t++) {
    const u = uid()
    appendFileSync(file, userLine(file, u, p, tick.i++, `ask ${u.slice(-4)} ${'u'.repeat(pad)}`))
    const a = uid()
    appendFileSync(file, asstLine(file, a, u, tick.i++, `reply ${a.slice(-4)} ${'a'.repeat(pad)}`))
    p = a
  }
  return p!
}

const canonical = (v: unknown): unknown => {
  if (v instanceof Map) {
    const entries = [...v.entries()].map(([k, x]) => [String(k), canonical(x)] as const)
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    return { map: entries }
  }
  if (v instanceof Set) return { set: [...v].map(String).sort() }
  if (Array.isArray(v)) return v.map(canonical)
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k]
      if (x !== undefined) out[k] = canonical(x)
    }
    return out
  }
  return v
}
/** The full load's facts as one comparable string. */
const digestOf = (load: Awaited<ReturnType<typeof loading.loadTranscriptFile>>): string => JSON.stringify(canonical(load))

/** The counting io: every read the reader makes past a stat, in bytes. */
const io = { reads: 0, bytes: 0, stats: 0 }
reader.setTranscriptReaderIoForTesting({
  statSync: p => {
    io.stats++
    return reader.nodeTranscriptReaderIo.statSync(p)
  },
  readRangeSync: (p, s, e) => {
    const out = reader.nodeTranscriptReaderIo.readRangeSync(p, s, e)
    io.reads++
    io.bytes += out.length
    return out
  },
})
const census = reader.transcriptReaderCensus
/** Zero the instruments, keep every reader state. */
const zeroCounts = (): void => {
  io.reads = 0
  io.bytes = 0
  io.stats = 0
  census.coldReads = 0
  census.growthReads = 0
  census.resets = 0
  census.bytesRead = 0
  census.chainDerivations = 0
}
/** Zero the instruments AND drop every reader state (a fresh process). */
const resetAll = (): void => {
  reader._resetTranscriptReaderForTesting()
  zeroCounts()
}

/** A fresh full parse of the file — the oracle every incremental fold
 *  must equal. The kill switch takes the cold ladder and keeps no state,
 *  so nothing here disturbs the reader's states. */
async function fullParse(file: string): Promise<Awaited<ReturnType<typeof loading.loadTranscriptFile>>> {
  process.env.MERCURY_TRANSCRIPT_READER = '0'
  try {
    return await loading.loadTranscriptFile(file)
  } finally {
    delete process.env.MERCURY_TRANSCRIPT_READER
  }
}

// ── §A one reader per path ──────────────────────────────────────────────────
section('§A one reader per path — an unmoved file costs a stat, not a read')
{
  resetAll()
  const file = join(SCRATCH, 'a.jsonl')
  writeFileSync(file, '')
  const tick = { i: 0 }
  appendTurns(file, null, 20, tick)
  const first = await reader.readTranscript(file)
  check('the first read is one cold read', census.coldReads === 1 && first.read.kind === 'cold', JSON.stringify(census))
  check('the fold holds every row', first.fold.messages.size === 40, String(first.fold.messages.size))
  const bytesAfterCold = io.bytes
  const second = await reader.readTranscript(file)
  check('the second read of an unmoved file reads nothing and folds nothing', second.read.kind === 'none' && io.bytes === bytesAfterCold && census.growthReads === 0 && census.coldReads === 1, JSON.stringify({ kind: second.read.kind, bytes: io.bytes - bytesAfterCold, census }))
  check('it hands back the SAME fold object (one state per path)', second.fold === first.fold)
  check('the generation and offset stand', second.generation === first.generation && second.offset === first.offset && second.offset === statSync(file).size)
}

// ── §B growth reads only the appended bytes ─────────────────────────────────
section('§B an append of N rows reads only the appended bytes (+ the ≤4 KB window)')
{
  resetAll()
  const file = join(SCRATCH, 'b.jsonl')
  writeFileSync(file, '')
  const tick = { i: 0 }
  let leaf = appendTurns(file, null, 300, tick)
  const cold = await reader.readTranscriptChainSince(file, null)
  const sizeBefore = statSync(file).size
  check(`premise: the cold read covers the file (${sizeBefore} bytes, ${cold.rows.length} chain rows)`, cold.view.offset === sizeBefore && cold.rows.length === 600)
  const rowsBefore = cold.rows
  zeroCounts()
  leaf = appendTurns(file, leaf, 5, tick)
  const appendedBytes = statSync(file).size - sizeBefore
  const grown = await reader.readTranscriptChainSince(file, cold.cursor)
  check('one growth read, no cold read, no reset', census.growthReads === 1 && census.coldReads === 0 && census.resets === 0, JSON.stringify(census))
  check(`the read fetched the appended bytes plus at most the window (${io.bytes} read for ${appendedBytes} appended)`, io.bytes >= appendedBytes && io.bytes <= appendedBytes + 4096, `${io.bytes} vs ${appendedBytes}`)
  check('one positional read did it', io.reads === 1, String(io.reads))
  check('the chain since the cursor is exactly the ten appended rows', grown.since === 600 && grown.appended.length === 10 && grown.rows.length === 610 && grown.rewound === false, JSON.stringify({ since: grown.since, appended: grown.appended.length, rewound: grown.rewound }))
  check('every row before the cursor is the cursor\'s own object (identity, the calm law)', rowsBefore.every((r, i) => grown.rows[i] === r))
  check('the fold grew by ten messages and covers the file', grown.view.fold.messages.size === 610 && grown.view.offset === statSync(file).size)
  const oracle = await fullParse(file)
  const rowsFromOracle = JSON.stringify(canonical([...oracle.messages.values()].map(m => {
    const { isSidechain: _s, parentUuid: _p, ...row } = m
    return row
  })))
  const rowsFromReader = JSON.stringify(canonical([...grown.view.fold.messages.values()].map(m => {
    const { isSidechain: _s, parentUuid: _p, ...row } = m
    return row
  })))
  check('the incremental rows are byte-identical to the full parse\'s rows', rowsFromReader === rowsFromOracle)

  // An append still in flight: half a line, no newline.
  zeroCounts()
  const u = uid()
  const whole = userLine(file, u, leaf, tick.i++, `in flight ${'f'.repeat(300)}`)
  const cut = Math.floor(whole.length / 2)
  appendFileSync(file, whole.slice(0, cut))
  const inFlight = await reader.readTranscriptChainSince(file, grown.cursor)
  check('a half-written line folds nothing (the offset waits at the line boundary)', inFlight.view.read.kind === 'none' && inFlight.view.fold.messages.size === 610 && inFlight.view.offset === grown.view.offset && census.growthReads === 0, JSON.stringify({ kind: inFlight.view.read.kind, size: inFlight.view.fold.messages.size }))
  appendFileSync(file, whole.slice(cut))
  const completed = await reader.readTranscriptChainSince(file, inFlight.cursor)
  check('the append that completes it folds the whole record exactly once', completed.view.fold.messages.size === 611 && completed.view.fold.messages.has(u as never) && completed.appended.length === 1 && census.growthReads === 1, JSON.stringify({ size: completed.view.fold.messages.size, appended: completed.appended.length }))
  check('the fold state stays the one object across growth', completed.view.fold === cold.view.fold)
}

// ── §C rewrites reset honestly ──────────────────────────────────────────────
section('§C a truncation, a windowed byte flip, a replaced file and a grown rewrite each reset to a full read')
{
  const file = join(SCRATCH, 'c.jsonl')
  const seed = async (): Promise<{ leaf: string; tick: { i: number } }> => {
    resetAll()
    vnext.resetTranscriptFormatCacheForTesting()
    writeFileSync(file, '')
    const tick = { i: 0 }
    const leaf = appendTurns(file, null, 60, tick)
    await reader.readTranscript(file)
    return { leaf, tick }
  }
  const same = async (label: string): Promise<void> => {
    const got = await loading.loadTranscriptFile(file)
    const oracle = await fullParse(file)
    check(`${label}: the reset read equals a full parse of the rewritten file`, digestOf(got) === digestOf(oracle))
  }

  await seed()
  const before = await reader.readTranscript(file)
  truncateSync(file, before.offset - 500)
  const truncated = await reader.readTranscript(file)
  check('truncation below the offset: one reset, one cold read, a new generation', census.resets === 1 && census.coldReads === 2 && truncated.generation !== before.generation && truncated.read.kind === 'cold', JSON.stringify(census))
  check('the fold no longer holds the cut rows', truncated.fold.messages.size < before.fold.messages.size && truncated.offset <= statSync(file).size)
  await same('truncation')

  const seeded = await seed()
  const flipped = readFileSync(file)
  // Inside the window: the last WINDOW_BYTES before the offset.
  const at = flipped.length - 10
  flipped[at] = flipped[at] === 0x61 ? 0x62 : 0x61
  writeFileSync(file, flipped)
  const unobserved = await reader.readTranscript(file)
  check('the documented non-goal: a same-size in-place rewrite with no growth is not observed (the product\'s own rewrite roads shrink the file or replace its inode)', unobserved.read.kind === 'none' && census.resets === 0 && census.coldReads === 1, JSON.stringify({ kind: unobserved.read.kind, census }))
  appendTurns(file, seeded.leaf, 1, seeded.tick)
  const afterFlip = await reader.readTranscript(file)
  check('the next growth proves the window and finds the flip — reset + cold read', census.resets === 1 && census.coldReads === 2 && afterFlip.read.kind === 'cold', JSON.stringify(census))
  await same('byte flip')

  await seed()
  const tmp = `${file}.replacement`
  vnext.resetTranscriptFormatCacheForTesting()
  writeFileSync(tmp, '')
  appendTurns(tmp, null, 70, { i: 0 })
  renameSync(tmp, file)
  const replaced = await reader.readTranscript(file)
  check('a replaced file (a fresh inode, larger): reset + cold read', census.resets === 1 && census.coldReads === 2 && replaced.fold.messages.size === 140, JSON.stringify({ census, size: replaced.fold.messages.size }))
  await same('replaced file')

  await seed()
  const lines = readFileSync(file, 'utf8').split('\n')
  const removed = lines.splice(3, 1)[0]!
  // The file GREW despite the removal — a size-only check would miss it.
  const filler = userLine(file, uid(), null, 999, `filler ${'x'.repeat(removed.length + 200)}`)
  writeFileSync(file, lines.join('\n') + filler)
  const grownRewrite = await reader.readTranscript(file)
  check('a removed middle line whose file still grew: the window catches the shift — reset + cold read', census.resets === 1 && census.coldReads === 2 && grownRewrite.read.kind === 'cold', JSON.stringify(census))
  await same('grown rewrite')
}

// ── §D parity: growth ≡ full parse ──────────────────────────────────────────
section('§D five rounds of growth fold to the same facts as one full parse; the kill switch reads the same rows')
{
  resetAll()
  vnext.resetTranscriptFormatCacheForTesting()
  const file = join(SCRATCH, 'd.jsonl')
  writeFileSync(file, '')
  const tick = { i: 0 }
  let leaf = appendTurns(file, null, 30, tick)
  let cursor = (await reader.readTranscriptChainSince(file, null)).cursor
  let commits = 0
  for (let round = 0; round < 5; round++) {
    leaf = appendTurns(file, leaf, 8, tick)
    appendFileSync(file, encode(file, { type: 'custom-title', customTitle: `title ${round}`, sessionId: SID }))
    appendFileSync(file, encode(file, { type: 'tag', tag: `tag-${round}`, sessionId: SID }))
    appendFileSync(file, encode(file, { type: 'summary', summary: `summary ${round}`, leafUuid: leaf }))
    appendFileSync(file, encode(file, { type: 'pr-link', sessionId: SID, prNumber: 100 + round, prUrl: `https://example.invalid/pr/${round}`, prRepository: 'org/repo', timestamp: at(tick.i++) }))
    appendFileSync(file, encode(file, { type: 'agent-name', agentName: `agent-${round}`, sessionId: SID }))
    appendFileSync(file, encode(file, { type: 'mode', mode: 'normal', sessionId: SID }))
    appendFileSync(file, encode(file, { type: 'marble-origami-commit', sessionId: SID, commitId: `c${round}`, collapsedSpans: [], timestamp: at(tick.i++) }))
    commits++
    if (round === 2) {
      // A compaction boundary with a preserved segment: the post-passes
      // (relinks, the prune) must apply on the growth road exactly as on
      // the full read.
      const summaryUuid = uid()
      appendFileSync(file, userLine(file, summaryUuid, leaf, tick.i++, 'compact summary text'))
      const boundary = uid()
      appendFileSync(
        file,
        encode(file, {
          ...base(boundary, summaryUuid, tick.i++),
          type: 'system',
          subtype: 'compact_boundary',
          content: 'Conversation compacted',
          level: 'info',
          compactMetadata: { trigger: 'manual', preTokens: 1000 },
        }),
      )
      leaf = boundary
      leaf = appendTurns(file, leaf, 3, tick)
    }
    const step = await reader.readTranscriptChainSince(file, cursor)
    cursor = step.cursor
    check(`round ${round}: a growth read (${step.view.read.kind}), no reset`, step.view.read.kind === 'growth' && census.resets === 0, JSON.stringify(census))
  }
  const incremental = await loading.loadTranscriptFile(file)
  const chainIncremental = (await reader.readTranscriptChainSince(file, cursor)).rows
  const oracle = await fullParse(file)
  check('the incremental fold equals the full parse (messages, every metadata map, commits, leaves)', digestOf(incremental) === digestOf(oracle))
  // The commits fold as an array push: a line folded twice would show as
  // an extra commit against the full parse (a compact boundary retires the
  // commits before it on both roads, so the count is the oracle's).
  check(`no line folded twice: ${commits} collapse commits written, ${incremental.contextCollapseCommits.length} standing on both roads`, incremental.contextCollapseCommits.length === oracle.contextCollapseCommits.length && incremental.contextCollapseCommits.length > 0)
  check('the last title, tag, summary and pr-link won (last-write-wins across growth)', incremental.customTitles.get(SID as never) === 'title 4' && incremental.tags.get(SID as never) === 'tag-4' && incremental.prNumbers.get(SID as never) === 104 && incremental.agentNames.get(SID as never) === 'agent-4')
  // The chain rows, byte for byte, against the full parse's own chain.
  process.env.MERCURY_TRANSCRIPT_READER = '0'
  const coldBefore = census.coldReads
  const chainCold = (await reader.readTranscriptChainSince(file, null)).rows
  const chainColdAgain = (await reader.readTranscriptChainSince(file, null)).rows
  delete process.env.MERCURY_TRANSCRIPT_READER
  check('the kill switch: every read is a cold read (the whole-file cost)', census.coldReads === coldBefore + 2, `${census.coldReads - coldBefore} cold reads for two asks`)
  check('the incremental chain is byte-identical to the kill-switched full-parse chain', JSON.stringify(chainIncremental) === JSON.stringify(chainCold) && JSON.stringify(chainCold) === JSON.stringify(chainColdAgain))
  check('the chain carries the compaction boundary the growth road folded', chainIncremental.some(r => (r as { subtype?: string }).subtype === 'compact_boundary'), String(chainIncremental.length))
  check('with the reader on, an unmoved file hands back the same chain ARRAY (identity)', (await reader.readTranscriptChainSince(file, cursor)).rows === chainIncremental)
}

// ── §E a torn tail counts once ──────────────────────────────────────────────
section('§E a torn tail is stated once: its completion folds whole, a writer\'s heal never restates it')
{
  resetAll()
  vnext.resetTranscriptFormatCacheForTesting()
  const file = join(SCRATCH, 'e.jsonl')
  writeFileSync(file, '')
  const tick = { i: 0 }
  const leaf = appendTurns(file, null, 5, tick)
  const u = uid()
  const whole = userLine(file, u, leaf, tick.i++, `completes later ${'c'.repeat(100)}`)
  const cut = Math.floor(whole.length / 2)
  appendFileSync(file, whole.slice(0, cut))
  let fired = 0
  const unsubscribe = loading.subscribeTranscriptLoadDegradation(() => {
    fired++
  })
  loading._resetTranscriptLoadDegradationForTesting()
  const cold = await loading.loadTranscriptFile(file)
  const fact = loading.transcriptLoadDegradation()
  check('the cold read states the torn line once (malformed 1) and folds the valid rows', fired === 1 && fact !== null && fact.malformed === 1 && fact.refusal === null && cold.messages.size === 10, JSON.stringify({ fired, fact, size: cold.messages.size }))
  appendFileSync(file, whole.slice(cut))
  const completed = await loading.loadTranscriptFile(file)
  check('the append completing it folds the whole record, with no second statement', completed.messages.size === 11 && completed.messages.has(u as never) && fired === 1, JSON.stringify({ size: completed.messages.size, fired }))

  // The writer's heal: a torn record that never completes, terminated by
  // the next append's leading newline.
  resetAll()
  const file2 = join(SCRATCH, 'e2.jsonl')
  writeFileSync(file2, '')
  const tick2 = { i: 0 }
  const leaf2 = appendTurns(file2, null, 5, tick2)
  appendFileSync(file2, '{"recordId":"torn-mid-append')
  loading._resetTranscriptLoadDegradationForTesting()
  fired = 0
  await loading.loadTranscriptFile(file2)
  check('premise: the torn fragment is stated once', fired === 1 && loading.transcriptLoadDegradation()?.malformed === 1)
  const healed = userLine(file2, uid(), leaf2, tick2.i++, 'after the heal')
  appendFileSync(file2, `\n${healed}`)
  const afterHeal = await loading.loadTranscriptFile(file2)
  check('the heal folds the new record and does not restate the fragment', afterHeal.messages.size === 11 && fired === 1, JSON.stringify({ size: afterHeal.messages.size, fired }))
  unsubscribe()
}

// ── §F retention ────────────────────────────────────────────────────────────
section('§F a retained path survives other loads; released, it rides the two-deep recent list')
{
  resetAll()
  vnext.resetTranscriptFormatCacheForTesting()
  const files = ['f0', 'f1', 'f2', 'f3'].map(name => {
    const p = join(SCRATCH, `${name}.jsonl`)
    writeFileSync(p, '')
    appendTurns(p, null, 3, { i: 0 })
    return p
  })
  const pinned = files[0]!
  const release = reader.retainTranscript(pinned)
  await reader.readTranscript(pinned)
  for (const f of files.slice(1)) await reader.readTranscript(f)
  let held = reader._transcriptReaderRetentionForTesting()
  check('the retained path keeps its state while three other transcripts load', held.states.includes(pinned) && held.retained.includes(pinned), JSON.stringify(held))
  check('unretained states ride a two-deep recent list (the oldest displaced)', held.recent.length === 2 && held.states.length === 3 && !held.states.includes(files[1]!), JSON.stringify(held))
  const coldBefore = census.coldReads
  await reader.readTranscript(pinned)
  check('the retained path reads warm (no cold read)', census.coldReads === coldBefore)
  release()
  held = reader._transcriptReaderRetentionForTesting()
  check('released, the path joins the recent list', !held.retained.includes(pinned) && held.recent.includes(pinned), JSON.stringify(held))
  await reader.readTranscript(files[1]!)
  await reader.readTranscript(files[2]!)
  held = reader._transcriptReaderRetentionForTesting()
  check('two later loads displace it', !held.states.includes(pinned), JSON.stringify(held))
  const oneShot = join(SCRATCH, 'f-oneshot.jsonl')
  writeFileSync(oneShot, '')
  appendTurns(oneShot, null, 2, { i: 0 })
  await reader.readTranscript(oneShot, { cache: false })
  check('cache:false reads without keeping a state', !reader._transcriptReaderRetentionForTesting().states.includes(oneShot))
}

// ── §G the chain cursor names what moved ────────────────────────────────────
section('§G a revision and a rewind rewind the chain from the moved index; the live-turn fold matches its one-shot')
{
  resetAll()
  vnext.resetTranscriptFormatCacheForTesting()
  const file = join(SCRATCH, 'g.jsonl')
  writeFileSync(file, '')
  const tick = { i: 0 }
  const leaf = appendTurns(file, null, 10, tick)
  const first = await reader.readTranscriptChainSince(file, null)
  check('premise: 20 rows', first.rows.length === 20)
  // A revision of the tail row: the same uuid published again (the
  // streaming snapshot → settled pair), replacing in place.
  const tailUuid = (first.rows[19] as { uuid: string }).uuid
  const revised = asstLine(file, tailUuid, (first.rows[18] as { uuid: string }).uuid, tick.i++, 'the settled reply')
  appendFileSync(file, revised)
  const afterRevision = await reader.readTranscriptChainSince(file, first.cursor)
  check('a tail revision rewinds from the tail index only', afterRevision.rewound === true && afterRevision.since === 19 && afterRevision.rows.length === 20 && afterRevision.appended.length === 1, JSON.stringify({ since: afterRevision.since, rewound: afterRevision.rewound, len: afterRevision.rows.length }))
  check('the revised row is a fresh object with the new content; every earlier row keeps its identity', afterRevision.rows[19] !== first.rows[19] && JSON.stringify((afterRevision.rows[19] as { message: { content: unknown } }).message.content).includes('the settled reply') && first.rows.slice(0, 19).every((r, i) => afterRevision.rows[i] === r))
  // A rewind: a new user row parenting onto the fourth assistant row, later
  // in time — the chain now runs from there.
  const anchor = (first.rows[7] as { uuid: string }).uuid
  const rewound = uid()
  appendFileSync(file, userLine(file, rewound, anchor, tick.i++, 'after the rewind'))
  const afterRewind = await reader.readTranscriptChainSince(file, afterRevision.cursor)
  check('a rewind rewinds the chain from the first moved index', afterRewind.rewound === true && afterRewind.since === 8 && afterRewind.rows.length === 9 && (afterRewind.rows[8] as { uuid: string }).uuid === rewound, JSON.stringify({ since: afterRewind.since, len: afterRewind.rows.length }))
  check('the rows before the rewind keep their identity', first.rows.slice(0, 8).every((r, i) => afterRewind.rows[i] === r))
  void leaf

  // The live-turn fold over a settled prefix equals the one-shot fold at
  // every prefix, including a rewind of the settled part.
  const rows = afterRewind.rows as never[]
  const fold = recovery.createLiveTurnFold()
  const norm = (s: ReturnType<typeof recovery.liveTurnStateOf>): string =>
    JSON.stringify({ ...s, inProgressToolUseIDs: [...s.inProgressToolUseIDs].sort() })
  let agree = true
  const script: Array<[number, number]> = [[0, 3], [3, 6], [6, 9], [2, 9], [9, 9], [0, 9], [5, 7]]
  for (const [prefix, upTo] of script) {
    const slice = rows.slice(0, upTo)
    if (norm(fold.fold(slice, prefix)) !== norm(recovery.liveTurnStateOf(slice))) agree = false
  }
  check('the settled-prefix fold equals the one-shot fold across appends and rewinds', agree)
}

// ── §H the byte cursor and the backward walk ────────────────────────────────
section('§H complete lines past a byte cursor; newest lines first with one window and no lost line')
{
  resetAll()
  const file = join(SCRATCH, 'h.jsonl')
  const rec = (i: number): string => JSON.stringify({ type: 'user', i, text: `líne ${i} ✓ ${'字'.repeat(40)}` })
  writeFileSync(file, `${rec(1)}\n${rec(2)}\n`)
  let read = reader.readTranscriptBytesAfter(file, { offset: 0, carry: '' })
  check('the first read hands back both complete lines and an empty carry', read.text.split('\n').length === 2 && read.cursor.carry === '' && read.cursor.offset === statSync(file).size)
  const half = rec(3)
  appendFileSync(file, `${rec(10)}\n${half.slice(0, 12)}`)
  read = reader.readTranscriptBytesAfter(file, read.cursor)
  check('a complete line lands; the partial one is CARRIED, never handed out', read.text === rec(10) && read.cursor.carry === half.slice(0, 12))
  appendFileSync(file, `${half.slice(12)}\n`)
  read = reader.readTranscriptBytesAfter(file, read.cursor)
  check('the carried line completes on the next read', read.text === rec(3) && read.cursor.carry === '')
  const parked = read.cursor
  writeFileSync(file, `${rec(1)}\n`)
  read = reader.readTranscriptBytesAfter(file, parked)
  check('a shrunken file rewinds with the flag and re-reads from zero', read.rewound === true && read.text === rec(1))

  // The backward walk over a file larger than one window, cut inside
  // multi-byte characters at every window edge.
  const big = join(SCRATCH, 'h-big.jsonl')
  const N = 3000
  const lines: string[] = []
  for (let i = 0; i < N; i++) lines.push(rec(i))
  writeFileSync(big, lines.join('\n') + '\n')
  const size = statSync(big).size
  const seen: string[] = []
  zeroCounts()
  reader.scanTranscriptLinesBackward(big, line => {
    seen.push(line)
  })
  check(`the walk visits every line newest first (${seen.length} of ${N})`, seen.length === N && seen.every((l, i) => l === lines[N - 1 - i]))
  check('widening windows read the file about once (never quadratic)', io.bytes <= size * 2, `${io.bytes} bytes for a ${size}-byte file`)
  zeroCounts()
  let visited = 0
  reader.scanTranscriptLinesBackward(big, () => {
    visited++
    return true
  })
  check('an early stop reads one window, not the file', visited === 1 && io.bytes <= 64 * 1024 && io.bytes < size, `${io.bytes} bytes`)
}

// ── §I the real connector ───────────────────────────────────────────────────
section('§I the daemon connector: one cold read at attach, one growth read per tick after an append, unchanged rows keep their objects')
{
  resetAll()
  vnext.resetTranscriptFormatCacheForTesting()
  const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.ts')
  const sessionId = '12345678-1234-4123-8123-1234567890ab'
  const file = join(SCRATCH, `${sessionId}.jsonl`)
  writeFileSync(file, '')
  const tick = { i: 0 }
  let leaf = appendTurns(file, null, 25, tick)
  const conn = new DaemonSessionConnector({
    sessionId,
    runnerId: 'w1',
    title: 'reader drive',
    projectLabel: 'scratch',
    workspaceId: SCRATCH,
    home: SCRATCH,
  })
  await conn.attach()
  const painted = conn.records()
  check('attach paints the chain from one cold read', painted.length === 50 && census.coldReads === 1 && census.growthReads === 0, JSON.stringify({ painted: painted.length, census }))
  check('the connector pinned its transcript in the reader', reader._transcriptReaderRetentionForTesting().retained.includes(file))
  const seam = conn as unknown as { tick: () => Promise<void> }
  zeroCounts()
  await seam.tick()
  check('a tick over an unmoved file reads nothing (the stat gate)', io.reads === 0 && census.growthReads === 0 && conn.records() === painted, JSON.stringify({ reads: io.reads, census }))
  leaf = appendTurns(file, leaf, 2, tick)
  await seam.tick()
  const grown = conn.records()
  check('a tick after an append is one growth read, no cold read', census.growthReads === 1 && census.coldReads === 0, JSON.stringify(census))
  check('the chat has the four new rows', grown.length === 54, String(grown.length))
  check('every unchanged row keeps its object (the calm law over the reader\'s tokens)', painted.every((r, i) => grown[i] === r))
  void leaf
  conn.detach()
  check('detach releases the pin', !reader._transcriptReaderRetentionForTesting().retained.includes(file))
}

reader.setTranscriptReaderIoForTesting(null)
console.log(failures === 0 ? '\n✅ ALL TRANSCRIPT-TAIL-READER PROOFS PASS' : `\n❌ ${failures} TRANSCRIPT-TAIL-READER PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
