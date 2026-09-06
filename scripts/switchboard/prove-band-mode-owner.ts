#!/usr/bin/env bun
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'band-mode-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_DAEMON_PERMISSION_MODE
delete process.env.MERCURY_AUTOPILOT
delete process.env.MERCURY_CONCOURSE_WORKER
delete process.env.MERCURY_SKIP_PERMISSIONS

const supervisor = await import('../../src/daemon/concourseSupervisor.ts')
const seat = await import('../../src/daemon/sessionSeat.ts')
const { permissionModeOf } = await import('../../src/services/engine-connector/daemonConnector.ts')
const { getNextPermissionMode } = await import('../../src/utils/permissions/getNextPermissionMode.ts')
const { resolvePermissionModeTransition } = await import('../../src/cli/headless/controlHandlers.ts')
const { buildStreamJsonInvocation, getHeadlessPermissionMode } = await import('../../src/daemon/headlessRun.ts')
import type { StreamJsonChildSpec } from '../../src/daemon/headlessRun.ts'
import type { ConcourseWorkerRecordV1 } from '../../src/daemon/concourseSupervisor.ts'
import type { PermissionMode } from '../../src/types/permissions.ts'
import type { ToolPermissionContext } from '../../src/Tool.ts'

let failures = 0
let passes = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) passes++
  else failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const SKIP = '--dangerously-bypass-permissions'
const ALLOW = '--allow-dangerously-bypass-permissions'

section('§1 the record stamps the posture and consent the runner was booted with')
{
  const spec = (permissionMode: string, allowBypass?: true): Pick<StreamJsonChildSpec, 'permissionMode' | 'allowBypass'> =>
    ({ permissionMode: permissionMode as StreamJsonChildSpec['permissionMode'], ...(allowBypass === true ? { allowBypass: true as const } : {}) })
  const sov = supervisor.spawnPostureOf(spec('sovereign', true))
  check('a sovereign spec with the consent stamps {sovereign, bypassConsent:true}', sov.permissionMode === 'sovereign' && sov.bypassConsent === true, JSON.stringify(sov))
  const def = supervisor.spawnPostureOf(spec('default'))
  check('a default spec without consent stamps {default} and NO consent field', def.permissionMode === 'default' && !('bypassConsent' in def), JSON.stringify(def))
  const apollo = supervisor.spawnPostureOf(spec('apollo'))
  check("an apollo seat stamps 'apollo' (the cockpit-attached seat's own mode)", apollo.permissionMode === 'apollo', JSON.stringify(apollo))
  process.env.MERCURY_DAEMON_PERMISSION_MODE = 'implement'
  const env = supervisor.spawnPostureOf(spec('sovereign'))
  const argv = buildStreamJsonInvocation({ ...baseSpec('w-env'), permissionMode: 'sovereign' }).argv
  delete process.env.MERCURY_DAEMON_PERMISSION_MODE
  check('the daemon posture env wins in the stamp exactly as it wins in the argv (record ≡ process)', env.permissionMode === 'implement' && argv.includes('implement') && !argv.includes(SKIP), `stamp=${env.permissionMode} argv=${argv.filter(a => /permission|dangerously|implement/.test(a)).join(' ')}`)
  const rec = { permissionMode: 'sovereign', bypassConsent: true } as unknown as ConcourseWorkerRecordV1
  supervisor.stampSpawnPosture(rec, { permissionMode: 'default' })
  check('a restamp without consent DROPS the record\'s old consent (never a station the runner lost)', rec.permissionMode === 'default' && rec.bypassConsent === undefined, JSON.stringify(rec))
}

function baseSpec(short: string): StreamJsonChildSpec {
  return supervisor.buildConcourseWorkerSpec({
    runnerId: short,
    sessionId: '00000000-0000-4000-8000-000000000001',
    workspaceId: HOME,
    modelKey: 'claude-sonnet-5',
    cwd: HOME,
  })
}

section("§2 the seat's skeleton speaks the record's posture and nothing without one")
{
  const word = seat.spawnPostureWordOf({ permissionMode: 'sovereign' })
  check("a stamped record's skeleton carries its posture", (word as { permissionMode?: string }).permissionMode === 'sovereign', JSON.stringify(word))
  const none = seat.spawnPostureWordOf({})
  check('a record without the stamp yields NO mode word (never flow)', Object.keys(none).length === 0, JSON.stringify(none))
}

