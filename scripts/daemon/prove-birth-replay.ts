#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
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
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY',
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
const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')
const text = (v: unknown): string => JSON.stringify(v)

const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const sup = await import('../../src/daemon/concourseSupervisor.ts')
const controlServer = await import('../../src/daemon/controlServer.ts')
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

function world(seats: number): { admit: ReturnType<typeof sup.makeConcourseAdmitHandler>; roster: FakeRoster; dir: string; ws: string; records: () => Record<string, import('../../src/daemon/concourseSupervisor.ts').ConcourseWorkerRecordV1> } {
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
  check('R1 the first admit with a key is admitted', first.ok, first.ok ? '' : first.error)
  const again = await w.admit({ workspaceDir: w.ws, isolation: 'shared', bornBlank: true, birthKey: K1 })
  check('R1 the second admit with the SAME key answers the SAME session and runner', again.ok && first.ok && again.sessionId === first.sessionId && again.runnerId === first.runnerId, text({ first: sessionOf(first), again: sessionOf(again) }))
  check('R1 the replay answers the original admission whole (workspace, model, effort, kit source, pid)', again.ok && first.ok && again.workspaceId === first.workspaceId && again.modelId === first.modelId && again.effort === first.effort && again.kitSource === first.kitSource && again.pid === first.pid, text({ first, again }))
  const recs = Object.values(w.records())
  check('R1 exactly ONE record stands, stamped with the key', recs.length === 1 && recs[0]!.birthKey === K1 && recs[0]!.bornBlankAt !== undefined, text(recs.map(r => ({ runnerId: r.runnerId, birthKey: r.birthKey }))))
  check('R1 exactly ONE runner was registered (the replay spawned nothing)', w.roster.registered.length === 1, `registered ${w.roster.registered.length}`)

  console.log('\nR2 a different key ⇒ a new session')
  const other = await w.admit({ workspaceDir: w.ws, isolation: 'shared', bornBlank: true, birthKey: K2 })
  check('R2 another key births another session', other.ok && first.ok && other.sessionId !== first.sessionId && other.runnerId !== first.runnerId, text({ first: sessionOf(first), other: sessionOf(other) }))
  check('R2 two records stand, each with its own key', Object.values(w.records()).map(r => r.birthKey).sort().join(',') === [K1, K2].sort().join(','), text(Object.values(w.records()).map(r => r.birthKey)))

  console.log('\nR3 a key on an ENDED record ⇒ a new session (the record is the memory; an ended one remembers nothing)')
  sup.updateConcourseWorkers(workers => {
    for (const rec of Object.values(workers)) if (rec.birthKey === K1) rec.endedAt = Date.now()
  }, w.dir)
  const afterEnd = await w.admit({ workspaceDir: w.ws, isolation: 'shared', bornBlank: true, birthKey: K1 })
  check('R3 the key of an ended record mints a fresh session', afterEnd.ok && first.ok && afterEnd.sessionId !== first.sessionId, text({ first: sessionOf(first), afterEnd: sessionOf(afterEnd) }))
  check('R3 the fresh record carries the key; the ended one keeps its own', Object.values(w.records()).filter(r => r.birthKey === K1).length === 2 && Object.values(w.records()).filter(r => r.birthKey === K1 && r.endedAt === undefined).length === 1)

  console.log('\nR4 no key ⇒ every admit mints (the other senders behave as before)')
  const bareA = await w.admit({ workspaceDir: w.ws, isolation: 'shared', bornBlank: true })
  const bareB = await w.admit({ workspaceDir: w.ws, isolation: 'shared', bornBlank: true })
  check('R4 two keyless-of-identity admits are two sessions', bareA.ok && bareB.ok && bareA.sessionId !== bareB.sessionId, text({ a: sessionOf(bareA), b: sessionOf(bareB) }))
  check('R4 their records carry no key', Object.values(w.records()).filter(r => r.birthKey === undefined).length === 2)

  console.log("\nR5 a replay from another workspace's record is not a replay")
  const elsewhere = realpathSync(mkdtempSync(join(SCRATCH, 'ws-other-')))
  const cross = await w.admit({ workspaceDir: elsewhere, isolation: 'shared', bornBlank: true, birthKey: K2 })
  check('R5 the same key in another workspace births there (the record is keyed by key AND workspace)', cross.ok && other.ok && cross.sessionId !== other.sessionId && cross.workspaceId === elsewhere, text({ other: sessionOf(other), cross: sessionOf(cross) }))
}

