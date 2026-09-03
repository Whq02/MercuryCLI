#!/usr/bin/env bun
// ============================================================================
//  scripts/crew/prove-switch-while-agents-hold.ts — a model or effort switch
//  asked while background agents alone hold the turn open APPLIES NOW; one
//  asked while a stream is in flight still parks for the turn's end.
//
//  The runner holds a turn open while its background agents run (the
//  interrupt law: Esc stops them), and says so with its status word
//  ("waiting on N agents"). The seat read every open turn as "mid-turn" and
//  parked the operator's /model until the agents finished — an hour, for
//  builders — while the band named the parked model and the next ask ran
//  on the old one.
//
//    S1  the pure law: closed turn ⇒ applies; open + waiting-on-agents ⇒
//        applies; open + no word ⇒ parks; open + compacting ⇒ parks
//    S2  the seat's set-model verb through the real seat: the runner's
//        status frame (waitingOnAgents: 2) arrives, the roster says the
//        turn is active — set-model APPLIES (the set_model control reaches
//        the child, the record's modelKey flips); the status word clears —
//        set-model PARKS (queued, the record carries pendingModelKey)
//    S3  the effort sibling follows the same law
//
//  Run:  ~/.bun/bin/bun run scripts/crew/prove-switch-while-agents-hold.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'switch-hold-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'

const seat = await import('../../src/daemon/sessionSeat.ts')
const { updateConcourseWorkers, readSessionWorkers } = await import('../../src/daemon/concourseSupervisor.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' a switch while agents hold the turn — applies now, parks only mid-stream')
console.log('============================================================')

section('S1 · the pure law')
check('a closed turn applies', seat.switchAppliesWhileAgentsHold(false, null) === true)
check('an open turn held by its agents alone applies', seat.switchAppliesWhileAgentsHold(true, 'waiting-on-agents') === true)
check('an open turn with a stream in flight parks', seat.switchAppliesWhileAgentsHold(true, null) === false)
check('an open turn mid-compaction parks', seat.switchAppliesWhileAgentsHold(true, 'compacting') === false)

section('S2 · the seat\'s set-model verb through the real seat')
const dir = mkdtempSync(join(tmpdir(), 'switch-hold-daemon-'))
const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-switchhold01'
const SHORT = 'concourse-sh1'
updateConcourseWorkers(workers => {
  workers[SHORT] = {
    schema: 1,
    runnerId: SHORT,
    sessionId: sid,
    workspaceId: 'ws-sh',
    isolation: 'exclusive',
    modelKey: 'claude-fable-5-1',
    effort: 'high',
    spawnedAt: Date.now(),
    lastLiveAt: Date.now(),
    settingsSnapshot: { schema: 1, snapshotId: 's', sessionId: sid, profileRevision: 0, profileDigest: 'd', resolvedAt: Date.now(), rows: [] } as never,
    workspaceKind: 'plain-folder',
  } as never
}, dir)
const controls: string[] = []
let turnActive = true
const roster = {
  control: (_short: string, frame: string) => {
    controls.push(frame)
    return true
  },
  list: () => [{ short: SHORT, turnActive }],
  patchSeatModel: () => true,
  patchSeatEffort: () => true,
}
const status = (value: unknown): string => JSON.stringify({ type: 'system', subtype: 'status', status: value, uuid: 'u', session_id: sid })
const record = () => readSessionWorkers(dir)[SHORT] as { modelKey?: string; pendingModelKey?: string; effort?: string; pendingEffort?: string } | undefined

// The runner's word: the stream ended, two agents hold the turn.
seat.onSeatLine(SHORT, status({ waitingOnAgents: 2 }), roster as never, dir)
const applied = seat.setSessionModel(sid, 'claude-opus-5', roster as never, dir)
check('with agents holding the turn, set-model APPLIES', applied.outcome === 'applied', JSON.stringify(applied))
check('…the set_model control reached the child', controls.some(f => f.includes('"subtype":"set_model"') && f.includes('claude-opus-5')), controls.join(' | ').slice(0, 200))
check('…and the record flips to the new model with nothing parked', record()?.modelKey === 'claude-opus-5' && record()?.pendingModelKey === undefined, JSON.stringify(record()))

// The stream is live again: the word clears; the same verb parks.
seat.onSeatLine(SHORT, status(null), roster as never, dir)
const queued = seat.setSessionModel(sid, 'claude-fable-5-1', roster as never, dir)
check('with a stream in flight, set-model PARKS (queued)', queued.outcome === 'queued', JSON.stringify(queued))
check('…the record carries the parked model and keeps the applied one', record()?.modelKey === 'claude-opus-5' && record()?.pendingModelKey === 'claude-fable-5-1', JSON.stringify(record()))

// The turn closes: the verb applies at once again.
turnActive = false
const closed = seat.setSessionModel(sid, 'claude-sonnet-5', roster as never, dir)
check('with the turn closed, set-model applies', closed.outcome === 'applied' && record()?.modelKey === 'claude-sonnet-5', JSON.stringify(closed))

section('S3 · the effort sibling')
turnActive = true
seat.onSeatLine(SHORT, status({ waitingOnAgents: 1 }), roster as never, dir)
const effortApplied = seat.setSessionEffort(sid, 'low', roster as never, dir)
check('with agents holding the turn, set-effort APPLIES', effortApplied.outcome === 'applied' && record()?.effort === 'low', JSON.stringify(effortApplied))
seat.onSeatLine(SHORT, status(null), roster as never, dir)
const effortQueued = seat.setSessionEffort(sid, 'max', roster as never, dir)
check('with a stream in flight, set-effort PARKS', effortQueued.outcome === 'queued' && record()?.pendingEffort === 'max', JSON.stringify(effortQueued))

console.log(failures === 0 ? '\nprove-switch-while-agents-hold: ALL LAWS HOLD' : `\nprove-switch-while-agents-hold: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
