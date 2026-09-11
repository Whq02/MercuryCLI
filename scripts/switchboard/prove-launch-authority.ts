;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'switchboard-launchauth-home-'))
delete process.env.MERCURY_CONCOURSE_WORKER

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const {
  blurConcourseSession,
  focusConcourseSession,
  grantConcourseWorkflows,
  readSessionWorkers,
  reconcileConcourseWorkers,
  revokeConcourseWorkflows,
  stampedTerminalPid,
  updateConcourseWorkers,
} = await import('../../src/daemon/concourseSupervisor.js')
const { evaluateLaunchAuthority } = await import('../../src/services/switchboard/launchAuthority.js')

const refusalFor = (kind: 'subagents' | 'workflows'): string =>
  `this session is backgrounded — ${kind} wait until the operator visits it, or until it holds the workflows-allowed tag (granted by asking the coordinator, choosing keep-and-background on leave, or the manual-start option). Keep working on the task single-handed.`

const recDir = mkdtempSync(join(tmpdir(), 'switchboard-launchauth-records-'))
const workspaceId = mkdtempSync(join(tmpdir(), 'switchboard-launchauth-ws-'))
const sidA = '550e8400-e29b-41d4-a716-4466554400a1'
const sidB = '550e8400-e29b-41d4-a716-4466554400b2'
const seat = `operator:${process.pid}`
const otherSeat = 'operator:1'
const liveShorts = new Set(['concourse-w1', 'concourse-w2'])

updateConcourseWorkers(ws => {
  ws['concourse-w1'] = {
    schema: 1, runnerId: 'concourse-w1', sessionId: sidA, workspaceId,
    isolation: 'exclusive', modelKey: 'claude-fable-5',
    spawnedAt: 1, lastLiveAt: Date.now(),
  }
  ws['concourse-w2'] = {
    schema: 1, runnerId: 'concourse-w2', sessionId: sidB, workspaceId,
    isolation: 'exclusive', modelKey: 'claude-fable-5',
    spawnedAt: 1, lastLiveAt: Date.now(),
  }
}, recDir)

const authorityOf = (sid: string, kind: 'subagents' | 'workflows' = 'workflows') =>
  evaluateLaunchAuthority(kind, { roleEnvOn: true, dir: recDir, sessionId: sid })
const recOf = (short: string) => readSessionWorkers(recDir)[short]

console.log("LAW B — unfocused ⇒ today's refusal, byte-for-byte:")
{
  const a = authorityOf(sidA)
  check('an unfocused, untagged runner is refused', a.allowed === false)
  check("the refusal string is byte-identical to today's (workflows)", !a.allowed && a.reason === refusalFor('workflows'))
  const s = authorityOf(sidA, 'subagents')
  check("the refusal string is byte-identical to today's (subagents)", !s.allowed && s.reason === refusalFor('subagents'))
}

console.log("LAW A — focused ⇒ admits under the session's own mode:")
{
  const out = focusConcourseSession(sidA, seat, recDir)
  check('focus applies on a live record', out.outcome === 'applied' && out.runnerId === 'concourse-w1')
  check('the record carries the stamp (focusedAt + focusedBy = the terminal seat)', typeof recOf('concourse-w1')?.focusedAt === 'number' && recOf('concourse-w1')?.focusedBy === seat)
  const w = authorityOf(sidA, 'workflows')
  check('workflows admit on the focused chat (posture focused)', w.allowed === true && w.posture === 'focused')
  const s = authorityOf(sidA, 'subagents')
  check('subagents admit on the focused chat (posture focused)', s.allowed === true && s.posture === 'focused')
  check('the OTHER chat stays grant-gated', authorityOf(sidB).allowed === false)
  check('focus of an unknown session is a typed refusal', focusConcourseSession('no-such-session', seat, recDir).outcome === 'refused')
}

