#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const home = mkdtempSync(join(tmpdir(), 'handover-window-home-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
delete process.env.MERCURY_HOME

const handover = await import('../../src/daemon/control/handover.ts')

const me = process.pid
const older = process.ppid
const LISTED_AT = 1_700_000_000_000
const records = [
  { runnerId: 'concourse-w1', sessionId: 'sess-named', pid: me, spawnedAt: LISTED_AT - 60_000 },
  { runnerId: 'concourse-w2', sessionId: 'sess-window', pid: me, spawnedAt: LISTED_AT + 12 },
  { runnerId: 'concourse-w3', sessionId: 'sess-nobody', pid: me, spawnedAt: LISTED_AT - 5_000 },
  { runnerId: 'concourse-w4', sessionId: 'sess-after', pid: me, spawnedAt: LISTED_AT + 5_000 },
  { runnerId: 'concourse-w5', sessionId: 'sess-ended', pid: me, spawnedAt: LISTED_AT + 20, endedAt: LISTED_AT + 30 },
  { runnerId: 'concourse-w9', sessionId: 'sess-ours', pid: me, spawnedAt: LISTED_AT + 40 },
]
const rosterHas = (short: string): boolean => short === 'concourse-w9'

section('§1 the window: a record the list did not name, spawned after the read, is the plane holder\'s')
{
  const state = handover.handoverState(me, rosterHas, () => records, [{ pid: me, runners: ['concourse-w1'], listedAt: LISTED_AT }])
  check('the runner the list named is held by the predecessor', state.holds('concourse-w1'), 'a runner named in a helper list must be held by that helper: see handoverState in src/daemon/control/handover.ts')
  check('a runner admitted after the list read is held by the predecessor too', state.holds('concourse-w2'), `held: ${[...state.heldRunners()].join(',')}; a record spawned after listedAt belongs to the plane holder: see handoverState in src/daemon/control/handover.ts`)
  check('…and the predecessor owns it', state.ownerOf('concourse-w2') === me, `${String(state.ownerOf('concourse-w2'))}; ownerOfRecord in handoverState (src/daemon/control/handover.ts) should return the predecessor pid for a window record`)
  check('a verb naming that session goes to the predecessor', handover.handoverRoadOf('sessionControl', { sessionId: 'sess-window' }, state) === 'predecessor' && state.socketFor({ short: 'concourse-w2' }) === handover.predecessorSockPath(me), 'handoverRoadOf and socketFor in src/daemon/control/handover.ts must route a held session to the predecessor socket')
  check('a record from before the read that no helper named is nobody\'s', !state.holds('concourse-w3'), 'handoverState in src/daemon/control/handover.ts must not hold an unnamed record older than listedAt when a list was answered')
  check('an ended record and a rostered one are not held', !state.holds('concourse-w5') && !state.holds('concourse-w9'), 'handoverState in src/daemon/control/handover.ts must skip records with endedAt and records the roster has')
  check('the predecessor\'s held set counts the window record once', state.heldRunners(me).size === 3 && state.heldRunners(me).has('concourse-w2') && state.heldRunners(me).has('concourse-w4'), `held by predecessor: ${[...state.heldRunners(me)].join(',')}; see heldRunners in handoverState (src/daemon/control/handover.ts)`)
  state.notePlaneMoved(LISTED_AT + 1_000)
  check('once the plane moved, a record spawned after the move is not the predecessor\'s', !state.holds('concourse-w4') && state.holds('concourse-w2'), `held: ${[...state.heldRunners()].join(',')}; notePlaneMoved in handoverState (src/daemon/control/handover.ts) must stop claiming records spawned after the move`)
  check('a verb naming the post-move session stays here', handover.handoverRoadOf('sessionControl', { sessionId: 'sess-after' }, state) === 'here', 'handoverRoadOf in src/daemon/control/handover.ts must answer here for a session spawned after notePlaneMoved')
}

section('§2 a helper that answered no list keeps every unnamed live record (the catch-all)')
{
  const state = handover.handoverState(me, rosterHas, () => records)
  check('the default host holds the named, the window and the pre-read records alike', state.holds('concourse-w1') && state.holds('concourse-w2') && state.holds('concourse-w3') && state.holds('concourse-w4'), 'with no helper list, handoverState in src/daemon/control/handover.ts must hold every live unnamed record')
  check('…and not ours or the ended one', !state.holds('concourse-w9') && !state.holds('concourse-w5'), 'handoverState in src/daemon/control/handover.ts must skip rostered and ended records in the catch-all too')
}

section('§3 two helpers: the window record is the plane holder\'s, not the unnamed older one\'s')
{
  const state = handover.handoverState(me, rosterHas, () => records, [
    { pid: me, runners: ['concourse-w1'], listedAt: LISTED_AT },
    { pid: older, runners: null },
  ])
  check('the window record belongs to the direct predecessor (the plane holder when it was admitted)', state.ownerOf('concourse-w2') === me, `${String(state.ownerOf('concourse-w2'))}; ownerOfRecord in handoverState (src/daemon/control/handover.ts) should give a window record to the direct predecessor`)
  check('a pre-read record nobody named falls to the helper that answered no list', state.ownerOf('concourse-w3') === older, `${String(state.ownerOf('concourse-w3'))}; ownerOfRecord in handoverState (src/daemon/control/handover.ts) should give an unnamed pre-read record to the helper that answered no list`)
  check('each held runner forwards to its own owner\'s socket', state.socketFor({ sessionId: 'sess-window' }) === handover.predecessorSockPath(me) && state.socketFor({ sessionId: 'sess-nobody' }) === handover.predecessorSockPath(older), 'socketFor in handoverState (src/daemon/control/handover.ts) must return the owner helper\'s socket path')
  check('the per-helper held sets split the same way', state.heldRunners(me).has('concourse-w2') && !state.heldRunners(me).has('concourse-w3') && state.heldRunners(older).has('concourse-w3'), 'heldRunners(pid) in handoverState (src/daemon/control/handover.ts) must filter by owner')
}


rmSync(home, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-handover-window-owner: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-handover-window-owner: all green')
