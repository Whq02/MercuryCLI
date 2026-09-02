#!/usr/bin/env bun
// ============================================================================
//  scripts/daemon/prove-close-all.ts — CLOSE-ALL EMPTIES THE BRIDGE (law 3
//  of the reactivation lifecycle) and the quit
//  that parks everything. Pure + file-level; the daemon's park verbs run
//  for real over a scratch records dir with a scripted roster; the roads
//  through the screen and the daemon's teardown are pinned in source.
//
//   Q1  THE QUIT STORY (executed): the estate at the moment the screen
//       dies — an idle session, one mid-turn, a newborn, a stopped row, a
//       chat another live terminal holds — goes through park-all exactly as
//       the orphan reap runs it: idle ⇒ parked at once; mid-turn ⇒ a park
//       request, no kill; newborn ⇒ released; stopped ⇒ untouched; the
//       runner's own turn-settled edge completes the requested park; the
//       drain set empties; a request still standing at the ceiling is cut
//       with the ruled reason; the NEXT boot's reconcile finds every one of
//       them PARKED — never a crash row (the poison: "found dead with its
//       daemon" on a chat the operator merely quit);
//   Q2  THE DRAIN KNOB: MERCURY_SESSION_PARK_DRAIN_MINUTES — default 10,
//       minutes when set, 0 ⇒ no wait; a registered row with its consumer;
//   Q3  THE ONE CLOSE PATH (source): closeFocusedChat parks by default and
//       ends for x-x, rests the slot LAST (the connector's detach says the
//       blur), speaks the terminal's own seat; /clear rides it with the
//       park fate BEFORE the birth and never a release;
//   Q4  THE QUIT IS ARMED (source): every interactive boot registers the
//       cleanup; the cleanup says park-all under the terminal's seat within
//       its budget; the daemon's park-all keeps another live terminal's chat;
//       the owned daemon's orphan reap parks-all, drains under the ceiling,
//       cuts with the reason, then shuts down — latched;
//   Q5  THE ONLY SESSION (the operator's repro, source): releasing the last
//       row rests the slot and the board stays (no menu call in the release
//       road); a refusal paints the daemon's own sentence, never a bare
//       "stop refused"; with no daemon a dead runner is stopped/settled in
//       the record directly, a live one never ended invisibly;
//   Q6  THE REFUSED BIRTH (executed + source): a chat-forward boot whose
//       birth was refused retracts its explicit journey so the Boot face is
//       the first frame (no settle-long flash of the empty chat).
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConcourseWorkerRecordV1 } from '../../src/daemon/concourseSupervisor.ts'