section("§3 the connector's mode read: the facts' word, else the birth posture, else the blank")
{
  check("the runner's spoken word wins over any birth record", permissionModeOf({ permissionMode: 'implement' }, { permissionMode: 'sovereign' }) === 'implement')
  check("a skeleton without a word falls to the birth record's posture", permissionModeOf({}, { permissionMode: 'sovereign' }) === 'sovereign')
  check('no facts file + a sovereign birth record ⇒ sovereign', permissionModeOf(null, { permissionMode: 'sovereign' }) === 'sovereign')
  check('no facts file + a default birth record ⇒ default (the blank band)', permissionModeOf(null, { permissionMode: 'default' }) === 'default')
  const seatWord = supervisor.seatInitialPermissionMode('strategy')
  check('a birth posture the seat maps at spawn reads through the SAME resolver (one mapping owner)', permissionModeOf(null, { permissionMode: 'strategy' }) === seatWord, `resolver=${seatWord}`)
  check("no facts + a birth record carrying none ⇒ null (the honest blank), never 'flow'", permissionModeOf(null, { permissionMode: null }) === null)
  check("a skeleton without a word + no birth posture ⇒ null, never 'flow'", permissionModeOf({}, { permissionMode: null }) === null)
}

section("§4 every revive road boots the record's posture and consent; the reactivate's word wins")
{
  const dir = mkdtempSync(join(tmpdir(), 'band-mode-daemon-'))
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'band-mode-ws-')))
  const sid = '00000000-0000-4000-8000-0000000000aa'
  const short = 'concourse-w7'
  class FakeRoster {
    registered: Array<{ short: string; spec: StreamJsonChildSpec }> = []
    killed: string[] = []
    present = new Set<string>()
    has(s: string): { present: boolean } {
      return { present: this.present.has(s) }
    }
    kill(s: string): boolean {
      this.killed.push(s)
      this.present.delete(s)
      return true
    }
    registerLongLived(s: string, spec: StreamJsonChildSpec): { ok: boolean; pid?: number; error?: string } {
      this.registered.push({ short: s, spec })
      this.present.add(s)
      return { ok: true, pid: 4_000_000 }
    }
  }
  const roster = new FakeRoster()
  const seed = (patch: Partial<ConcourseWorkerRecordV1>): void => {
    supervisor.updateConcourseWorkers(workers => {
      for (const k of Object.keys(workers)) delete workers[k]
      workers[short] = {
        schema: 1,
        runnerId: short,
        sessionId: sid,
        workspaceId: ws,
        isolation: 'shared',
        modelKey: 'claude-sonnet-5',
        effort: 'high',
        spawnedAt: Date.now() - 60_000,
        lastLiveAt: Date.now() - 60_000,
        pid: 4_000_001,
        ...patch,
      } as ConcourseWorkerRecordV1
    }, dir)
  }
  const lastSpec = (): StreamJsonChildSpec | undefined => roster.registered.at(-1)?.spec
  const argvOf = (spec: StreamJsonChildSpec | undefined): string[] => (spec ? buildStreamJsonInvocation(spec).argv : [])
  const recordNow = (): ConcourseWorkerRecordV1 | undefined => supervisor.readSessionWorkers(dir)[short]

  seed({ permissionMode: 'sovereign', bypassConsent: true })
  const a = supervisor.reviveConcourseWorker(sid, 'auto-revive', roster, undefined, dir)
  check('(a) the auto-revive road revives a dead sovereign+consented record', a.outcome === 'applied', JSON.stringify(a))
  check("(a) …booting the RECORD's posture: the skip flag on the argv, the consent on the spec", lastSpec()?.permissionMode === 'sovereign' && lastSpec()?.allowBypass === true && argvOf(lastSpec()).includes(SKIP), argvOf(lastSpec()).filter(x => /permission|dangerously/.test(x)).join(' '))
  check('(a) …and the record keeps its stamp', recordNow()?.permissionMode === 'sovereign' && recordNow()?.bypassConsent === true)
  seed({ permissionMode: 'sovereign', bypassConsent: true, stoppedAt: Date.now() - 1_000, stoppedBy: 'operator' })
  const b = supervisor.reviveConcourseWorker(sid, 'operator:resume', roster, { allowStopped: true }, dir)
  check("(b) the resume verb's road revives a stopped record", b.outcome === 'applied', JSON.stringify(b))
  check("(b) …booting the RECORD's posture and consent", lastSpec()?.permissionMode === 'sovereign' && lastSpec()?.allowBypass === true && argvOf(lastSpec()).includes(SKIP))
  seed({ permissionMode: 'implement' })
  const c = supervisor.reviveConcourseWorker(sid, 'auto-revive', roster, undefined, dir)
  check("(c) an implement record without consent revives in implement, no consent flag", c.outcome === 'applied' && lastSpec()?.permissionMode === 'implement' && lastSpec()?.allowBypass === undefined && !argvOf(lastSpec()).includes(ALLOW) && !argvOf(lastSpec()).includes(SKIP), argvOf(lastSpec()).filter(x => /permission|dangerously|implement/.test(x)).join(' '))
  seed({ permissionMode: 'sovereign', bypassConsent: true })
  const d = supervisor.reviveConcourseWorker(sid, 'operator', roster, { allowStopped: true, clearCrash: true, permissionMode: 'default', bypassConsent: false }, dir)
  check("(d) the reactivate's carried posture (default, no consent) outranks the record's", d.outcome === 'applied' && lastSpec()?.permissionMode === 'default' && lastSpec()?.allowBypass === undefined && !argvOf(lastSpec()).includes(SKIP) && !argvOf(lastSpec()).includes(ALLOW))
  check("(d) …and the record is RESTAMPED: default, the old consent dropped", recordNow()?.permissionMode === 'default' && recordNow()?.bypassConsent === undefined, JSON.stringify({ permissionMode: recordNow()?.permissionMode, bypassConsent: recordNow()?.bypassConsent }))
  seed({ permissionMode: 'default' })
  const e = supervisor.reviveConcourseWorker(sid, 'operator', roster, { allowStopped: true, permissionMode: 'default', bypassConsent: true }, dir)
  check("(e) a consented door's revive carries the allow flag and stamps the consent", e.outcome === 'applied' && lastSpec()?.allowBypass === true && argvOf(lastSpec()).includes(ALLOW) && recordNow()?.bypassConsent === true)
  seed({})
  const f = supervisor.reviveConcourseWorker(sid, 'auto-revive', roster, undefined, dir)
  const own = getHeadlessPermissionMode(supervisor.seatInitialPermissionMode())
  check('(f) a record without the stamp revives on the seat\'s own resolution', f.outcome === 'applied' && lastSpec()?.permissionMode === supervisor.seatInitialPermissionMode(), `spec=${lastSpec()?.permissionMode} own=${own}`)
  check('(f) …and takes the stamp so its skeleton speaks a true word from now on', recordNow()?.permissionMode === own, `record=${recordNow()?.permissionMode}`)
  check('(f) every revive above registered a spec (six spawns, no refusal)', roster.registered.length === 6, String(roster.registered.length))
}

