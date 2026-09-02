#!/usr/bin/env bun
// ============================================================================
//  scripts/daemon/prove-compact-state-word.ts — the fold's own state word
//  reaches the glass (compact-frontier part 1b: the operator watched /compact
//  on a hosted chat dressed as "thinking with high effort" — the connector's
//  in-flight default — for the whole fold).
//
//  THE ROAD: the compact service already stamps setSDKStatus('compacting') at
//  fold start and null at restore; the hosted child already relays every
//  stamp as a system/status stdout frame. What was missing: the seat ignored
//  those frames, so no projection carried the word and the connector's live
//  fold defaulted the phase to 'thinking'. Now the seat folds the status
//  frame into the tail projection (SessionTailV1.stateWord, additive under
//  the mixed-version law), the connector lifts it into the live phase
//  ('compacting'), and the REPL paints the fold's own word — never the
//  thinking dress, never the session's effort suffix.
//
//  The laws under proof (fixture-fed, cpu-pure — the W14 recipe):
//    C1  a system/status frame carrying 'compacting' sets the word in the
//        tail projection;
//    C2  a status null frame clears it (the compact service's restore);
//    C3  the turn's result frame clears it too (the settle belt — a fold
//        that dies without its restore never leaves a stale word);
//    C4  a respawn clears it (a child dead mid-fold never leaks the word);
//    C5  a mention-shaped line (the token inside a tool result's content)
//        never sets it;
//    C6  the wiring, structural — the service stamps the status, the child
//        relays it, the connector lifts the word into phase 'compacting',
//        the live-phase vocabulary carries it, and the REPL maps it to its
//        own state word instead of the thinking dress.
//
//  Run: ~/.bun/bin/bun run scripts/daemon/prove-compact-state-word.ts
// ============================================================================
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'stateword-home-'))

const { onSeatLine, onSeatSpawned } = await import('../../src/daemon/sessionSeat.ts')
const { readSessionTail } = await import('../../src/services/engine-connector/seatProjections.ts')
const { updateConcourseWorkers } = await import('../../src/daemon/concourseSupervisor.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const dir = mkdtempSync(join(tmpdir(), 'stateword-daemon-'))
const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-stateword001'
const SHORT = 'concourse-sw1'
updateConcourseWorkers(workers => {
  workers[SHORT] = {
    schema: 1,
    runnerId: SHORT,
    sessionId: sid,
    workspaceId: 'ws-sw',
    isolation: 'exclusive',
    modelKey: 'claude-opus-5',
    effort: 'high',
    spawnedAt: Date.now(),
    lastLiveAt: Date.now(),
    settingsSnapshot: { schema: 1, snapshotId: 's', sessionId: sid, profileRevision: 0, profileDigest: 'd', resolvedAt: Date.now(), rows: [] } as never,
    workspaceKind: 'plain-folder',
  } as never
}, dir)
const roster = { control: () => true, list: () => [], patchSeatModel: () => true }

const statusFrame = (status: unknown): string =>
  JSON.stringify({ type: 'system', subtype: 'status', status, uuid: '00000000-0000-4000-a000-000000000001', session_id: sid })
const tail = () => readSessionTail(sid, dir)
const word = () => (tail() as { stateWord?: string } | null)?.stateWord

console.log('compact state word — the fold speaks its own word on the glass road')

console.log('\nC1 the status frame sets the word')
onSeatLine(SHORT, statusFrame('compacting'), roster as never, dir)
check("status 'compacting' ⇒ the tail projection carries the word", word() === 'compacting', JSON.stringify(tail()))

console.log('\nC2 the status null frame clears it (the restore)')
onSeatLine(SHORT, statusFrame(null), roster as never, dir)
check('status null ⇒ the word is gone', word() === undefined, JSON.stringify(tail()))

console.log('\nC3 the result frame clears it (the settle belt)')
onSeatLine(SHORT, statusFrame('compacting'), roster as never, dir)
check('the word stands before the settle', word() === 'compacting')
onSeatLine(SHORT, JSON.stringify({ type: 'result', subtype: 'success' }), roster as never, dir)
check('the result frame retires the word with the turn', word() === undefined, JSON.stringify(tail()))

console.log('\nC4 a respawn clears it (a child dead mid-fold)')
onSeatLine(SHORT, statusFrame('compacting'), roster as never, dir)
onSeatSpawned(SHORT, roster as never, dir)
check('the respawn retires the word', word() === undefined, JSON.stringify(tail()))

console.log('\nC5 a mention-shaped line never sets it')
onSeatLine(
  SHORT,
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'the frame spelling is {"subtype":"status","status":"compacting"} verbatim' }] },
  }),
  roster as never,
  dir,
)
check('a tool/assistant line CONTAINING the token leaves no word', word() === undefined, JSON.stringify(tail()))
onSeatLine(SHORT, JSON.stringify({ type: 'result', subtype: 'success' }), roster as never, dir)

console.log('\nC6 the wiring — service stamp to glass word (structural)')
{
  const read = (rel: string): string => readFileSync(join(import.meta.dir, '..', '..', rel), 'utf8')
  const service = read('src/services/compact/compact.ts')
  check("the compact service stamps setSDKStatus('compacting')", service.includes("setSDKStatus?.('compacting')"))
  const print = read('src/cli/print.ts')
  check("the hosted child relays the stamp as a system/status frame", print.includes("subtype: 'status'"))
  const seatLive = read('src/services/engine-connector/seatLive.ts')
  check("the live-phase vocabulary carries 'compacting'", seatLive.includes("'compacting'"))
  const connector = read('src/services/engine-connector/daemonConnector.ts')
  check("the connector lifts the word into phase 'compacting'", connector.includes("'compacting'"))
  const repl = read('src/screens/REPL.tsx')
  check(
    "the REPL paints the fold's own word (its own state word, never the thinking dress)",
    repl.includes("compacting"),
  )
  check(
    "the REPL never maps the compacting phase onto the thinking mode",
    !/compacting'\s*\?\s*'thinking'/.test(repl),
  )
}

console.log(
  failures === 0
    ? '\n ✅ COMPACT STATE WORD — the fold speaks its own word, never the thinking dress'
    : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