const SCRATCH = mkdtempSync(join(tmpdir(), 'close-all-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
delete process.env.MERCURY_HOME
delete process.env.MERCURY_SESSION_PARK_DRAIN_MINUTES
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

const sup = await import('../../src/daemon/concourseSupervisor.ts')
const idle = await import('../../src/daemon/idleRetirement.ts')
const handover = await import('../../src/substrate/splashHandover.ts')
const dir = process.env.MERCURY_DAEMON_DIR!
const DEAD_PID = 2_147_000_000
const T = 10 * 60_000
const now = Date.now()
const sid = (tail: string): string => `00000000-cccc-4000-8000-${tail.padStart(12, '0')}`

function seed(records: Array<Partial<ConcourseWorkerRecordV1> & { runnerId: string; sessionId: string }>): void {
  sup.updateConcourseWorkers(workers => {
    for (const key of Object.keys(workers)) delete workers[key]
    for (const r of records) {
      workers[r.runnerId] = {
        schema: 1,
        workspaceId: SCRATCH,
        isolation: 'exclusive',
        modelKey: 'claude-sonnet-5',
        spawnedAt: now - 3 * T,
        lastLiveAt: now - 3 * T,
        ...r,
      } as ConcourseWorkerRecordV1
    }
  }, dir)
}
const rec = (runnerId: string): ConcourseWorkerRecordV1 | undefined => sup.readSessionWorkers(dir)[runnerId]
const killed: string[] = []
const roster = { kill: (short: string): boolean => (killed.push(short), true) }

// ── Q1: the quit story ──────────────────────────────────────────────────────
console.log('Q1 the quit story: the screen dies, the estate parks, the next boot finds it parked')
{
  seed([
    { runnerId: 'concourse-w1', sessionId: sid('1'), pid: process.pid, lastDeliveryAt: now - T, lastTurnSettledAt: now - T + 5, focusedAt: now, focusedBy: `operator:${process.pid}` },
    { runnerId: 'concourse-w2', sessionId: sid('2'), pid: process.pid, lastDeliveryAt: now - 1000, lastTurnSettledAt: now - 5000 },
    { runnerId: 'concourse-w3', sessionId: sid('3'), pid: process.pid, bornBlankAt: now - T },
    { runnerId: 'concourse-w4', sessionId: sid('4'), pid: DEAD_PID, stoppedAt: now - T, stoppedBy: 'operator' },
    { runnerId: 'concourse-w5', sessionId: sid('5'), pid: process.pid, lastDeliveryAt: now - 1000, lastTurnSettledAt: now - 5000 },
  ])
  killed.length = 0
  const receipt = sup.parkAllConcourseSessions('daemon:owner-orphaned', roster, dir)
  check('idle ⇒ parked at once (killed; the focus stamp of the dead screen ends with the close)', receipt.parked.includes('concourse-w1') && killed.includes('concourse-w1') && rec('concourse-w1')?.parkedAt !== undefined && rec('concourse-w1')?.focusedAt === undefined)
  check('mid-turn ⇒ a park request, NO kill (the runner finishes its own turn)', receipt.draining.sort().join(',') === 'concourse-w2,concourse-w5' && !killed.includes('concourse-w2') && !killed.includes('concourse-w5') && rec('concourse-w2')?.parkRequestedAt !== undefined && rec('concourse-w2')?.parkedAt === undefined)
  check('newborn ⇒ released (nothing to bring back)', receipt.released.join(',') === 'concourse-w3' && rec('concourse-w3')?.endedAt !== undefined)
  check("stopped ⇒ untouched (the operator's own state)", receipt.skipped.join(',') === 'concourse-w4' && rec('concourse-w4')?.stoppedAt !== undefined && rec('concourse-w4')?.parkedAt === undefined)
  check('the drain set names the mid-turn runners', sup.pendingParkRequests(dir).sort().join(',') === 'concourse-w2,concourse-w5')
  // w2's turn settles: the idle edge completes its park.
  sup.updateConcourseWorkers(ws => { ws['concourse-w2']!.lastTurnSettledAt = now }, dir)
  check("the runner's own turn-settled edge completes the park (killed, parked, the request cleared)", sup.completeRequestedPark('concourse-w2', roster, dir) && killed.includes('concourse-w2') && rec('concourse-w2')?.parkedAt !== undefined && rec('concourse-w2')?.parkRequestedAt === undefined)
  check('the drain set shrinks to the one still working', sup.pendingParkRequests(dir).join(',') === 'concourse-w5')
  // w5 is still mid-turn at the ceiling: the quit path cuts it with the ruled reason.
  const cut = sup.parkConcourseSession(sid('5'), 'daemon:owner-orphaned', roster, dir, { afterTurn: false, reason: sup.PARK_DRAIN_CUT_REASON })
  check('a request still standing at the ceiling is cut: parked now, the row says so', cut.outcome === 'applied' && killed.includes('concourse-w5') && rec('concourse-w5')?.parkReason === 'parked — turn cut at the drain ceiling' && sup.pendingParkRequests(dir).length === 0)
  // The next boot: every runner is dead with the old daemon; the reconcile
  // finds the parked records PARKED — never a crash row.
  sup.updateConcourseWorkers(ws => { for (const w of Object.values(ws)) if (w.endedAt === undefined) w.pid = DEAD_PID }, dir)
  const reconcile = sup.reconcileConcourseWorkers(new Set(), dir)
  const onBoard = Object.values(sup.readSessionWorkers(dir)).filter(r => r.endedAt === undefined)
  check('the next boot finds every closed chat PARKED — no crash rows, nothing released', reconcile.settled.length === 0 && reconcile.parked.sort().join(',') === 'concourse-w1,concourse-w2,concourse-w5' && onBoard.every(r => r.crash === undefined), JSON.stringify(reconcile))
  check("the stopped row keeps the operator's stop; the newborn stays released", rec('concourse-w4')?.stoppedAt !== undefined && rec('concourse-w3')?.endedAt !== undefined)
  // POISON CONTROL: the same estate WITHOUT the park-all (a hard death) is
  // exactly the crash law — found dead with its daemon.
  seed([{ runnerId: 'concourse-w9', sessionId: sid('9'), pid: DEAD_PID, lastDeliveryAt: now - T, lastTurnSettledAt: now - T + 5 }])
  const hard = sup.reconcileConcourseWorkers(new Set(), dir)
  check("POISON CONTROL: a hard death (no park written) still paints the crash row — the crash-row law stands", hard.settled.includes('concourse-w9') && rec('concourse-w9')?.crash !== undefined && rec('concourse-w9')?.parkedAt === undefined)
}

// ── Q2: the drain knob ──────────────────────────────────────────────────────
console.log('Q2 the drain ceiling knob')
{
  check('the default is 10 minutes', idle.sessionParkDrainMs() === 10 * 60_000, String(idle.sessionParkDrainMs()))
  process.env.MERCURY_SESSION_PARK_DRAIN_MINUTES = '3'
  check('the knob reads minutes', idle.sessionParkDrainMs() === 3 * 60_000)
  process.env.MERCURY_SESSION_PARK_DRAIN_MINUTES = '0'
  check('0 ⇒ no wait', idle.sessionParkDrainMs() === 0)
  delete process.env.MERCURY_SESSION_PARK_DRAIN_MINUTES
  const registry = read('src/substrate/flagRegistry.ts')
  check('the knob is a registered row naming its consumer and the cut wording', registry.includes("env: 'MERCURY_SESSION_PARK_DRAIN_MINUTES'") && registry.includes('sessionParkDrainMs') && registry.includes("'parked — turn cut at the drain ceiling'"))
  check('the cut reason has ONE owner', sup.PARK_DRAIN_CUT_REASON === 'parked — turn cut at the drain ceiling')
}

// ── Q3: the one close path (source) ─────────────────────────────────────────
console.log('Q3 the one close path')
{
  const hop = read('src/services/switchboard/hopIntoSession.ts')
  const closeAt = hop.indexOf('export async function closeFocusedChat(')
  const closeBody = hop.slice(closeAt, hop.indexOf('export async function clearFocusedSession(', closeAt))
  check('closeFocusedChat exists as the one close path', closeAt !== -1)
  check("the park fate rides the daemon's park verb under the terminal's own seat", closeBody.includes("action: 'park', sessionId, by: `operator:${process.pid}`"))
  check('the end fate (x-x) rides stop + release', closeBody.includes("action: 'stop', sessionId, by: 'operator'") && closeBody.includes("op: 'sessionRelease', runnerId: rec.runnerId"))
  const restAt = closeBody.indexOf('slot.releaseFocusedSessionConnector()')
  check("the slot rests LAST (the connector's detach says the blur through the one chain)", restAt !== -1 && restAt > closeBody.indexOf("action: 'park'") && restAt > closeBody.indexOf("op: 'sessionRelease'"))
  check('a newborn closed reads as released; a mid-turn close as draining', closeBody.includes("startsWith('released') ? 'released'") && closeBody.includes("parked.outcome === 'draining' ? 'draining'"))
  const clearAt = hop.indexOf('export async function clearFocusedSession(')
  const clearBody = hop.slice(clearAt)
  // Park-then-birth dropped the frame to the Boot face in the
  // plain world (the slot release mounted the face before the birth's
  // landing gate armed) — the law is now birth-FIRST (the born hop swaps
  // the slot in one move), then the OLD session parks by id. Still a park,
  // never a release/stop (the cleared chat survives for /resume), and the
  // face-gap close path may not return.
  check('/clear births FIRST (the slot swaps whole, riding the seat-swap hint), then parks the OLD session by id — never a release', clearBody.indexOf('bornSession({ workspaceDir, model, vacatingSessionId: oldSessionId })') !== -1 && clearBody.indexOf('bornSession({ workspaceDir, model, vacatingSessionId: oldSessionId })') < clearBody.indexOf('parkSessionById(oldSessionId)') && clearBody.includes("action: 'park', sessionId, by: `operator:${process.pid}`") && !clearBody.includes("op: 'sessionRelease'") && !clearBody.includes("action: 'stop'") && !clearBody.includes('closeFocusedChat('))
}

// ── Q4: the quit is armed; the orphan reap drains (source) ──────────────────
console.log('Q4 the quit parks all — the screen and the daemon')
{
  const quit = read('src/services/switchboard/quitParksAll.ts')
  check("the screen's cleanup says park-all under the terminal's seat, bounded", quit.includes("action: 'park-all', sessionId: 'all', by: SEAT_BY") && quit.includes('const SEAT_BY = `operator:${process.pid}`') && quit.includes('registerCleanup(async () => {') && /PARK_ALL_BUDGET_MS = 1500/.test(quit))
  const main = read('src/main.tsx')
  check('every interactive boot arms it (before the journey classification)', main.includes('armQuitParksAll()') && main.indexOf('armQuitParksAll()') < main.indexOf('markExplicitBootJourney()'))
  const daemon = read('src/daemon/main.ts')
  const parkAllAt = daemon.indexOf('const parkAllThenShutdown = async (signal: string): Promise<void> => {')
  const parkAllBody = daemon.slice(parkAllAt, daemon.indexOf('requestShutdown = shutdown', parkAllAt))
  check("the owned daemon's orphan reap parks-all first", parkAllAt !== -1 && parkAllBody.includes('parkAllConcourseSessions(`daemon:${signal}`, roster ?? undefined)') && daemon.includes("void parkAllThenShutdown('owner-orphaned')") && !daemon.includes("shutdown('owner-orphaned')\n"))
  check('it drains the mid-turn parks under the registered ceiling, cuts with the ruled reason, then shuts down — latched', parkAllBody.includes('pendingParkRequests().length > 0 && Date.now() - startedDrain < ceilingMs') && parkAllBody.includes('sessionParkDrainMs()') && parkAllBody.includes('reason: PARK_DRAIN_CUT_REASON') && parkAllBody.indexOf('shutdown(signal)') > parkAllBody.indexOf('reason: PARK_DRAIN_CUT_REASON') && parkAllBody.includes('if (orphanParking || shuttingDown) return'))
  check("the daemon's park-all from a screen keeps a chat another LIVE terminal holds; the reap keeps nothing back", daemon.includes('exceptFocusedByLiveTerminal: true') && !parkAllBody.includes('exceptFocusedByLiveTerminal'))
  check("the roster's idle edge completes a requested park while the drain runs", daemon.includes('completeRequestedPark(short, roster)'))
}

// ── Q5: the only session (the operator's repro; source) ─────────────────────
console.log("Q5 the only session's release: the board stays, the reason shows")
{
  const route = read('src/components/concourse/ConcourseRoute.tsx')
  const removeAt = route.indexOf('removeSession: sessionId => {')
  const removeBody = route.slice(removeAt, route.indexOf('openObligation: obligationId => {', removeAt))
  check('with no survivor the slot rests and the board STAYS (no menu call on the release road)', removeBody.includes('if (!repointed) slot.releaseFocusedSessionConnector()') && !removeBody.includes('enterBootSettings()'))
  check('the older line is never a survivor', removeBody.includes('!r.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX)'))
  check("a release refusal paints the daemon's own sentence (the wire's error and code), never a bare line", removeBody.includes('reply.error ?? `release refused${reply.code !== undefined ? ` (${reply.code})` : \'\'}`'))
  check('with no daemon a dead runner settles in the record; a live one is never ended invisibly', removeBody.includes('settleConcourseWorker(rec.runnerId)') && removeBody.includes('the daemon that hosts sessions is not reachable and the runner is alive'))
  const stopAt = route.indexOf('stopSession: sessionId => {')
  const stopBody = route.slice(stopAt, route.indexOf('removeSession: sessionId => {', stopAt))
  check("the first x's refusal paints the daemon's sentence, else the wire's error and code — never a bare \"stop refused\"", stopBody.includes("reply.detail ?? reply.error ?? `stop refused${reply.code !== undefined ? ` (${reply.code})` : ''}`"))
  check('with no daemon a dead runner is stopped in the record directly', stopBody.includes("supervisor.stopConcourseSession(sessionId, 'operator', undefined)"))
}

// ── Q6: the refused birth ───────────────────────────────────────────────────
console.log('Q6 a refused chat-forward birth lands the face directly')
{
  handover.markExplicitBootJourney()
  check('an explicit journey is marked', handover.bootJourneyIsExplicit())
  handover.retractExplicitBootJourney()
  check('the retraction clears it (the resolver lands the Boot face)', !handover.bootJourneyIsExplicit())
  const main = read('src/main.tsx')
  // The anchor was the AWAITED birth — the shape FN-015 rank 12 retired: it
  // gated the first paint on a daemon round-trip. The law this check
  // defends is unchanged (a refused birth retracts, so the face lands
  // directly); it is re-cut onto the block instead of the old call line,
  // and now also pins that the paint is no longer gated.
  const birthAt = main.indexOf('const birth = bornSession({ workspaceDir: getCwd(), model: null })')
  const block = birthAt === -1 ? '' : main.slice(birthAt, main.indexOf('await launchRepl(', birthAt))
  check('main.tsx starts the chat-forward birth', birthAt !== -1)
  check('main.tsx retracts the journey on a refused chat-forward birth', block.includes('retractExplicitBootJourney()'))
  check('…and the first paint is never gated on that birth', block !== '' && !block.includes('await bornSession('))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-close-all: ALL LAWS HOLD' : `\nprove-close-all: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
