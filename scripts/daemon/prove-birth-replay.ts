#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'birth-replay-')))
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
const text = (v: unknown): string => JSON.stringify(v)

const { enableConfigs, saveGlobalConfig } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const sup = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
const controlServer = await import('../../src/daemon/control/controlServer.ts')
type Spec = ReturnType<typeof sup.buildConcourseWorkerSpec>

class FakeRoster {
  registered: Array<{ short: string; spec: Spec }> = []
  present = new Map<string, { alive: boolean; ready: boolean }>()
  has(short: string): { alive: boolean; present: boolean; ready: boolean } {
    const p = this.present.get(short)
    return p ? { present: true, alive: p.alive, ready: p.ready } : { present: false, alive: false, ready: false }
  }
  list(): Array<{ short: string; outcome?: string }> {
    return [...this.present.keys()].map(short => ({ short }))
  }
  registerLongLived(short: string, spec: Spec): { ok: boolean; pid?: number; error?: string } {
    this.registered.push({ short, spec })
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

function world(seats: number): { admit: ReturnType<typeof sup.makeConcourseAdmitHandler>; roster: FakeRoster; dir: string; ws: string; records: () => Record<string, import('../../src/daemon/concourse-workers/concourseWorkers.ts').ConcourseWorkerRecordV1> } {
  saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: seats } }))
  const roster = new FakeRoster()
  const dir = mkdtempSync(join(SCRATCH, 'daemon-'))
  const ws = realpathSync(mkdtempSync(join(SCRATCH, 'ws-')))
  const admit = sup.makeConcourseAdmitHandler({ roster: () => roster as never, dir })
  return { admit, roster, dir, ws, records: () => sup.readSessionWorkers(dir) }
}
const K1 = '7d0e3d7e-2a4c-4a0f-9c1b-000000000001'
const K2 = '7d0e3d7e-2a4c-4a0f-9c1b-000000000002'
const K3 = '7d0e3d7e-2a4c-4a0f-9c1b-000000000003'
const K4 = '7d0e3d7e-2a4c-4a0f-9c1b-000000000004'
const sessionOf = (r: Awaited<ReturnType<ReturnType<typeof sup.makeConcourseAdmitHandler>>>): string | null => (r.ok ? r.sessionId : null)

console.log('============================================================')
console.log(' the birth key: an admit replayed with the key of a standing birth answers that birth')
console.log('============================================================')

console.log('\nR1 the same key twice ⇒ the same admission, one record, one runner')
{
  const w = world(8)
  const first = await w.admit({ workspaceDir: w.ws, isolation: 'shared', bornBlank: true, birthKey: K1 })
  check('R1 the first admit with a key is admitted', first.ok, (first.ok ? '' : first.error) + ' — makeConcourseAdmitHandler (src/daemon/concourse-workers/admit.ts) refused a plain keyed admit; the error above names why')
  const again = await w.admit({ workspaceDir: w.ws, isolation: 'shared', bornBlank: true, birthKey: K1 })
  check('R1 the second admit with the SAME key answers the SAME session and runner', again.ok && first.ok && again.sessionId === first.sessionId && again.runnerId === first.runnerId, text({ first: sessionOf(first), again: sessionOf(again) }) + ' — fix the birthKey replay branch in makeConcourseAdmitHandler, src/daemon/concourse-workers/admit.ts')
  check('R1 the replay answers the original admission whole (workspace, model, effort, kit source, pid)', again.ok && first.ok && again.workspaceId === first.workspaceId && again.modelId === first.modelId && again.effort === first.effort && again.kitSource === first.kitSource && again.pid === first.pid, text({ first, again }) + ' — the replay branch must answer the standing record whole (src/daemon/concourse-workers/admit.ts, makeConcourseAdmitHandler)')
  const recs = Object.values(w.records())
  check('R1 exactly ONE record stands, stamped with the key', recs.length === 1 && recs[0]!.birthKey === K1 && recs[0]!.bornBlankAt !== undefined, text(recs.map(r => ({ runnerId: r.runnerId, birthKey: r.birthKey }))) + ' — a keyed admit must write one record stamped with birthKey and bornBlankAt (src/daemon/concourse-workers/admit.ts, with admitCold.ts / admitWarm.ts)')
  check('R1 exactly ONE runner was registered (the replay spawned nothing)', w.roster.registered.length === 1, `registered ${w.roster.registered.length} — a replayed birthKey must return before spawning a runner (src/daemon/concourse-workers/admit.ts)`)

  console.log('\nR2 a different key ⇒ a new session')
  const other = await w.admit({ workspaceDir: w.ws, isolation: 'shared', bornBlank: true, birthKey: K2 })
  check('R2 another key births another session', other.ok && first.ok && other.sessionId !== first.sessionId && other.runnerId !== first.runnerId, text({ first: sessionOf(first), other: sessionOf(other) }) + ' — the replay match must compare the birthKey exactly (src/daemon/concourse-workers/admit.ts)')
  check('R2 two records stand, each with its own key', Object.values(w.records()).map(r => r.birthKey).sort().join(',') === [K1, K2].sort().join(','), text(Object.values(w.records()).map(r => r.birthKey)) + ' — each admitted record must carry its own birthKey (src/daemon/concourse-workers/admit.ts, admitCold.ts, admitWarm.ts)')

  console.log('\nR3 a key on an ENDED record ⇒ a new session (the record is the memory; an ended one remembers nothing)')
  sup.updateConcourseWorkers(workers => {
    for (const rec of Object.values(workers)) if (rec.birthKey === K1) rec.endedAt = Date.now()
  }, w.dir)
  const afterEnd = await w.admit({ workspaceDir: w.ws, isolation: 'shared', bornBlank: true, birthKey: K1 })
  check('R3 the key of an ended record mints a fresh session', afterEnd.ok && first.ok && afterEnd.sessionId !== first.sessionId, text({ first: sessionOf(first), afterEnd: sessionOf(afterEnd) }) + ' — the replay match in src/daemon/concourse-workers/admit.ts must require endedAt === undefined')
  check('R3 the fresh record carries the key; the ended one keeps its own', Object.values(w.records()).filter(r => r.birthKey === K1).length === 2 && Object.values(w.records()).filter(r => r.birthKey === K1 && r.endedAt === undefined).length === 1, 'the replay match in src/daemon/concourse-workers/admit.ts must skip records with endedAt set, and the fresh admit must stamp birthKey')

  console.log('\nR4 no key ⇒ every admit mints (the other senders behave as before)')
  const bareA = await w.admit({ workspaceDir: w.ws, isolation: 'shared', bornBlank: true })
  const bareB = await w.admit({ workspaceDir: w.ws, isolation: 'shared', bornBlank: true })
  check('R4 two keyless-of-identity admits are two sessions', bareA.ok && bareB.ok && bareA.sessionId !== bareB.sessionId, text({ a: sessionOf(bareA), b: sessionOf(bareB) }) + ' — replay in src/daemon/concourse-workers/admit.ts must run only when req.birthKey is defined')
  check('R4 their records carry no key', Object.values(w.records()).filter(r => r.birthKey === undefined).length === 2, 'an admit with no birthKey must not stamp one on its record (src/daemon/concourse-workers/admit.ts, admitCold.ts, admitWarm.ts)')

  console.log("\nR5 a replay from another workspace's record is not a replay")
  const elsewhere = realpathSync(mkdtempSync(join(SCRATCH, 'ws-other-')))
  const cross = await w.admit({ workspaceDir: elsewhere, isolation: 'shared', bornBlank: true, birthKey: K2 })
  check('R5 the same key in another workspace births there (the record is keyed by key AND workspace)', cross.ok && other.ok && cross.sessionId !== other.sessionId && cross.workspaceId === elsewhere, text({ other: sessionOf(other), cross: sessionOf(cross) }) + ' — the replay match in src/daemon/concourse-workers/admit.ts must also compare workspaceId')
}

