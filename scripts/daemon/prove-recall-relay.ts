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
const { standInRunner } = await import('../lib/seatDoor.ts')
const { RPC_METHOD_NOT_FOUND, RPC_REFUSED } = await import('../../src/runner/wire/errors.ts')
const { withdrawSessionSend } = seat

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

let stand = standInRunner({ autoAnswer: { 'session/facts': {} } })
let roster = stand.roster()
const pendingCount = (): number => stand.connection.peer.pendingCount

section('§1 the relay: the runner\'s withdraw_send control, its answer returned whole')
{
  const pending = withdrawSessionSend(SESSION, 'msg-1', roster, daemonDir)
  const f = await stand.nextRequest('queue/withdraw')
  check('the seat sent ONE request to the session\'s runner', stand.requests.length === 1, j(stand.requests.map(r => r.method)))
  check('the request is queue/withdraw carrying the identity', f.method === 'queue/withdraw' && j(f.params) === j({ id: 'msg-1' }), j(f.params))
  check('the request stands pending until the runner answers', pendingCount() === 1)
  f.answer({ withdrawn: true, text: 'the words that came back' })
  const out = await pending
  check('the runner\'s answer settles applied, withdrawn, with the words', out.outcome === 'applied' && out.withdrawn === true && out.text === 'the words that came back', j(out))
  check('nothing stays pending', pendingCount() === 0)
}

section('§2 the runner\'s typed refusals relay whole')
{
  const taken = withdrawSessionSend(SESSION, 'msg-2', roster, daemonDir)
  ;(await stand.nextRequest('queue/withdraw')).answer({ withdrawn: false, reason: 'taken' })
  const t = await taken
  check("taken: refused, withdrawn false, reason taken, a detail in words", t.outcome === 'refused' && t.withdrawn === false && t.reason === 'taken' && typeof t.detail === 'string' && t.detail.includes('already took'), j(t))
  const unknown = withdrawSessionSend(SESSION, 'msg-3', roster, daemonDir)
  ;(await stand.nextRequest('queue/withdraw')).answer({ withdrawn: false, reason: 'unknown' })
  const u = await unknown
  check("unknown: refused, withdrawn false, reason unknown", u.outcome === 'refused' && u.withdrawn === false && u.reason === 'unknown', j(u))
  const odd = withdrawSessionSend(SESSION, 'msg-4', roster, daemonDir)
  ;(await stand.nextRequest('queue/withdraw')).answer({ withdrawn: false, reason: 'something-else' })
  const o = await odd
  check('a reason outside the table\'s vocabulary is refused by the peer (the answer is not the shape the table declares), typed', o.outcome === 'refused' && o.withdrawn === undefined && (o.detail ?? '').includes('not the shape the table declares'), j(o))
}

section('§3 refusals are typed; an older runner names the restart; a runner that leaves answers every request')
{
  const older = withdrawSessionSend(SESSION, 'msg-5', roster, daemonDir)
  ;(await stand.nextRequest('queue/withdraw')).refuse(RPC_METHOD_NOT_FOUND, 'unknown method queue/withdraw', { method: 'queue/withdraw' })
  const o = await older
  check('an older runner\'s unknown method (-32601) names the daemon restart', o.outcome === 'refused' && o.withdrawn === undefined && (o.detail ?? '').includes('/daemon restart'), j(o))
  const plain = withdrawSessionSend(SESSION, 'msg-6', roster, daemonDir)
  ;(await stand.nextRequest('queue/withdraw')).refuse(RPC_REFUSED, 'the runner is busy elsewhere', { kind: 'queue' })
  const p = await plain
  check("any other refusal is the runner's own words, refused", p.outcome === 'refused' && p.detail === 'the runner is busy elsewhere', j(p))
  const a = withdrawSessionSend(SESSION, 'msg-7', roster, daemonDir)
  const b = withdrawSessionSend(SESSION, 'msg-8', roster, daemonDir)
  await stand.nextRequest('queue/withdraw')
  check('two requests stand pending (the queue scope serializes them inside the runner; the host holds both)', pendingCount() === 2, String(pendingCount()))
  stand.connection.close('the seat was relaunched')
  const [ra, rb] = await Promise.all([a, b])
  check('a runner that leaves mid-wait answers every withdraw refused, naming the departure', ra.outcome === 'refused' && rb.outcome === 'refused' && (ra.detail ?? '').includes('left before it answered the withdraw') && ra.withdrawn === undefined, j([ra, rb]))
  check('nothing stays pending', pendingCount() === 0)
  stand.close()
  stand = standInRunner({ autoAnswer: { 'session/facts': {} } })
  roster = stand.roster()
}

