#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'resumed-at-rest-')))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_WARM_RUNNER
delete process.env.MERCURY_SESSION_KIT
for (const key of [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'ZAI_API_KEY',
  'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_OAUTH_TOKEN', 'MERCURY_GEMINI_OAUTH_TOKEN',
  'MOONSHOT_API_KEY', 'MOONSHOT_TOKEN', 'HF_TOKEN', 'HF_OAUTH_TOKEN', 'MERCURY_COMPAT_API_KEY', 'MERCURY_COMPAT_BASE_URL', 'MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN',
]) delete process.env[key]
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
delete process.env.CI
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const j = (value: unknown): string => JSON.stringify(value)

const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 4 } }))
const sup = await import('../../src/daemon/concourseWorkers.ts')
const { startControlServer } = await import('../../src/daemon/controlServer.ts')
const { MERCURY_DAEMON_PROTO } = await import('../../src/daemon/protocol.ts')
const { controlSockPath } = await import('../../src/daemon/controlSocket.ts')
type Rec = import('../../src/daemon/concourseWorkers.ts').ConcourseWorkerRecordV1
type Spec = ReturnType<typeof sup.buildConcourseWorkerSpec>

const ALIVE = { needsYou: false, alive: true }
const state = (rec: Partial<Rec>): string => sup.concourseRecordState({ pid: process.pid, ...rec } as Rec, ALIVE)
const now = Date.now()

console.log('A1 the board reads working only of a turn in flight: a session admitted at rest stands under READY TO REVIEW until it is given words')
{
  check('a session brought back by a resume with no message, alive, nothing delivered: ready to review (red before: working, with the busy glyph)', state({ resumedAtRestAt: now }) === 'ready-to-review', state({ resumedAtRestAt: now }))
  check('a wordless newborn reads as it did: ready to review', state({ bornBlankAt: now }) === 'ready-to-review')
  check('given words, either one works until that turn settles, then is ready again', state({ resumedAtRestAt: now, lastDeliveryAt: now + 10 }) === 'working' && state({ resumedAtRestAt: now, lastDeliveryAt: now + 10, lastTurnSettledAt: now + 20 }) === 'ready-to-review' && state({ bornBlankAt: now, lastDeliveryAt: now + 10 }) === 'working')
  check("a session born of a dispatch reads working in the beat before its prompt's delivery stamp lands: no admission at rest was recorded for it", state({}) === 'working')
  check('parked, stopped and with-you rows keep their own state whatever the stamp', state({ resumedAtRestAt: now, parkedAt: now }) === 'parked' && state({ resumedAtRestAt: now, stoppedAt: now }) === 'stopped' && state({ resumedAtRestAt: now, attachedAt: now }) === 'attached')
  check('a runner that is gone still asks for the operator', sup.concourseRecordState({ pid: process.pid, resumedAtRestAt: now } as Rec, { needsYou: false, alive: false }) === 'needs-you')
}

console.log("A2 the control door marks the one admission that brings a session back with no message: sessionAdmit with a resume id and no blank birth")
{
  const socketPath = process.platform === 'win32' ? controlSockPath() : join(SCRATCH, 'fixture.sock')
  const forwarded: Array<Record<string, unknown>> = []
  const server = await startControlServer({
    controlKey: 'fixture-auth',
    isReady: () => true,
    concourseAdmit: async (req: Record<string, unknown>) => {
      forwarded.push(req)
      return { ok: true, runnerId: 'fixture', sessionId: '12345678-1234-4234-8234-123456789abc' }
    },
  } as never, { socketPath })
  const request = (fields: Record<string, unknown>): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const sock = net.connect(socketPath)
      let output = ''
      sock.setTimeout(2000, () => sock.destroy(new Error('the admission fixture timed out')))
      sock.on('error', reject)
      sock.on('connect', () => sock.write(JSON.stringify({ op: 'sessionAdmit', proto: MERCURY_DAEMON_PROTO, auth: 'fixture-auth', workspaceDir: SCRATCH, ...fields }) + '\n'))
      sock.on('data', bytes => { output += bytes.toString() })
      sock.on('end', () => { try { resolve(JSON.parse(output)) } catch (error) { reject(error) } })
    })
  try {
    const uuid = '12345678-1234-4234-8234-123456789abc'
    await request({ resumeSessionId: uuid })
    await request({ bornBlank: true })
    await request({})
    await request({ resumeSessionId: uuid, bornBlank: true })
    check('a resume by id is forwarded as admitted at rest', forwarded[0]?.resumedAtRest === true && forwarded[0]?.resumeSessionId === uuid, j(forwarded[0]))
    check('a blank birth, a plain admission and a blank birth that names an id are not', forwarded.length === 4 && forwarded.slice(1).every(req => req.resumedAtRest === undefined) && forwarded[1]?.bornBlank === true, j(forwarded.slice(1)))
  } finally {
    await server.close()
  }
}