console.log('\nR6 a replay at capacity answers the birth that stands — never a refusal beside it')
{
  const w = world(1)
  const first = await w.admit({ workspaceDir: w.ws, isolation: 'shared', bornBlank: true, birthKey: K3 })
  check('R6 the one seat is taken by the first admit', first.ok, first.ok ? '' : first.error)
  const again = await w.admit({ workspaceDir: w.ws, isolation: 'shared', bornBlank: true, birthKey: K3 })
  check('R6 the replay with the same key is answered with that session although the world is full', again.ok && first.ok && again.sessionId === first.sessionId, text(again))
  const fresh = await w.admit({ workspaceDir: w.ws, isolation: 'shared', bornBlank: true, birthKey: K4 })
  check('R6 a new key on the full world meets the capacity refusal (the ceiling still rules a real second birth)', !fresh.ok && /seat|ceiling|capacity/i.test(fresh.ok ? '' : `${fresh.code} ${fresh.error}`), text(fresh))
  check('R6 one record, one runner', Object.values(w.records()).length === 1 && w.roster.registered.length === 1)
}

console.log('\nR7 the shape gate at the wire')
{
  const gate = (controlServer as { isBirthKey?: (value: unknown) => boolean }).isBirthKey
  check('R7 the gate exists on the control server', typeof gate === 'function')
  const isBirthKey = (value: unknown): boolean => (typeof gate === 'function' ? gate(value) : false)
  check('R7 a UUID is a birth key', isBirthKey(K1))
  check('R7 an empty string, spaces, punctuation, a number and an over-long string are refused', typeof gate === 'function' && !isBirthKey('') && !isBirthKey('a b c d e f g h') && !isBirthKey('abc;def;ghi') && !isBirthKey(42) && !isBirthKey('x'.repeat(65)) && !isBirthKey('short'))
}

console.log('\nR8 the source seams: the wire narrows and forwards the key, both mints stamp it, the door mints one key per birth')
{
  const server = read('src/daemon/controlServer.ts')
  const admitAt = server.indexOf("case 'sessionAdmit': {")
  const admitBody = server.slice(admitAt, server.indexOf("case 'concourseWithdraw'", admitAt))
  check('R8 a malformed key refuses typed BEFORE the admit runs', admitBody.indexOf('if (raw.birthKey !== undefined && !isBirthKey(raw.birthKey))') !== -1 && admitBody.indexOf('if (raw.birthKey !== undefined && !isBirthKey(raw.birthKey))') < admitBody.indexOf('const r = await deps.concourseAdmit('))
  check('R8 a well-formed key is forwarded into the admit request', admitBody.includes("...(typeof raw.birthKey === 'string' ? { birthKey: raw.birthKey } : {}),"))
  const source = read('src/daemon/concourseSupervisor.ts')
  const handlerAt = source.indexOf('export function makeConcourseAdmitHandler(')
  const replayAt = source.indexOf('if (req.birthKey !== undefined) {', handlerAt)
  const reactivateAt = source.indexOf('if (req.resumeSessionId !== undefined) {', handlerAt)
  const foldAt = source.indexOf('const resolution = resolveDefaultedAdmission(', handlerAt)
  const claimAt = source.indexOf('deps.claimWarm !== undefined &&', handlerAt)
  const coldAt = source.indexOf('let runnerId: string | null = null', claimAt)
  const handlerEnd = source.indexOf('function mintWorktreeBranchName', coldAt)
  check('R8 the replay is judged BEFORE the reactivate, the capacity fold, the warm claim and the cold mint', replayAt !== -1 && reactivateAt !== -1 && foldAt !== -1 && claimAt !== -1 && replayAt < reactivateAt && replayAt < foldAt && replayAt < claimAt)
  check('R8 the replay reads an UN-ENDED record of the SAME workspace with the key', source.slice(replayAt, reactivateAt).includes('r.birthKey === req.birthKey && r.endedAt === undefined && r.workspaceId === workspaceId'))
  const stamp = '...(req.birthKey !== undefined ? { birthKey: req.birthKey } : {}),'
  check('R8 the warm-claim mint stamps the key', source.slice(claimAt, coldAt).includes(stamp))
  check('R8 the cold-spawn mint stamps the key', source.slice(coldAt, handlerEnd).includes(stamp))
  const protocol = read('src/daemon/protocol.ts')
  const opAt = protocol.indexOf("op: 'sessionAdmit'")
  const opEnd = protocol.indexOf("| { op: 'sessionList'", opAt)
  check('R8 the protocol names the field on the admit op', opAt !== -1 && opEnd > opAt && protocol.slice(opAt, opEnd).includes('birthKey?: string'))
  const door = read('src/services/switchboard/bornSession.ts')
  const doorAt = door.indexOf('async function admitAndEnter(')
  const mintAt = door.indexOf('const birthKey = randomUUID()', doorAt)
  const closureAt = door.indexOf('const admit = (): Promise<Record<string, unknown>> => daemonControlRpc(', doorAt)
  check('R8 the door mints ONE key per birth, before the admit closure, so both sends carry it', mintAt !== -1 && closureAt !== -1 && mintAt < closureAt && door.slice(closureAt, door.indexOf('{ timeoutMs: 60_000 }', closureAt)).includes('birthKey,'))
  check("R8 the coordinator's contracted birth carries the launch's own minted id as its key, right behind bornBlank", read('src/services/concourse/coordinatorTools.ts').includes("bornBlank: true,\n        birthKey: clientMessageId,"))
  check("R8 the manager's lane births carry ONE key per plan entry and lane, hashed (never the colon-joined pair), on the initial start and the walker alike", read('src/services/concourse/managerMode.ts').includes('const birthKey = init.entryId === undefined ? undefined : `mgr-${createHash(\'sha256\').update(`${init.entryId}:${laneIndex}`).digest(\'hex\').slice(0, 40)}`') && read('src/services/concourse/managerMode.ts').includes('...(birthKey !== undefined ? { birthKey } : {})') && read('src/services/concourse/managerMode.ts').includes('{ workspaceRoot, ...init, ...(entryId !== undefined ? { entryId } : {}) }'))
  check('R8 the hop door carries no birth key', !read('src/services/switchboard/hopIntoSession.ts').includes('birthKey'))
  const docs = read('docs/SESSIONS.md')
  check('R8 the sessions page says a lost answer lands the ↵ in the one session', docs.includes('answers the retry with the session it already holds'))
}

