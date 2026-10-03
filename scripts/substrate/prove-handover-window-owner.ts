#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

const ROOT = join(import.meta.dir, '..', '..')
const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const handover = await import('../../src/daemon/handover.ts')

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
  check('the runner the list named is held by the predecessor', state.holds('concourse-w1'))
  check('a runner admitted after the list read is held by the predecessor too', state.holds('concourse-w2'), `held: ${[...state.heldRunners()].join(',')}`)
  check('…and the predecessor owns it', state.ownerOf('concourse-w2') === me, String(state.ownerOf('concourse-w2')))
  check('a verb naming that session goes to the predecessor', handover.handoverRoadOf('sessionControl', { sessionId: 'sess-window' }, state) === 'predecessor' && state.socketFor({ short: 'concourse-w2' }) === handover.predecessorSockPath(me))
  check('a record from before the read that no helper named is nobody\'s', !state.holds('concourse-w3'))
  check('an ended record and a rostered one are not held', !state.holds('concourse-w5') && !state.holds('concourse-w9'))
  check('the predecessor\'s held set counts the window record once', state.heldRunners(me).size === 3 && state.heldRunners(me).has('concourse-w2') && state.heldRunners(me).has('concourse-w4'))
  state.notePlaneMoved(LISTED_AT + 1_000)
  check('once the plane moved, a record spawned after the move is not the predecessor\'s', !state.holds('concourse-w4') && state.holds('concourse-w2'), `held: ${[...state.heldRunners()].join(',')}`)
  check('a verb naming the post-move session stays here', handover.handoverRoadOf('sessionControl', { sessionId: 'sess-after' }, state) === 'here')
}

section('§2 a helper that answered no list keeps every unnamed live record (the catch-all)')
{
  const state = handover.handoverState(me, rosterHas, () => records)
  check('the default host holds the named, the window and the pre-read records alike', state.holds('concourse-w1') && state.holds('concourse-w2') && state.holds('concourse-w3') && state.holds('concourse-w4'))
  check('…and not ours or the ended one', !state.holds('concourse-w9') && !state.holds('concourse-w5'))
}

section('§3 two helpers: the window record is the plane holder\'s, not the unnamed older one\'s')
{
  const state = handover.handoverState(me, rosterHas, () => records, [
    { pid: me, runners: ['concourse-w1'], listedAt: LISTED_AT },
    { pid: older, runners: null },
  ])
  check('the window record belongs to the direct predecessor (the plane holder when it was admitted)', state.ownerOf('concourse-w2') === me, String(state.ownerOf('concourse-w2')))
  check('a pre-read record nobody named falls to the helper that answered no list', state.ownerOf('concourse-w3') === older, String(state.ownerOf('concourse-w3')))
  check('each held runner forwards to its own owner\'s socket', state.socketFor({ sessionId: 'sess-window' }) === handover.predecessorSockPath(me) && state.socketFor({ sessionId: 'sess-nobody' }) === handover.predecessorSockPath(older))
  check('the per-helper held sets split the same way', state.heldRunners(me).has('concourse-w2') && !state.heldRunners(me).has('concourse-w3') && state.heldRunners(older).has('concourse-w3'))
}

section('§4 the clocks are stamped where the reads happen, and the update verb reads every helper')
{
  const handoverTs = src('src/daemon/handover.ts')
  const listRead = /const listedAt = Date\.now\(\)\s*\n\s*const list = await forwardFrame\(path, JSON\.stringify\(\{ op: 'list'/.test(handoverTs)
  check('readHandoverHosts takes the clock before it sends the list and stamps it on the host', listRead && handoverTs.includes('listedAt } : { pid, runners: null }'))
  const mainTs = src('src/daemon/main.ts')
  check('the daemon marks the plane moved right after the rename', /renameSocketForPredecessor\(handoverPredecessor\)\s*\n\s*handover\.notePlaneMoved\(\)/.test(mainTs))
  const updateTs = src('src/cli/update.ts')
  check('the installer road reads the hosted caller over every helper of the home', updateTs.includes('hostedCallerOf(await helperPidsOfHome())') && !updateTs.includes('hostedCallerOf(d.pid)'))
  check('…and refuses only when the restart would run now (the shared predicate)', updateTs.includes('restartEndsHostedCaller(first)') && !/hosted && \(first\.heal === 'operator' \|\| first\.live === 0\)/.test(updateTs))
  check('an armed restart prints the daemon\'s own detail, else the counted noun with its verb', updateTs.includes('when idle — ${reply.detail}') && updateTs.includes('${finishVerb(reply.live)}'))
}

rmSync(home, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-handover-window-owner: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-handover-window-owner: all green')