class FakeRoster {
  present = new Map<string, { alive: boolean; ready: boolean }>()
  has(short: string): { alive: boolean; present: boolean; ready: boolean } {
    const p = this.present.get(short)
    return p ? { present: true, alive: p.alive, ready: p.ready } : { present: false, alive: false, ready: false }
  }
  list(): Array<{ short: string }> {
    return [...this.present.keys()].map(short => ({ short }))
  }
  registerLongLived(short: string, _spec: Spec): { ok: boolean; pid?: number } {
    this.present.set(short, { alive: true, ready: true })
    return { ok: true, pid: process.pid }
  }
  control(): boolean {
    return true
  }
  kill(short: string): boolean {
    this.present.delete(short)
    return true
  }
}

console.log('A3 the admission writes it on the record, and the record reads at rest from its first beat')
{
  const roster = new FakeRoster()
  const dir = mkdtempSync(join(SCRATCH, 'daemon-'))
  const ws = realpathSync(mkdtempSync(join(SCRATCH, 'ws-')))
  const admit = sup.makeConcourseAdmitHandler({ roster: () => roster as never, dir })
  const broughtBack = await admit({ workspaceDir: ws, resumeSessionId: '7d0e3d7e-2a4c-4a0f-9c1b-0000000000a1', resumedAtRest: true, isolation: 'shared', by: 'operator' })
  const dispatched = await admit({ workspaceDir: ws, isolation: 'shared', by: 'operator' })
  const records = sup.readSessionWorkers(dir)
  const back = broughtBack.ok ? records[broughtBack.runnerId] : undefined
  const fresh = dispatched.ok ? records[dispatched.runnerId] : undefined
  check('both admissions landed', back !== undefined && fresh !== undefined, j({ broughtBack, dispatched }))
  check('the one brought back carries the stamp and reads ready to review; the other carries none and reads working', back?.resumedAtRestAt !== undefined && fresh?.resumedAtRestAt === undefined && back !== undefined && fresh !== undefined && sup.concourseRecordState(back, ALIVE) === 'ready-to-review' && sup.concourseRecordState(fresh, ALIVE) === 'working', j({ back: back?.resumedAtRestAt, fresh: fresh?.resumedAtRestAt }))
  check('nothing was invented about a turn: no settle stamp, so the row is not one whose reply is new to the operator', back?.lastTurnSettledAt === undefined && back?.lastDeliveryAt === undefined && !sup.turnInFlightOf(back as Rec))
  if (back !== undefined) {
    sup.markConcourseWorkerDelivery(back.runnerId, dir)
    const given = sup.readSessionWorkers(dir)[back.runnerId]!
    check('its first message puts it to work', sup.concourseRecordState(given, ALIVE) === 'working' && sup.turnInFlightOf(given))
    sup.markConcourseWorkerTurnSettled(back.runnerId, dir)
    check('and its turn end brings it back to ready', sup.concourseRecordState(sup.readSessionWorkers(dir)[back.runnerId]!, ALIVE) === 'ready-to-review')
  }
}