type AdmitReq = Parameters<ReturnType<typeof sup.makeConcourseAdmitHandler>>[0]
const forwardedAdmit = (r: Record<string, unknown>): AdmitReq => ({
  workspaceDir: String(r.workspaceDir),
  isolation: 'shared',
  bornBlank: true,
  ...(typeof r.title === 'string' ? { title: r.title } : {}),
  ...(typeof r.birthKey === 'string' ? { birthKey: r.birthKey } : {}),
})

console.log("\nR9 the coordinator's contracted launch: the birth reply lost after the daemon wrote the frame, the SAME request re-sent ⇒ one session, one runner")
{
  const w = world(8)
  const tools = await import('../../src/services/concourse/coordinatorTools.ts')
  const admitted: Array<string | null> = []
  let sentKey: unknown
  const ctx = tools.createCoordinatorToolContext({
    workspaceRoot: w.ws,
    by: 'coordinator-test',
    rpc: async req => {
      const r = req as Record<string, unknown>
      if (r.op === 'sessionAdmit') {
        sentKey = r.birthKey
        const lost = await w.admit(forwardedAdmit(r))
        admitted.push(sessionOf(lost))
        const answered = await w.admit(forwardedAdmit(r))
        admitted.push(sessionOf(answered))
        return answered as unknown as Record<string, unknown>
      }
      if (r.op === 'sessionDispatch') return { ok: true, state: 'working', sessionId: r.targetSessionId, runnerId: 'r', stateRevision: 2 }
      return { ok: true, outcome: 'applied' }
    },
    readWorkers: async () => ({}),
  })
  const launch = tools.coordinatorToolSet().find(d => d.name === 'launch_session')
  check('R9 the coordinator tool set carries launch_session', launch !== undefined)
  const out = launch === undefined ? null : (JSON.parse((await launch.run({ task: 'fix the parser', contract: 'scope: the parser only', workflows: false }, ctx)).content) as Record<string, unknown>)
  check('R9 the admit the coordinator sent named itself with a key the wire admits', typeof sentKey === 'string' && controlServer.isBirthKey(sentKey), text(sentKey))
  check('R9 the re-sent admit was answered with the SAME session the lost reply had minted', admitted.length === 2 && admitted[0] !== null && admitted[0] === admitted[1], text(admitted))
  check("R9 the launch result names that one session", out !== null && out.ok === true && out.sessionId === admitted[0], text(out))
  check('R9 exactly ONE record stands and ONE runner was registered (the retry spawned nothing)', Object.values(w.records()).length === 1 && w.roster.registered.length === 1, text({ records: Object.values(w.records()).map(r => r.birthKey), registered: w.roster.registered.length }))
}

