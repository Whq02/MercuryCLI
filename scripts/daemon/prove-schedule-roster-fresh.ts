#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'schedule-roster-fresh-home-'))
const DAEMON_DIR = mkdtempSync(join(tmpdir(), 'schedule-roster-fresh-daemon-'))
process.env.MERCURY_DAEMON_DIR = DAEMON_DIR
mkdirSync(DAEMON_DIR, { recursive: true })
delete process.env.MERCURY_HOME
delete process.env.MERCURY_SATURN_DISABLE
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
delete process.env.CI
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const saturn = await import('../../src/daemon/saturn.ts')
const { updateConcourseWorkers, concourseWorkersPath } = await import('../../src/daemon/concourseWorkers.ts')
const { tickSaturnOnce } = await import('../../src/daemon/saturnTicker.ts')
const { liveFactsForSessionFire } = await import('../../src/daemon/saturnAccount.ts')
const { pushScheduleRosterForSession } = await import('../../src/daemon/sessionSeat.ts')
const bridge = await import('../../src/services/saturn/sessionScheduleBridge.ts')
const { CronListTool, pastDueFireRow, PAST_FIRE_GRACE_MS } = await import('../../src/tools/ScheduleCronTool/CronListTool.ts')
const { wakeDelaySpelling } = await import('../../src/utils/messages/noticeRows.ts')
const listCall = (): Promise<unknown> => (CronListTool as unknown as { call: () => Promise<unknown> }).call()
type Schedule = import('../../src/daemon/saturn.ts').SaturnScheduleV1
type FactsRow = import('../../src/daemon/saturn.ts').SaturnFactsRowV1