console.log('A4 a session that already has a record is taken back with no message: at rest too, by a warm runner or a new one, and a turn its dead runner left open is not called running')
{
  const DEAD_PID = 2_147_000_000
  let n = 0
  const world = (warm: boolean): { roster: FakeRoster; dir: string; ws: string; admit: ReturnType<typeof sup.makeConcourseAdmitHandler>; warmed: () => number } => {
    const roster = new FakeRoster()
    const dir = mkdtempSync(join(SCRATCH, 'daemon-'))
    const ws = realpathSync(mkdtempSync(join(SCRATCH, 'ws-')))
    let warmed = 0
    const admit = sup.makeConcourseAdmitHandler({
      roster: () => roster as never,
      dir,
      ...(warm
        ? {
            claimWarm: async (args: { sessionId: string }) => {
              warmed++
              const standing = Object.values(sup.readSessionWorkers(dir)).find(r => r.sessionId === args.sessionId)!
              roster.present.set(standing.runnerId, { alive: true, ready: true })
              return { claimed: true as const, short: standing.runnerId, pid: process.pid, spec: {} as never }
            },
          }
        : {}),
    } as never)
    return { roster, dir, ws, admit, warmed: () => warmed }
  }
  const rec = (w: { dir: string }, runnerId: string): Rec => sup.readSessionWorkers(w.dir)[runnerId]!
  const runnerDies = (w: { roster: FakeRoster; dir: string }, runnerId: string): void => {
    sup.updateConcourseWorkers(rows => {
      rows[runnerId]!.pid = DEAD_PID
      delete rows[runnerId]!.procStart
    }, w.dir)
    w.roster.present.delete(runnerId)
  }
  const standing = async (w: ReturnType<typeof world>, atRest: boolean): Promise<Rec> => {
    const sessionId = `7d0e3d7e-2a4c-4a0f-9c1b-0000000000b${++n}`
    const born = atRest ? await w.admit({ workspaceDir: w.ws, resumeSessionId: sessionId, resumedAtRest: true, isolation: 'shared', by: 'operator' }) : await w.admit({ workspaceDir: w.ws, isolation: 'shared', by: 'operator' })
    if (!born.ok) throw new Error(`the scene did not stage: ${j(born)}`)
    const record = rec(w, born.runnerId)
    const transcript = sup.concourseTranscriptPath(record)
    mkdirSync(dirname(transcript), { recursive: true })
    writeFileSync(transcript, '')
    return record
  }
  const takeBack = (w: ReturnType<typeof world>, sessionId: string): ReturnType<ReturnType<typeof sup.makeConcourseAdmitHandler>> => w.admit({ workspaceDir: w.ws, resumeSessionId: sessionId, resumedAtRest: true, isolation: 'shared', by: 'operator' })

  for (const warm of [false, true]) {
    const road = warm ? 'a warm runner takes it' : 'a new runner is started'
    const w = world(warm)
    const first = await standing(w, true)
    sup.markConcourseWorkerDelivery(first.runnerId, w.dir)
    const working = rec(w, first.runnerId)
    runnerDies(w, first.runnerId)
    await new Promise(resolve => setTimeout(resolve, 5))
    const reply = await takeBack(w, first.sessionId)
    const back = rec(w, reply.ok ? reply.runnerId : first.runnerId)
    check(`${road}: the scene stood — a turn was given, and its runner died without ending it`, sup.turnInFlightOf(working) && sup.concourseRecordState(working, ALIVE) === 'working' && reply.ok && (reply as { liveHop?: boolean }).liveHop !== true && w.warmed() === (warm ? 1 : 0), j({ reply, warmed: w.warmed() }))
    check(`${road}: taken back with no message it reads ready to review (red before: working, on the word of a delivery whose runner was gone)`, sup.concourseRecordState(back, ALIVE) === 'ready-to-review', j({ state: sup.concourseRecordState(back, ALIVE), lastDeliveryAt: back.lastDeliveryAt, lastTurnSettledAt: back.lastTurnSettledAt, resumedAtRestAt: back.resumedAtRestAt }))
    check(`${road}: no turn is in flight on its record, and the admission is stamped anew`, !sup.turnInFlightOf(back) && back.lastTurnSettledAt === back.lastDeliveryAt && (back.resumedAtRestAt ?? 0) > (first.resumedAtRestAt ?? Number.MAX_SAFE_INTEGER), j({ first: first.resumedAtRestAt, back: back.resumedAtRestAt, lastTurnSettledAt: back.lastTurnSettledAt }))
    sup.markConcourseWorkerDelivery(back.runnerId, w.dir)
    check(`${road}: its next message puts it to work`, sup.concourseRecordState(rec(w, back.runnerId), ALIVE) === 'working')
  }

  {
    const w = world(false)
    const born = await standing(w, false)
    runnerDies(w, born.runnerId)
    const reply = await takeBack(w, born.sessionId)
    const back = rec(w, born.runnerId)
    check('a session born of a dispatch whose words never arrived, taken back with no message: ready to review (its record had no stamp of any kind)', born.resumedAtRestAt === undefined && born.lastDeliveryAt === undefined && reply.ok && back.resumedAtRestAt !== undefined && sup.concourseRecordState(back, ALIVE) === 'ready-to-review', j({ reply, back: back.resumedAtRestAt }))
  }

  {
    const w = world(true)
    const stoppedMidTurn = await standing(w, true)
    sup.markConcourseWorkerDelivery(stoppedMidTurn.runnerId, w.dir)
    const stop = sup.stopConcourseSession(stoppedMidTurn.sessionId, 'operator', w.roster as never, w.dir)
    runnerDies(w, stoppedMidTurn.runnerId)
    const completed = sup.completeRequestedStop(stoppedMidTurn.runnerId, w.dir)
    const reply = await takeBack(w, stoppedMidTurn.sessionId)
    const back = rec(w, stoppedMidTurn.runnerId)
    check('a session stopped during a turn and taken back with no message reads ready to review, not working', stop.outcome === 'applied' && completed && reply.ok && w.warmed() === 1 && back.stoppedAt === undefined && sup.concourseRecordState(back, ALIVE) === 'ready-to-review' && !sup.turnInFlightOf(back), j({ stop, completed, reply, state: sup.concourseRecordState(back, ALIVE) }))
  }

  {
    const w = world(false)
    const live = await standing(w, true)
    sup.markConcourseWorkerDelivery(live.runnerId, w.dir)
    const before = rec(w, live.runnerId)
    const reply = await takeBack(w, live.sessionId)
    const after = rec(w, live.runnerId)
    check('a second window that enters a session whose runner is alive and working changes nothing: the turn is in flight and the row says so', reply.ok && (reply as { liveHop?: boolean }).liveHop === true && sup.concourseRecordState(after, ALIVE) === 'working' && sup.turnInFlightOf(after) && after.resumedAtRestAt === before.resumedAtRestAt && after.lastTurnSettledAt === before.lastTurnSettledAt, j({ reply, after }))
  }

  {
    const w = world(false)
    const cut = await standing(w, false)
    sup.markConcourseWorkerDelivery(cut.runnerId, w.dir)
    runnerDies(w, cut.runnerId)
    const revived = sup.reviveConcourseWorker(cut.sessionId, 'auto-revive', w.roster as never, undefined, w.dir)
    const after = rec(w, cut.runnerId)
    check('a revival that brings words with it is not an admission at rest: no stamp, and the record is left as it was for the delivery that follows', revived.outcome === 'applied' && after.resumedAtRestAt === undefined && after.lastTurnSettledAt === undefined && after.lastDeliveryAt === rec(w, cut.runnerId).lastDeliveryAt, j({ revived, after }))
  }
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-resumed-session-at-rest: ALL LAWS HOLD' : `\nprove-resumed-session-at-rest: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