section("§5 a mode change's receipt is the runner's own word: refused with its sentence, applied, or typed past the deadline")
{
  const dir = mkdtempSync(join(tmpdir(), 'band-mode-seat-'))
  const sid = '00000000-0000-4000-8000-0000000000bb'
  const short = 'concourse-w3'
  supervisor.updateConcourseWorkers(workers => {
    workers[short] = {
      schema: 1,
      runnerId: short,
      sessionId: sid,
      workspaceId: HOME,
      isolation: 'shared',
      modelKey: 'claude-sonnet-5',
      effort: 'high',
      spawnedAt: Date.now(),
      lastLiveAt: Date.now(),
      pid: process.pid,
    } as ConcourseWorkerRecordV1
  }, dir)
  const controls: Array<{ short: string; frame: string }> = []
  const roster = {
    control(s: string, frame: string): boolean {
      controls.push({ short: s, frame })
      return true
    },
    list: () => [{ short }],
    patchSeatModel: () => true,
    patchSeatEffort: () => true,
  }
  const requestOf = (frame: string): { request_id: string; subtype: string; mode: string } => {
    const parsed = JSON.parse(frame) as { request_id: string; request: { subtype: string; mode: string } }
    return { request_id: parsed.request_id, subtype: parsed.request.subtype, mode: parsed.request.mode }
  }
  const REFUSAL = 'Cannot set permission mode to sovereign because the session was not launched with --dangerously-bypass-permissions'
  const pa = seat.setSessionPermissionMode(sid, 'sovereign', roster, dir, { deadlineMs: 2_000 })
  const reqA = requestOf(controls.at(-1)!.frame)
  check('(a) the verb rides a set_permission_mode control naming the mode', reqA.subtype === 'set_permission_mode' && reqA.mode === 'sovereign' && reqA.request_id.startsWith('mercury-seat-set-permission-mode-'), reqA.request_id)
  seat.onSeatLine(short, JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: reqA.request_id, error: REFUSAL } }), roster, dir)
  const a = await pa
  check("(a) the runner's refusal comes back as 'refused' with ITS sentence verbatim", a.outcome === 'refused' && a.detail === REFUSAL, JSON.stringify(a))
  check('(a) the answer re-asks the facts at once (the band follows the runner)', controls.some(c => c.frame.includes('"session_facts"') && c.short === short))
  const pb = seat.setSessionPermissionMode(sid, 'implement', roster, dir, { deadlineMs: 2_000 })
  const reqB = requestOf(controls.at(-1)!.frame)
  seat.onSeatLine(short, JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: reqB.request_id, response: {} } }), roster, dir)
  const b = await pb
  check("(b) the runner's success comes back as 'applied' naming the mode", b.outcome === 'applied' && (b.detail ?? '').includes('implement'), JSON.stringify(b))
  const t0 = Date.now()
  const c = await seat.setSessionPermissionMode(sid, 'strategy', roster, dir, { deadlineMs: 300 })
  check('(c) a silent runner answers refused past the deadline, naming the silence', c.outcome === 'refused' && /did not answer/.test(c.detail ?? '') && Date.now() - t0 >= 250, JSON.stringify(c))
  const dead = { ...roster, control: () => false }
  const d = await seat.setSessionPermissionMode(sid, 'implement', dead, dir)
  check('(d) no live control channel refuses at once', d.outcome === 'refused' && /control channel/.test(d.detail ?? ''), JSON.stringify(d))
  check('(e) no waiter is left behind', seat._pendingModeWaitersForTesting() === 0)
  const p1 = seat.setSessionPermissionMode(sid, 'implement', roster, dir, { deadlineMs: 200 })
  const p2 = seat.setSessionPermissionMode(sid, 'strategy', roster, dir, { deadlineMs: 200 })
  const ids = controls.slice(-2).map(c => requestOf(c.frame).request_id)
  check('(f) two presses in one tick carry two distinct request ids', ids[0] !== ids[1], ids.join(' | '))
  await Promise.all([p1, p2])
}