let checks = 0
let failures = 0
function check(label: string, cond: boolean, detail: unknown = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

const SESSION = 'sess-roster-fresh-1'
const SHORT = 'concourse-w7'
const MIN = 60_000
const NOW = Date.parse('2026-10-26T20:05:14Z')
const ACCOUNT = { family: 'anthropic', source: 'oauth' as const, scopeDir: join(DAEMON_DIR, 'scope'), identity: 'operator@example.com', knownExpiresAt: NOW + 86_400_000, refreshable: true }
const sched = (over: Partial<Schedule> & Pick<Schedule, 'id' | 'when' | 'action' | 'createdBy'>): Schedule => ({ schema: 1, account: { ...ACCOUNT }, modelKey: 'claude-opus-5', createdAt: NOW - 60 * MIN, ...over })
const selfWake = (id: string, atMs: number): Schedule => sched({ id, when: { kind: 'at', atMs, spelling: wakeDelaySpelling(1200) }, action: { kind: 'fire', prompt: 'carry on', onParked: 'queue' }, createdBy: `model:${SESSION}` })
const recurring = (id: string): Schedule => sched({ id, when: { kind: 'every', cron: '0 9 * * *', spelling: 'every day 09:00' }, action: { kind: 'fire', prompt: 'stand-up notes' }, createdBy: `model:${SESSION}` })

function seedRecord(over: Record<string, unknown> = {}): void {
  updateConcourseWorkers(workers => {
    for (const key of Object.keys(workers)) delete workers[key]
    workers[SHORT] = { schema: 1, runnerId: SHORT, sessionId: SESSION, workspaceId: '/scratch/repo', isolation: 'shared', modelKey: 'claude-opus-5', effort: 'high', spawnedAt: Date.now(), lastLiveAt: Date.now(), ...over } as never
  }, DAEMON_DIR)
}
const scheduleIds = (): string[] => (((JSON.parse(readFileSync(concourseWorkersPath(DAEMON_DIR), 'utf8')) as { workers: Record<string, { schedules?: Array<{ id: string }> }> }).workers[SHORT]?.schedules ?? []).map(s => s.id))

const requests: Array<{ short: string; method: string; schedules: Array<Record<string, unknown>> }> = []
const pushes = (): typeof requests => requests.filter(r => r.method === 'schedule/roster')
const factsAsked = (): string[] => requests.filter(r => r.method === 'session/facts').map(r => r.short)
const rosterPort = {
  door: (short: string) => ({
    closed: false,
    request: async (method: string, params: { schedules?: Array<Record<string, unknown>> }) => {
      requests.push({ short, method, schedules: params?.schedules ?? [] })
      return {}
    },
    send: (method: string) => {
      requests.push({ short, method, schedules: [] })
      return { answer: Promise.resolve({}) }
    },
  }),
  list: () => [{ short: SHORT, state: 'ready', ready: true }],
  patchSeatModel: () => true,
  patchSeatEffort: () => true,
} as never

console.log('§A the interrupt\'s drop and every tick that moves a record push the roster to the runner in the same step')
{
  seedRecord({ schedules: [selfWake('fdd8fc42', NOW + 2 * MIN), recurring('a1b2c3d4')] })
  const gone = saturn.dropSaturnSelfWakes(SESSION, 'operator:test', 'interrupted', DAEMON_DIR)
  check('the interrupt drops the self-paced wake and writes its removal receipt', gone.dropped.length === 1 && gone.dropped[0] === 'fdd8fc42' && scheduleIds().join(',') === 'a1b2c3d4', gone)
  const pushed = pushScheduleRosterForSession(SESSION, rosterPort, DAEMON_DIR)
  check('the session-keyed push finds the live record and sends the post-drop roster down the runner\'s door', pushed && pushes().length === 1 && pushes()[0]!.short === SHORT && pushes()[0]!.schedules.map(row => row.id).join(',') === 'a1b2c3d4', requests)
  check('…and asks the seat for fresh facts, so the screen follows too', factsAsked().length === 1 && factsAsked()[0] === SHORT, requests)
  check('a session with no live record is not pushed', pushScheduleRosterForSession('sess-nobody', rosterPort, DAEMON_DIR) === false && pushes().length === 1)

  const main = readFileSync(join(import.meta.dir, '../..', 'src/daemon/main.ts'), 'utf8')
  const interruptArm = main.slice(main.indexOf("if (action === 'interrupt')"), main.indexOf("if (action === 'stop-agent' || action === 'resume-agent')"))
  check("the interrupt door hands the roster to the drop, and the drop pushes the roster for the session when a wake went", interruptArm.includes("dropSelfWakesAtFlip(sessionId, by, 'interrupted', roster)") && main.includes('if (roster !== null) pushScheduleRosterForSession(sessionId, roster)'))
  check('the ticker\'s roster-changed port is wired to the same push', main.includes('rosterChanged: sessionId => {') && main.includes('if (roster !== null) pushScheduleRosterForSession(sessionId, roster)'))

  const changed: string[] = []
  const delivered: unknown[] = []
  const ports = {
    now: () => NOW,
    records: () => Object.values((JSON.parse(readFileSync(concourseWorkersPath(DAEMON_DIR), 'utf8')) as { workers: Record<string, { endedAt?: number }> }).workers).filter(r => r.endedAt === undefined) as never[],
    deriveAccount: () => ({ ok: true as const, account: { ...ACCOUNT } }),
    liveFacts: (account: { family: string; source: 'oauth' | 'api-key' | 'keyless' }, sessionId?: string) => liveFactsForSessionFire(account, sessionId, { presenceOf: () => ({ credentialed: true, kind: 'oauth' as const }), strandedNow: () => false, anthropicDetail: () => null, factsOf: () => null, now: () => NOW }),
    deliver: async (d: unknown) => { delivered.push(d); return { ok: true } },
    birth: async () => ({ ok: false, detail: 'no births in this proof' }),
    screenOpen: () => true,
    rosterChanged: (sessionId: string) => { changed.push(sessionId) },
    dir: DAEMON_DIR,
  } as never
  seedRecord({ schedules: [selfWake('eeee5555', NOW - MIN), recurring('a1b2c3d4')] })
  const fired = await tickSaturnOnce(ports)
  check('a tick that fires a due wake names the session as changed, once, after the delivery', fired.fired === 1 && delivered.length === 1 && changed.join(',') === SESSION && scheduleIds().join(',') === 'a1b2c3d4', { fired, changed })
  const quiet = await tickSaturnOnce(ports)
  check('a tick that moves nothing names no session', quiet.fired === 0 && quiet.dropped === 0 && changed.length === 1, { quiet, changed })
  seedRecord({ stoppedAt: NOW - 5 * MIN, stoppedBy: 'operator:test', schedules: [selfWake('dddd4444', NOW + 10 * MIN)] })
  const dropped = await tickSaturnOnce(ports)
  check('a tick that drops a stopped record\'s wake names the session too', dropped.dropped === 1 && changed.length === 2 && changed[1] === SESSION, { dropped, changed })
}

console.log('§B CronList: a dropped schedule disappears at once, a past-due fire row is not shown, and the result says when the roster was pushed')
{
  bridge._resetScheduleBridgeForTesting()
  const pushedAt = NOW
  const wake: FactsRow = { id: 'fdd8fc42', when: 'in ~1200s', kind: 'fire', nextFireMs: NOW - 63 * MIN }
  const standing: FactsRow = { id: 'b2c3d4e5', when: 'in ~600s', kind: 'fire', nextFireMs: NOW + 10 * MIN }
  const justDue: FactsRow = { id: 'c3d4e5f6', when: 'every day 09:00', kind: 'fire', nextFireMs: NOW - 10_000 }
  const paused: FactsRow = { id: 'd4e5f6a7', when: 'every day 09:00', kind: 'fire', nextFireMs: null, paused: true }
  const birth: FactsRow = { id: 'e5f6a7b8', when: 'on \'0 9 * * 1\'', kind: 'birth', nextFireMs: NOW + 60 * MIN, title: 'weekly plan' }
  check('the past-due law: a fire row past the grace is past due; one within the grace, a paused one, a future one and a birth are not', pastDueFireRow(wake, NOW) && !pastDueFireRow(justDue, NOW) && !pastDueFireRow(paused, NOW) && !pastDueFireRow(standing, NOW) && !pastDueFireRow({ ...birth, nextFireMs: NOW - 2 * PAST_FIRE_GRACE_MS }, NOW))
  const realNow = Date.now()
  const shift = realNow - NOW
  const row = (r: FactsRow): FactsRow => ({ ...r, ...(r.nextFireMs === null ? {} : { nextFireMs: r.nextFireMs + shift }) })
  bridge.latchSessionScheduleRoster([row(wake), row(standing), row(justDue), row(paused), row(birth)], pushedAt + shift)
  const listed = await listCall()
  const data = (listed as { data: { schedules: Array<{ id: string }>; rosterKnown: boolean; pushedAtMs?: number; pastDueHidden?: number } }).data
  check('the stale self-paced wake the daemon had already dropped is not listed; the rest stand', data.schedules.map(r => r.id).join(',') === 'b2c3d4e5,c3d4e5f6,d4e5f6a7,e5f6a7b8' && data.rosterKnown, data)
  check('the data carries the push time and the hidden count', data.pushedAtMs === pushedAt + shift && data.pastDueHidden === 1, data)
  const result = CronListTool.mapToolResultToToolResultBlockParam(data as never, 'toolu_1')
  const content = String(result.content)
  check('the model\'s result keeps the rows\' words, says when the roster was pushed and that a past-due fire row is not shown', content.startsWith('b2c3d4e5: in ~600s (fire) — next ') && content.includes('d4e5f6a7: every day 09:00 (fire) — paused') && content.includes(`Roster as the daemon pushed it at ${new Date(pushedAt + shift).toISOString()}.`) && content.endsWith(' 1 fire row whose fire time has passed is not shown.'), content)

  bridge.latchSessionScheduleRoster([row(standing)], realNow)
  const afterPush = (await listCall()) as { data: { schedules: Array<{ id: string }>; pastDueHidden?: number } }
  check('the daemon\'s next push lands at once: the dropped and the fired rows are gone, nothing is hidden', afterPush.data.schedules.map(r => r.id).join(',') === 'b2c3d4e5' && afterPush.data.pastDueHidden === undefined, afterPush.data)
  bridge.latchSessionScheduleRoster([], realNow)
  const empty = CronListTool.mapToolResultToToolResultBlockParam(((await listCall()) as { data: unknown }).data as never, 'toolu_2')
  check('an empty roster keeps its words and says when it was pushed', String(empty.content) === `No schedules on this session. Roster as the daemon pushed it at ${new Date(realNow).toISOString()}.`, empty.content)
  bridge._resetScheduleBridgeForTesting()
  const never = CronListTool.mapToolResultToToolResultBlockParam(((await listCall()) as { data: unknown }).data as never, 'toolu_3')
  check('a roster never pushed keeps today\'s words', String(never.content).startsWith('No roster yet — the daemon pushes this session\'s schedules at the facts beat'), never.content)
}

console.log(`\n${checks - failures} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