section('§4 the doors that never reach the runner')
{
  const before = stand.requests.length
  const stranger = await withdrawSessionSend('no-such-session', 'msg-9', roster, daemonDir)
  check('an unknown session refuses typed, no request sent', stranger.outcome === 'refused' && (stranger.detail ?? '').includes('unknown-session') && stand.requests.length === before, j(stranger))
  const empty = await withdrawSessionSend(SESSION, '', roster, daemonDir)
  check('an empty identity refuses typed, no request sent', empty.outcome === 'refused' && (empty.detail ?? '').includes('requires clientMessageId') && stand.requests.length === before, j(empty))
  const closed = await withdrawSessionSend(SESSION, 'msg-10', stand.roster({ door: () => undefined }), daemonDir)
  check('a seat with no door refuses typed', closed.outcome === 'refused' && (closed.detail ?? '').includes('no live runner door'), j(closed))
  const late = await withdrawSessionSend(SESSION, 'msg-11', roster, daemonDir, { deadlineMs: 60 })
  check('a runner silent past the deadline refuses typed, naming the wait', late.outcome === 'refused' && (late.detail ?? '').includes('did not answer the withdraw'), j(late))
  await new Promise(resolve => setTimeout(resolve, 20))
  check('…and the runner saw the request cancelled; nothing stays pending', stand.requests.at(-1)!.cancelled && pendingCount() === 0, j({ cancels: stand.cancels, pending: pendingCount() }))
}

section('§5 the wire: the reply keys, the router, the age, the runner\'s switch')
{
  const server = readFileSync(join(ROOT, 'src', 'daemon', 'controlServer.ts'), 'utf8')
  const keys = /const CONTROL_WIRE_KEYS = \[([^\]]+)\]/.exec(server)?.[1] ?? ''
  check("the daemon's sessionControl reply carries withdrawn, text and reason (the whole-reply guard admits them)", keys.includes("'withdrawn'") && keys.includes("'text'") && keys.includes("'reason'"), keys)
  check('the router admits the withdraw-send action and forwards clientMessageId', server.includes("raw.action === 'withdraw-send'") && server.includes('clientMessageId: raw.clientMessageId.slice(0, 128)'))
  check('the grammar\'s raw list names the action (a same-proto daemon never reads it as a version gap)', /requires \{ action: [^']*\|withdraw-send(\|[a-z-]+)*, sessionId, by \}/.test(server))
  check('the age table names the verb\'s birth at proto 9, never re-aged by a later verb', protocol.verbBornAt('sessionControl', 'withdraw-send') === 9 && protocol.MERCURY_DAEMON_PROTO >= 9, `${protocol.verbBornAt('sessionControl', 'withdraw-send')} vs ${protocol.MERCURY_DAEMON_PROTO}`)
  const main = readFileSync(join(ROOT, 'src', 'daemon', 'main.ts'), 'utf8')
  check("the daemon's action arm relays through the seat's one relay and requires the identity", main.includes("if (action === 'withdraw-send')") && main.includes('withdrawSessionSend(sessionId, clientMessageId, roster)') && main.includes("'withdraw-send requires clientMessageId'"))
  const runner = readFileSync(join(ROOT, 'src', 'cli', 'run.ts'), 'utf8')
  const arm = runner.slice(runner.indexOf("'queue/withdraw': params => {"), runner.indexOf("'session/set_mode': params => {"))
  check("the runner's arm owns the method: the queue's one pop by identity, a typed answer either way", arm.includes('popById(params.id)') && arm.includes('{ withdrawn: true, text: popped.text }') && arm.includes('{ withdrawn: false, reason: popped.reason }'))
  const methods = readFileSync(join(ROOT, 'src', 'runner', 'wire', 'methods.ts'), 'utf8')
  check("the door's method table carries queue/withdraw with the row's identity", methods.includes("'queue/withdraw': method({") && methods.includes("name: 'queue/withdraw'"))
}

stand.close()
rmSync(home, { recursive: true, force: true })
console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-recall-relay: ALL LAWS HOLD' : `prove-recall-relay: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
