#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)
const home = mkdtempSync(join(tmpdir(), 'recall-relay-'))
process.env.MERCURY_CONFIG_DIR = join(home, 'config')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
const daemonDir = join(home, 'daemon')
mkdirSync(daemonDir, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '9.9.9' }

const seat = await import('../../src/daemon/sessionSeat.ts')
const protocol = await import('../../src/daemon/protocol.ts')
const { withdrawSessionSend, onSeatLine, _pendingWithdrawWaitersForTesting } = seat

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)

const RUNNER = 'runner-1'
const SESSION = 'session-1'
writeFileSync(
  join(daemonDir, 'concourse-workers.json'),
  JSON.stringify({ version: 1, workers: { [RUNNER]: { schema: 1, runnerId: RUNNER, sessionId: SESSION, workspaceId: '/ws', isolation: 'exclusive', modelKey: 'm', spawnedAt: 1, lastLiveAt: 1 } } }),
)

type Frame = { type: string; request_id: string; request: { subtype: string; client_message_id?: string } }
const frames: Array<{ short: string; frame: Frame }> = []
let channelOpen = true
const roster: Parameters<typeof withdrawSessionSend>[2] = {
  control: (short, frame) => {
    if (!channelOpen) return false
    frames.push({ short, frame: JSON.parse(frame) as Frame })
    return true
  },
  list: () => [],
  patchSeatModel: () => true,
  patchSeatEffort: () => true,
}
const lastFrame = (): Frame => frames[frames.length - 1]!.frame
const answer = (requestId: string, response: Record<string, unknown>): void =>
  onSeatLine(RUNNER, JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } }), roster, daemonDir)
const refuse = (requestId: string, error: string): void =>
  onSeatLine(RUNNER, JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } }), roster, daemonDir)

section('§1 the relay: the runner\'s withdraw_send control, its answer returned whole')
{
  const pending = withdrawSessionSend(SESSION, 'msg-1', roster, daemonDir)
  check('the seat wrote ONE control frame to the session\'s runner', frames.length === 1 && frames[0]!.short === RUNNER, j(frames))
  const f = lastFrame()
  check('the frame is a control_request of subtype withdraw_send carrying the identity', f.type === 'control_request' && f.request.subtype === 'withdraw_send' && f.request.client_message_id === 'msg-1', j(f))
  check('the request id wears the seat\'s withdraw family', f.request_id.startsWith('mercury-seat-withdraw-'), f.request_id)
  check('the waiter stands until the runner answers', _pendingWithdrawWaitersForTesting() === 1)
  answer(f.request_id, { withdrawn: true, text: 'the words that came back' })
  const out = await pending
  check('the runner\'s success answer settles applied, withdrawn, with the words', out.outcome === 'applied' && out.withdrawn === true && out.text === 'the words that came back', j(out))
  check('the waiter is gone', _pendingWithdrawWaitersForTesting() === 0)
}

section('§2 the runner\'s typed refusals relay whole')
{
  const taken = withdrawSessionSend(SESSION, 'msg-2', roster, daemonDir)
  answer(lastFrame().request_id, { withdrawn: false, reason: 'taken' })
  const t = await taken
  check("taken: refused, withdrawn false, reason taken, a detail in words", t.outcome === 'refused' && t.withdrawn === false && t.reason === 'taken' && typeof t.detail === 'string' && t.detail.includes('already took'), j(t))
  const unknown = withdrawSessionSend(SESSION, 'msg-3', roster, daemonDir)
  answer(lastFrame().request_id, { withdrawn: false, reason: 'unknown' })
  const u = await unknown
  check("unknown: refused, withdrawn false, reason unknown", u.outcome === 'refused' && u.withdrawn === false && u.reason === 'unknown', j(u))
  const odd = withdrawSessionSend(SESSION, 'msg-4', roster, daemonDir)
  answer(lastFrame().request_id, { withdrawn: false, reason: 'something-else' })
  const o = await odd
  check('a reason outside the vocabulary reads unknown (never a cast-through)', o.outcome === 'refused' && o.reason === 'unknown', j(o))
}