section('§6 the carousel lists every station the seat may hold, Sovereign in a consented ring, nothing the runner refuses')
{
  const ctx = (mode: PermissionMode, consented: boolean): ToolPermissionContext =>
    ({ mode, isBypassPermissionsModeAvailable: consented, additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {} }) as unknown as ToolPermissionContext
  const walk = (consented: boolean, from: PermissionMode = 'default'): PermissionMode[] => {
    const out: PermissionMode[] = []
    let mode = from
    for (let i = 0; i < 8; i++) {
      mode = getNextPermissionMode(ctx(mode, consented))
      out.push(mode)
      if (mode === from) break
    }
    return out
  }
  const consented = walk(true)
  const plain = walk(false)
  console.log(`  consented ring from default: ${consented.join(' → ')}`)
  console.log(`  unconsented ring from default: ${plain.join(' → ')}`)
  check('a consented ring holds default · implement · strategy · apollo · flow · sovereign and closes', consented.join(',') === 'implement,strategy,apollo,flow,sovereign,default', consented.join(' → '))
  check("an unconsented ring is the same less Sovereign", plain.join(',') === 'implement,strategy,apollo,flow,default', plain.join(' → '))
  check("a consented seat's ring includes Sovereign from the FIRST station (born sovereign, the walk returns through it)", walk(true, 'sovereign').includes('sovereign') && walk(true, 'implement').includes('sovereign'))
  check('Sovereign never appears without consent from any start', (['default', 'implement', 'strategy', 'apollo', 'flow'] as PermissionMode[]).every(m => !walk(false, m).includes('sovereign')))
  process.env.MERCURY_CONCOURSE_WORKER = '1'
  const refusedConsented = consented.filter(m => !resolvePermissionModeTransition(m as never, ctx('default', true)).ok)
  const refusedPlain = plain.filter(m => !resolvePermissionModeTransition(m as never, ctx('default', false)).ok)
  delete process.env.MERCURY_CONCOURSE_WORKER
  check('every consented station is accepted by the runner under the worker stamp', refusedConsented.length === 0, refusedConsented.join(','))
  check('every unconsented station is accepted by an unconsented runner', refusedPlain.length === 0, refusedPlain.join(','))
  const bounce = resolvePermissionModeTransition('sovereign' as never, ctx('default', false))
  check('…and the one station the ring withholds (Sovereign without consent) is exactly what the runner refuses', !bounce.ok && /dangerously-bypass-permissions/.test(bounce.ok ? '' : bounce.error))
}

console.log(`\nprove-band-mode-owner: ${passes} PASS · ${failures} FAIL`)
console.log(failures === 0 ? 'prove-band-mode-owner: ALL LAWS HOLD' : `prove-band-mode-owner: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