console.log('\nR6 a replay at capacity answers the birth that stands — never a refusal beside it')
{
  const w = world(1)
  const first = await w.admit({ workspaceDir: w.ws, isolation: 'shared', bornBlank: true, birthKey: K3 })
  check('R6 the one seat is taken by the first admit', first.ok, (first.ok ? '' : first.error) + ' — the first admit on a one-seat world must succeed (makeConcourseAdmitHandler, src/daemon/concourse-workers/admit.ts)')
  const again = await w.admit({ workspaceDir: w.ws, isolation: 'shared', bornBlank: true, birthKey: K3 })
  check('R6 the replay with the same key is answered with that session although the world is full', again.ok && first.ok && again.sessionId === first.sessionId, text(again) + ' — the birthKey replay in src/daemon/concourse-workers/admit.ts must run before the live-session ceiling check')
  const fresh = await w.admit({ workspaceDir: w.ws, isolation: 'shared', bornBlank: true, birthKey: K4 })
  check('R6 a new key on the full world meets the capacity refusal (the ceiling still rules a real second birth)', !fresh.ok && /seat|ceiling|capacity/i.test(fresh.ok ? '' : `${fresh.code} ${fresh.error}`), text(fresh) + ' — a new key past the ceiling must be refused with runtime-ceiling (src/daemon/concourse-workers/admit.ts)')
  check('R6 one record, one runner', Object.values(w.records()).length === 1 && w.roster.registered.length === 1, 'a replay must neither add a record nor register a runner (src/daemon/concourse-workers/admit.ts)')
}

console.log('\nR7 the shape gate at the wire')
{
  const gate = (controlServer as { isBirthKey?: (value: unknown) => boolean }).isBirthKey
  check('R7 the gate exists on the control server', typeof gate === 'function', 'export isBirthKey from src/daemon/control/controlServer.ts')
  const isBirthKey = (value: unknown): boolean => (typeof gate === 'function' ? gate(value) : false)
  check('R7 a UUID is a birth key', isBirthKey(K1), 'isBirthKey in src/daemon/control/controlServer.ts must accept 8 to 64 letters, digits and dashes')
  check('R7 an empty string, spaces, punctuation, a number and an over-long string are refused', typeof gate === 'function' && !isBirthKey('') && !isBirthKey('a b c d e f g h') && !isBirthKey('abc;def;ghi') && !isBirthKey(42) && !isBirthKey('x'.repeat(65)) && !isBirthKey('short'), 'isBirthKey in src/daemon/control/controlServer.ts must accept only 8 to 64 letters, digits and dashes')
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-birth-replay: ALL LAWS HOLD' : `\nprove-birth-replay: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