console.log("\nR10 the manager's lane: the birth reply times out after the daemon wrote the frame, the lane waits, the walker re-births it ⇒ one session, one runner")
{
  const w = world(8)
  const mgr = await import('../../src/services/concourse/managerMode.ts')
  const plan = mgr.decodeManagerPlan({ goal: 'ship the widget', lanes: [{ title: 'lane A', scope: 'build the parser', deliverables: 'parser.ts green', territory: 'src/parser/**' }], supervision: 'launch-only', state: 'proposed' })
  check('R10 a one-lane plan decodes', plan !== null)
  if (plan !== null) {
    const keys: unknown[] = []
    const timedOut = async (req: unknown): Promise<Record<string, unknown>> => {
      const r = req as Record<string, unknown>
      if (r.op === 'sessionAdmit') {
        keys.push(r.birthKey)
        await w.admit(forwardedAdmit(r))
        return { ok: false, code: 'ETIMEOUT', error: 'timed out' }
      }
      return { ok: true, outcome: 'applied' }
    }
    const first = await mgr.executeManagerPlan(plan, { workspaceRoot: w.ws, by: 'coordinator-test', rpc: timedOut, entryId: 'entry-lost-reply' })
    check('R10 the timed-out birth leaves the lane WAITING (no session id, the lane in the waiting set)', first.laneSessionIds[0] === null && text(first.laneWaiting) === '[0]', text(first))
    check('R10 the daemon holds the frame the reply never reached: one record, one runner', Object.values(w.records()).length === 1 && w.roster.registered.length === 1)
    mgr._resetManagerSupervisionForTesting()
    mgr.registerDispatchedManagerPlan({ ...plan, state: 'dispatched', laneSessionIds: first.laneSessionIds, laneWaiting: first.laneWaiting, workspaceRoot: w.ws }, { entryId: 'entry-lost-reply', workspaceRoot: w.ws })
    const walkerRpc = async (req: unknown): Promise<Record<string, unknown>> => {
      const r = req as Record<string, unknown>
      if (r.op === 'sessionAdmit') {
        keys.push(r.birthKey)
        return (await w.admit(forwardedAdmit(r))) as unknown as Record<string, unknown>
      }
      if (r.op === 'sessionDispatch') return { ok: true, state: 'working' }
      return { ok: true, outcome: 'applied' }
    }
    const startedLane = await mgr.startWaitingManagerLane({ live: 0, ceiling: 4 }, { rpc: walkerRpc, by: 'coordinator-test' }, mkdtempSync(join(SCRATCH, 'conv-')))
    mgr._resetManagerSupervisionForTesting()
    check('R10 the walker started the waiting lane', startedLane === 0, text(startedLane))
    check('R10 both births carried the SAME well-formed key (the entry and the lane, hashed)', keys.length === 2 && typeof keys[0] === 'string' && controlServer.isBirthKey(keys[0]) && keys[0] === keys[1], text(keys))
    check("R10 the walker's birth met the daemon's replay: STILL one record and one runner (the base birthed a second blank session here)", Object.values(w.records()).length === 1 && w.roster.registered.length === 1, text({ records: Object.values(w.records()).map(r => ({ birthKey: r.birthKey, sessionId: r.sessionId })), registered: w.roster.registered.length }))
    const other = await mgr.executeManagerPlan(plan, { workspaceRoot: w.ws, by: 'coordinator-test', rpc: walkerRpc, entryId: 'entry-another' })
    check('R10 another plan entry births its own lane under a different key (the key is per entry and lane, never per title)', other.laneSessionIds[0] !== null && keys.length === 3 && keys[2] !== keys[0] && Object.values(w.records()).length === 2, text({ keys, records: Object.values(w.records()).length }))
  }
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-birth-replay: ALL LAWS HOLD' : `\nprove-birth-replay: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