console.log('LAW C — the hop flips both (one publication):')
{
  const hop = focusConcourseSession(sidB, seat, recDir)
  check('focus B applies and names A as the seat it left', hop.outcome === 'applied' && hop.cleared.includes('concourse-w1'))
  check('A lost the stamp', recOf('concourse-w1')?.focusedAt === undefined && recOf('concourse-w1')?.focusedBy === undefined)
  check('B carries the stamp', recOf('concourse-w2')?.focusedBy === seat)
  const a = authorityOf(sidA)
  check("A is refused again with today's string (nothing cached across the hop)", !a.allowed && a.reason === refusalFor('workflows'))
  check('B admits', authorityOf(sidB).allowed === true)
  check('re-focusing the focused chat is a noop', focusConcourseSession(sidB, seat, recDir).outcome === 'noop')
  check('exactly one focused record per terminal', Object.values(readSessionWorkers(recDir)).filter(r => r.focusedBy === seat).length === 1)
}

console.log('LAW D — blur gives the seat back; another terminal never takes it:')
{
  check('a blur by ANOTHER terminal is a noop (never clears a seat it does not own)', blurConcourseSession(sidB, otherSeat, recDir).outcome === 'noop')
  check('B still admits after the foreign blur', authorityOf(sidB).allowed === true)
  const blur = blurConcourseSession(sidB, seat, recDir)
  check("blur by the seat's own terminal applies", blur.outcome === 'applied')
  check('B is refused after the blur', authorityOf(sidB).allowed === false)
  check('a second blur is a noop', blurConcourseSession(sidB, seat, recDir).outcome === 'noop')
  check('the stamp is gone from the record', recOf('concourse-w2')?.focusedAt === undefined)
}

console.log('LAW E — a dead seat is no seat:')
{
  const deadPid = spawnSync('true').pid!
  const isDead = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  }
  check("the prover's dead-pid fixture is dead", deadPid > 0 && isDead(deadPid))
  updateConcourseWorkers(ws => {
    ws['concourse-w1']!.focusedAt = Date.now()
    ws['concourse-w1']!.focusedBy = `operator:${deadPid}`
  }, recDir)
  check('stampedTerminalPid reads the seat grammar', stampedTerminalPid(`operator:${deadPid}`) === deadPid && stampedTerminalPid('operator') === undefined && stampedTerminalPid(undefined) === undefined)
  const a = authorityOf(sidA)
  check('a stamp naming a dead terminal is refused at the valve AT ONCE', !a.allowed && a.reason === refusalFor('workflows'))
  focusConcourseSession(sidB, seat, recDir)
  reconcileConcourseWorkers(liveShorts, recDir)
  check('the reconcile pass cleared the dead-pid stamp durably', recOf('concourse-w1')?.focusedAt === undefined && recOf('concourse-w1')?.focusedBy === undefined)
  check('the live-pid stamp survived the reconcile', recOf('concourse-w2')?.focusedBy === seat)
  check('the reconcile left both records live (no crash fact from the heal)', recOf('concourse-w1')?.crash === undefined && recOf('concourse-w2')?.crash === undefined)
  updateConcourseWorkers(ws => {
    ws['concourse-w1']!.focusedAt = Date.now()
    ws['concourse-w1']!.focusedBy = 'someone-else'
  }, recDir)
  check('a stamp naming no pid is refused at the valve', authorityOf(sidA).allowed === false)
  reconcileConcourseWorkers(liveShorts, recDir)
  check('the reconcile pass clears a stamp naming no pid', recOf('concourse-w1')?.focusedAt === undefined)
  blurConcourseSession(sidB, seat, recDir)
}

console.log('LAW F — the tag arm is untouched:')
{
  check('grant applies to the unfocused B', grantConcourseWorkflows(sidB, 'operator', recDir).outcome === 'applied')
  const tagged = authorityOf(sidB)
  check('tagged + unfocused still admits as tagged-background', tagged.allowed === true && tagged.posture === 'tagged-background')
  focusConcourseSession(sidB, seat, recDir)
  const both = authorityOf(sidB)
  check('focused outranks the tag (posture focused)', both.allowed === true && both.posture === 'focused')
  blurConcourseSession(sidB, seat, recDir)
  check('revoke applies', revokeConcourseWorkflows(sidB, 'operator', recDir).outcome === 'applied')
  check('untagged + unfocused is refused again', authorityOf(sidB).allowed === false)
}