section('§3 error frames: typed refusals; an older runner names the restart; a runner\'s end answers every waiter')
{
  const older = withdrawSessionSend(SESSION, 'msg-5', roster, daemonDir)
  refuse(lastFrame().request_id, 'unsupported control request subtype: withdraw_send')
  const o = await older
  check('an older runner\'s unsupported-subtype refusal names the daemon restart', o.outcome === 'refused' && o.withdrawn === undefined && (o.detail ?? '').includes('/daemon restart'), j(o))
  const plain = withdrawSessionSend(SESSION, 'msg-6', roster, daemonDir)
  refuse(lastFrame().request_id, 'the runner is busy elsewhere')
  const p = await plain
  check("any other error is the runner's own words, refused", p.outcome === 'refused' && p.detail === 'the runner is busy elsewhere', j(p))
  const a = withdrawSessionSend(SESSION, 'msg-7', roster, daemonDir)
  const b = withdrawSessionSend(SESSION, 'msg-8', roster, daemonDir)
  check('two waiters stand', _pendingWithdrawWaitersForTesting() === 2)
  seat.onSeatSpawned(RUNNER, roster, daemonDir)
  const [ra, rb] = await Promise.all([a, b])
  check('a runner that restarts mid-wait answers every withdraw refused, naming the restart', ra.outcome === 'refused' && rb.outcome === 'refused' && (ra.detail ?? '').includes('restarted before it answered the withdraw') && ra.withdrawn === undefined, j([ra, rb]))
  check('no waiter is left behind', _pendingWithdrawWaitersForTesting() === 0)
  const source = readFileSync(join(ROOT, 'src', 'daemon', 'sessionSeat.ts'), 'utf8')
  check("the runner's end answers the waiters the same way (both reject sites call the withdraw reaper)", (source.match(/rejectWithdrawWaiters\(short,/g) ?? []).length === 2, `${(source.match(/rejectWithdrawWaiters\(short,/g) ?? []).length} reject sites`)
}

section('§4 the doors that never reach the runner')
{
  const before = frames.length
  const stranger = await withdrawSessionSend('no-such-session', 'msg-9', roster, daemonDir)
  check('an unknown session refuses typed, no frame written', stranger.outcome === 'refused' && (stranger.detail ?? '').includes('unknown-session') && frames.length === before, j(stranger))
  const empty = await withdrawSessionSend(SESSION, '', roster, daemonDir)
  check('an empty identity refuses typed, no frame written', empty.outcome === 'refused' && (empty.detail ?? '').includes('requires clientMessageId') && frames.length === before, j(empty))
  channelOpen = false
  const closed = await withdrawSessionSend(SESSION, 'msg-10', roster, daemonDir)
  check('a runner with no control channel refuses typed', closed.outcome === 'refused' && (closed.detail ?? '').includes('no live control channel'), j(closed))
  channelOpen = true
  const late = await withdrawSessionSend(SESSION, 'msg-11', roster, daemonDir, { deadlineMs: 60 })
  check('a runner silent past the deadline refuses typed, naming the wait', late.outcome === 'refused' && (late.detail ?? '').includes('did not answer the withdraw'), j(late))
  check('no waiter is left behind', _pendingWithdrawWaitersForTesting() === 0)
}

section('§5 the wire: the reply keys, the router, the age, the runner\'s switch')
{
  const server = readFileSync(join(ROOT, 'src', 'daemon', 'controlServer.ts'), 'utf8')
  const keys = /const CONTROL_WIRE_KEYS = \[([^\]]+)\]/.exec(server)?.[1] ?? ''
  check("the daemon's sessionControl reply carries withdrawn, text and reason (the whole-reply guard admits them)", keys.includes("'withdrawn'") && keys.includes("'text'") && keys.includes("'reason'"), keys)
  check('the router admits the withdraw-send action and forwards clientMessageId', server.includes("raw.action === 'withdraw-send'") && server.includes('clientMessageId: raw.clientMessageId.slice(0, 128)'))
  check('the grammar\'s raw list names the action (a same-proto daemon never reads it as a version gap)', /requires \{ action: [^']*\|withdraw-send, sessionId, by \}/.test(server))
  check('the age table names the verb\'s birth at the proto this build speaks', protocol.verbBornAt('sessionControl', 'withdraw-send') === protocol.MERCURY_DAEMON_PROTO && protocol.MERCURY_DAEMON_PROTO >= 9, `${protocol.verbBornAt('sessionControl', 'withdraw-send')} vs ${protocol.MERCURY_DAEMON_PROTO}`)
  const main = readFileSync(join(ROOT, 'src', 'daemon', 'main.ts'), 'utf8')
  check("the daemon's action arm relays through the seat's one relay and requires the identity", main.includes("if (action === 'withdraw-send')") && main.includes('withdrawSessionSend(sessionId, clientMessageId, roster)') && main.includes("'withdraw-send requires clientMessageId'"))
  const runner = readFileSync(join(ROOT, 'src', 'cli', 'print.ts'), 'utf8')
  const arm = runner.slice(runner.indexOf("case 'withdraw_send': {"), runner.indexOf("case 'end_session': {"))
  check("the runner's switch owns the subtype: the queue's one pop by identity, a typed answer either way", arm.includes('popById(String(request.client_message_id') && arm.includes('{ withdrawn: true, text: popped.text }') && arm.includes('{ withdrawn: false, reason: popped.reason }'))
  const types = readFileSync(join(ROOT, 'src', 'entrypoints', 'sdk', 'controlTypes.ts'), 'utf8')
  check('the control request union carries the subtype', types.includes("subtype: 'withdraw_send'") && types.includes('| SDKControlWithdrawSendRequest'))
}

rmSync(home, { recursive: true, force: true })
console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-recall-relay: ALL LAWS HOLD' : `prove-recall-relay: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
