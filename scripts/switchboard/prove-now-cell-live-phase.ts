#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'now-cell-phase-')))
process.env['MERCURY_CONFIG_DIR'] = join(SCRATCH, 'home')
mkdirSync(join(SCRATCH, 'home'), { recursive: true })

const { LiveTileStore, liveTilePhase, gateTailFreshness } = await import('../../src/components/concourse/liveTiles.js')
const { publishSessionTail, readSessionTail, sessionTailDir, sessionTailPath } = await import('../../src/services/engine-connector/seatProjections.js')
const snapshot = await import('../../src/services/concourse/concourseSnapshot.js')
const { workerTranscriptPath } = await import('../../src/services/concourse/workerTranscript.js')
const { entryToRecord } = await import('../../src/fabric/entryCodec.js')
const { ordinalOf } = await import('../../src/fabric/ordinal.js')
const words = await import('../../src/components/Spinner/liveCounterWords.js')
const grammar = await import('../../src/components/messages/thinkingGrammar.js')

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const j = (v: unknown): string => JSON.stringify(v)
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const tailDir = join(SCRATCH, 'daemon')
let clock = 1_000_000
const WORKSPACE = join(SCRATCH, 'project')
mkdirSync(WORKSPACE, { recursive: true })
const SID = '550e8400-e29b-41d4-a716-4466554401a5'
let ordinal = 0
const ctx = { sessionId: SID as never, nextOrdinal: () => ordinalOf(++ordinal) as never, observedAt: '2026-10-04T18:10:05Z', source: { channel: 'sdk' } as const }
const stamp = '2026-10-04T18:10:05.000Z'
const lineOf = (entry: Record<string, unknown>): string => JSON.stringify(entryToRecord(entry as never, ctx as never))
const prompt = lineOf({ type: 'user', uuid: 'u-1', timestamp: stamp, message: { role: 'user', content: 'Let us build a small command-line tool in this folder: tally' } })
const globCall = lineOf({
  type: 'assistant',
  uuid: 'a-1',
  timestamp: stamp,
  message: {
    role: 'assistant',
    model: 'claude-sonnet-5-5',
    content: [
      { type: 'text', text: 'Let me look at the folder first.' },
      { type: 'tool_use', id: 'toolu_glob_1', name: 'Glob', input: { pattern: '**/*' } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 1 },
  },
})
const globResult = lineOf({
  type: 'user',
  uuid: 'u-2',
  timestamp: stamp,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_glob_1', content: 'No files found' }] },
})
const transcript = workerTranscriptPath({ sessionId: SID, workspaceId: WORKSPACE })
mkdirSync(join(transcript, '..'), { recursive: true })
const rec = { sessionId: SID, workspaceId: WORKSPACE }

section('§1 THE TRANSCRIPT TAIL — a tool whose result landed is settled; a tool still running is not')
{
  writeFileSync(transcript, `${prompt}\n${globCall}\n`)
  const running = snapshot.tailActivity(rec)
  check('a Glob with no result yet reads as the running tool', running?.kind === 'tool' && running.label === 'Glob · **/*' && running.settled === undefined, j(running))
  check('…and its now-label is the tool', snapshot.tailActivityLabel(rec) === 'Glob · **/*', j(snapshot.tailActivityLabel(rec)))
  writeFileSync(transcript, `${prompt}\n${globCall}\n${globResult}\n`)
  const settled = snapshot.tailActivity(rec)
  check('RED ON THE BASE: the Glob whose result landed is marked settled', settled?.kind === 'tool' && settled.label === 'Glob · **/*' && settled.settled === true, j(settled))
  check('RED ON THE BASE: the snapshot\'s now-label reads the model\'s turn (thinking), never a finished tool', snapshot.tailActivityLabel(rec) === 'thinking', j(snapshot.tailActivityLabel(rec)))
  check('the word is the status line\'s own phase word', snapshot.MODEL_TURN_NOW_WORD === words.liveCounterPhaseOf('thinking') && snapshot.MODEL_TURN_NOW_WORD === grammar.THINKING_WORD, j({ snapshot: snapshot.MODEL_TURN_NOW_WORD, line: words.liveCounterPhaseOf('thinking'), grammar: grammar.THINKING_WORD }))
  check('the coordinator board reads the same label through activityNowLabel', snapshot.activityNowLabel?.(settled) === 'thinking' && snapshot.activityNowLabel?.(running) === 'Glob · **/*' && snapshot.activityNowLabel?.({ label: 'done — 3 files', kind: 'text' }) === 'done — 3 files')
  const board = read('src/services/concourse/coordinatorBoard.ts')
  check('the coordinator board paints the activity through the one label road', board.includes('snap.activityNowLabel(activity)'))
}

section('§2 THE LIVE TILE — the NOW cell reads the seat\'s phase facts (the status line\'s), then the transcript')
{
  const activity = new Map<string, { label: string; kind: 'tool' | 'text'; settled?: true } | null>()
  const store = new LiveTileStore({
    tailDir: () => sessionTailDir(tailDir),
    tailPath: (id: string) => sessionTailPath(id, tailDir),
    readTail: (id: string) => readSessionTail(id, tailDir),
    activity: r => activity.get(r.sessionId) ?? null,
    transcriptPath: r => join(SCRATCH, 'transcripts', `${r.sessionId}.jsonl`),
    nowMs: () => clock,
    forceDegrade: false,
    armMachinery: false,
  })
  const unsub = store.register('s-air', WORKSPACE, () => {})
  const publish = (over: Record<string, unknown>): void => {
    clock += 50
    publishSessionTail({ schema: 1, sessionId: 's-air', atMs: clock, text: null, ...over } as never, tailDir)
    store._drainForTesting()
  }
  activity.set('s-air', { label: 'Glob · **/*', kind: 'tool', settled: true })
  publish({ streamBlock: 'thinking', blockSinceMs: clock })
  const thinking = store.readTile('s-air')
  check('RED ON THE BASE: the Air\'s shape — the Glob settled, the seat in a thinking block: the cell reads thinking, not the finished tool', thinking.kind === 'phase' && thinking.line === 'thinking', j(thinking))
  publish({})
  const dispatch = store.readTile('s-air')
  check('RED ON THE BASE: no block stamped and the tool settled: the model\'s turn reads thinking (the dispatch window)', dispatch.kind === 'phase' && dispatch.line === 'thinking', j(dispatch))
  activity.set('s-air', { label: 'Glob · **/*', kind: 'tool' })
  publish({})
  const running = store.readTile('s-air')
  check('a tool with no result yet still reads as running (unchanged)', running.kind === 'tool' && running.line === 'Glob · **/*', j(running))
  publish({ wait: { kind: 'first-byte', cold: true, promptTokens: 100, model: 'claude-sonnet-5-5', budgetMs: 120_000, sinceMs: clock, attempt: 1 } })
  const waiting = store.readTile('s-air')
  check('a request wait outranks the transcript: the cell reads the prompt wait in the status line\'s words', waiting.kind === 'phase' && waiting.line === words.READING_PHASE_WORD, j(waiting))
  publish({ wait: { kind: 'retry', attempt: 2, of: 5, reason: 'a 529', delayMs: 3_000, sinceMs: clock } })
  check('a reissue reads retrying', store.readTile('s-air').kind === 'phase' && (store.readTile('s-air') as { line?: string }).line === words.RETRY_PHASE_WORD, j(store.readTile('s-air')))
  publish({ stateWord: 'compacting' })
  check('the fold\'s word outranks everything', (store.readTile('s-air') as { line?: string }).line === 'compacting', j(store.readTile('s-air')))
  publish({ stateWord: 'waiting-on-agents', waitingOnAgents: 2 })
  check('the agent wait names the count', (store.readTile('s-air') as { line?: string }).line === 'waiting on 2 agents', j(store.readTile('s-air')))
  publish({ streamBlock: 'tool_use', blockSinceMs: clock })
  check('a tool call being written reads writing', (store.readTile('s-air') as { line?: string }).line === 'writing', j(store.readTile('s-air')))
  publish({ streamBlock: 'text', blockSinceMs: clock, text: 'The folder is empty, so I will create' })
  const streaming = store.readTile('s-air')
  check('streaming prose still wins over the phase (the scroll)', streaming.kind === 'streaming' && streaming.line === 'The folder is empty, so I will create', j(streaming))
  clock += 60_000
  store._drainForTesting()
  const stale = store.readTile('s-air')
  check('a stale block falls through to the phase facts the tail still carries (the gate keeps them)', stale.kind === 'phase' && stale.line === 'writing', j(stale))
  check('gateTailFreshness keeps every field beside the cleared text', (() => { const gated = gateTailFreshness({ atMs: 0, text: 'old', streamBlock: 'thinking' } as never, 60_000) as { text: string | null; streamBlock?: string } | null; return gated !== null && gated.text === null && gated.streamBlock === 'thinking' })())
  check('liveTilePhase reads nothing from a bare tail (an older daemon) and nothing when idle', liveTilePhase?.({ atMs: 0, text: null }) === null && liveTilePhase?.(null) === null)
  activity.set('s-air', { label: 'done — tally.py written', kind: 'text' })
  publish({})
  const settled = store.readTile('s-air')
  check('settled text between turns stays the base\'s settled line', settled.kind === 'settled' && settled.line === 'done — tally.py written', j(settled))
  unsub()
}

section('§3 THE CELL — a phase line paints as its words, a tool line as running <tool>')
{
  const cell = read('src/components/concourse/LiveNowCell.tsx')
  check('the cell prefixes only a tool line with running', cell.includes("now.kind === 'tool' ? `running ${now.line}` : now.line"))
  const tiles = read('src/components/concourse/liveTiles.ts')
  check('the tile derives the phase before the transcript activity and after the streaming text', tiles.indexOf("return { kind: 'streaming', line }") < tiles.indexOf('const phase = liveTilePhase(tail)') && tiles.indexOf('const phase = liveTilePhase(tail)') < tiles.indexOf('this.deps.activity({ sessionId: e.sessionId'))
}

console.log(`\n${'═'.repeat(76)}`)
if (failures > 0) {
  console.log(`❌ prove-now-cell-live-phase: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ prove-now-cell-live-phase: the board\'s NOW cell reads the live phase the status line reads — a finished tool never stays "running"')
process.exit(0)