console.log("LAW G — an ended record is nobody's seat:")
{
  focusConcourseSession(sidA, seat, recDir)
  check('A admits while focused', authorityOf(sidA).allowed === true)
  updateConcourseWorkers(ws => {
    ws['concourse-w1']!.endedAt = Date.now()
  }, recDir)
  check("an ended record's stamp opens nothing", authorityOf(sidA).allowed === false)
  check('focus of an ended session is a typed refusal', focusConcourseSession(sidA, seat, recDir).outcome === 'refused')
}

console.log('LAW H — the wire (source pins):')
{
  const src = (rel: string): string => readFileSync(join(import.meta.dirname, '../../', rel), 'utf8')
  const connector = src('src/services/engine-connector/daemonConnector.ts')
  const attachStart = connector.indexOf('  attach(): Promise<void> {')
  const attachBody = connector.slice(attachStart, connector.indexOf('\n  }\n', attachStart))
  const detachStart = connector.indexOf('  detach(): void {')
  const detachBody = connector.slice(detachStart, connector.indexOf('\n  }\n', detachStart))
  check("the connector's attach carries focus", attachStart !== -1 && attachBody.includes("seatVerb('focus', this.record.sessionId)"))
  check("the connector's detach carries blur", detachStart !== -1 && detachBody.includes("seatVerb('blur', this.record.sessionId)"))
  check('every word sent from the focused chat re-asserts the seat', connector.includes("if (this.isAttached()) seatVerb('focus', this.record.sessionId)"))
  check('the verbs ride ONE module-level chain (never a per-connector rpc)', connector.includes('let seatChain: Promise<unknown> = Promise.resolve()') && connector.includes('seatChain = seatChain'))
  check("the seat is the terminal's own pid in the attachedBy grammar", connector.includes('const SEAT_BY = `operator:${process.pid}`'))
  const server = src('src/daemon/controlServer.ts')
  check('the control server admits both verbs', server.includes("raw.action === 'focus'") && server.includes("raw.action === 'blur'"))
  const protocol = src('src/daemon/protocol.ts')
  check('the wire type names both verbs', protocol.includes("| 'focus'") && protocol.includes("| 'blur'"))
  const daemon = src('src/daemon/main.ts')
  const handlerAt = daemon.indexOf("if (action === 'focus' || action === 'blur')")
  const handlerBody = handlerAt === -1 ? '' : daemon.slice(handlerAt, handlerAt + 1200)
  check('the daemon handler exists and writes the focus fact through the two record verbs', handlerAt !== -1 && handlerBody.includes("action === 'focus' ? focusConcourseSession(sessionId, by") && handlerBody.includes('blurConcourseSession(sessionId, by)'))
  const valve = src('src/services/switchboard/launchAuthority.ts')
  const focusedArmAt = valve.indexOf("posture: 'focused'")
  const tagArmAt = valve.indexOf("posture: 'tagged-background'")
  check("the valve's focused arm stands BEFORE the tag arm", focusedArmAt !== -1 && tagArmAt !== -1 && focusedArmAt < tagArmAt)
  check('the valve trusts a stamp only while its terminal is alive', valve.includes('isProcessAlive(seatPid)'))
  const supervisor = src('src/daemon/concourseSupervisor.ts')
  const settleStart = supervisor.indexOf('export function settleConcourseWorker(')
  const settleBody = supervisor.slice(settleStart, supervisor.indexOf('\n}\n', settleStart))
  check('settle deletes the fact with the record', settleStart !== -1 && settleBody.includes('delete rec.focusedAt') && settleBody.includes('delete rec.focusedBy'))
  const hopSrc = src('src/services/switchboard/hopIntoSession.ts')
  check('no hop mints the dead-child attach stamp (the rejected alternative stays rejected)', !hopSrc.includes("action: 'attach'") && !hopSrc.includes('attachedAt'))
  check('the doctrine line this makes true still stands', src('src/services/concourse/coordinatorTools.ts').includes('a session with them keeps its own doctrine'))
}

console.log(failures === 0 ? '\nprove-launch-authority: ALL LAWS HOLD' : `\nprove-launch-authority: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
