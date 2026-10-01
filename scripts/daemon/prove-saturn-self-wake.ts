#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'saturn-self-wake-home-'))
const DAEMON_DIR = mkdtempSync(join(tmpdir(), 'saturn-self-wake-daemon-'))
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
const {
  applyConcourseScheduleOp,
  dropSaturnSelfWakes,
  fireDeltaWords,
  isSaturnSelfWake,
  saturnStandingOf,
  saturnStandingWords,
  saturnWakeGlanceOf,
  saturnWakeGlanceWords,
} = saturn
const { updateConcourseWorkers, concourseWorkersPath } = await import('../../src/daemon/concourseSupervisor.ts')
const { tickSaturnOnce } = await import('../../src/daemon/saturnTicker.ts')
const { liveFactsForSessionFire } = await import('../../src/daemon/saturnAccount.ts')
const receipts = await import('../../src/services/switchboard/sessionReceipts.ts')
const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
const bridge = await import('../../src/services/saturn/sessionScheduleBridge.ts')
const { ScheduleWakeupTool } = await import('../../src/tools/ScheduleWakeupTool/ScheduleWakeupTool.ts')
const { wakeDelaySpelling } = await import('../../src/utils/messages/noticeRows.ts')
const board = await import('../../src/components/BootSaturnScreen.tsx')
const { cronToHuman } = await import('../../src/utils/cron.ts')

type Schedule = import('../../src/daemon/saturn.ts').SaturnScheduleV1
type Held = import('../../src/daemon/saturn.ts').HeldFireV1

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const SESSION = 'sess-self-wake-1'
const WORKSPACE = '/scratch/repo'
const MIN = 60_000
const NOW = Date.parse('2026-09-30T12:00:00Z')
const ACCOUNT = { family: 'anthropic', source: 'oauth' as const, scopeDir: join(DAEMON_DIR, 'scope'), identity: 'operator@example.com', knownExpiresAt: NOW + 86_400_000, refreshable: true }
const okDeps = { deriveAccount: (_modelKey: string) => ({ ok: true as const, account: { ...ACCOUNT } }) }

function sched(over: Partial<Schedule> & Pick<Schedule, 'id' | 'when' | 'action' | 'createdBy'>): Schedule {
  return { schema: 1, account: { ...ACCOUNT }, modelKey: 'claude-opus-5', createdAt: NOW - 60 * MIN, ...over }
}
const selfWake = (id: string, atMs: number): Schedule =>
  sched({ id, when: { kind: 'at', atMs, spelling: wakeDelaySpelling(900) }, action: { kind: 'fire', prompt: 'carry on with the next unit', onParked: 'queue' }, createdBy: `model:${SESSION}` })
const heldFor = (s: Schedule, reason: Held['reason']): Held => ({
  scheduleId: s.id,
  dueAt: s.when.kind === 'at' ? s.when.atMs : NOW,
  reason,
  envelope: { scheduleId: s.id, kind: 'fire', dueAt: s.when.kind === 'at' ? s.when.atMs : NOW, prompt: 'carry on with the next unit', onParked: 'queue' },
  heldAt: NOW - 20 * MIN,
})
const operatorOneShot = (id: string, atMs: number): Schedule =>
  sched({ id, when: { kind: 'at', atMs, spelling: 'in 20m' }, action: { kind: 'fire', prompt: 'the nightly audit' }, createdBy: 'operator:test' })
const modelCronOneShot = (id: string, atMs: number): Schedule =>
  sched({ id, when: { kind: 'at', atMs, spelling: cronToHuman('0 9 30 9 *') }, action: { kind: 'fire', prompt: 'remind me', onParked: 'queue' }, createdBy: `model:${SESSION}` })
const modelRecurring = (id: string): Schedule =>
  sched({ id, when: { kind: 'every', cron: '0 9 * * *', spelling: 'every day 09:00' }, action: { kind: 'fire', prompt: 'stand-up notes' }, createdBy: `model:${SESSION}` })

function seedRecord(over: Record<string, unknown> = {}): void {
  updateConcourseWorkers(workers => {
    for (const key of Object.keys(workers)) delete workers[key]
    workers['concourse-w1'] = {
      schema: 1,
      runnerId: 'concourse-w1',
      sessionId: SESSION,
      workspaceId: WORKSPACE,
      isolation: 'shared',
      modelKey: 'claude-opus-5',
      effort: 'high',
      spawnedAt: Date.now(),
      lastLiveAt: Date.now(),
      ...over,
    } as never
  }, DAEMON_DIR)
}
function rawRecord(): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(concourseWorkersPath(DAEMON_DIR), 'utf8')) as { workers: Record<string, Record<string, unknown>> }
  return raw.workers['concourse-w1']!
}
const scheduleIds = (): string[] => ((rawRecord().schedules ?? []) as Array<{ id: string }>).map(s => s.id)
const heldRows = (): Held[] => (rawRecord().heldFires ?? []) as Held[]
const removeReceipts = (): Array<{ by: string; summary: string; details: Record<string, unknown> }> =>
  receipts
    .readSessionReceipts(getProjectDir(WORKSPACE), SESSION)
    .filter(r => r.kind === 'schedule-set' && (r.details as Record<string, unknown> | undefined)?.op === 'remove')
    .map(r => ({ by: r.by, summary: r.summary, details: (r.details ?? {}) as Record<string, unknown> }))

function boardRowValue(schedule: Schedule, held: Held[], parked: boolean): string {
  const facts = saturn.saturnFactsOf({ schedules: [schedule], heldFires: held.length > 0 ? held : undefined }, NOW)
  const f = facts.schedules!.find(r => r.id === schedule.id)!
  return board.saturnEntryOf({ sessionTitle: 'worker', sessionId: SESSION, workspaceId: WORKSPACE, parked, facts: f, schedule, held: held.filter(h => h.scheduleId === schedule.id) }, NOW).valueLabel
}

console.log('§A what stands — one derivation, the rail and the board agree')
{
  const wake = selfWake('aaaa1111', NOW - 26 * 60 * MIN)
  const held = [heldFor(wake, 'parked-queued')]
  const standing = saturnStandingOf(wake, held)
  check('A1 a held one-shot has NO next fire and one held fire', standing.nextFireMs === null && standing.held === 1 && standing.paused === false, JSON.stringify(standing))
  const glance = saturnWakeGlanceOf([{ schedules: [wake], heldFires: held }])
  const words = saturnWakeGlanceWords(glance, NOW)
  check('A2 the glance counts the schedule and the hold and names no fire', glance.count === 1 && glance.held === 1 && glance.nextFireMs === null, JSON.stringify(glance))
  check("A3 the rail's row says what stands — '1 scheduled · 1 held', no verb — never 'due now'", words.name === '1 scheduled · 1 held' && words.verb === undefined, JSON.stringify(words))
  const boardValue = boardRowValue(wake, held, true)
  check("A4 the board's row for the same record reads 'no future fire · 1 held'", boardValue === 'no future fire · 1 held', boardValue)
  check('A5 the board row IS the standing words (one derivation, two surfaces)', boardValue === saturnStandingWords(standing, NOW))
  check("A6 neither surface says 'due now' for a held fire", !words.name.includes('due now') && words.verb !== 'due now' && !boardValue.includes('due now'))

  const ahead = operatorOneShot('bbbb2222', NOW + 4 * MIN)
  const aheadGlance = saturnWakeGlanceWords(saturnWakeGlanceOf([{ schedules: [ahead] }]), NOW)
  check("A7 a real future fire reads 'in 4m' on the rail", aheadGlance.name === '1 scheduled' && aheadGlance.verb === 'in 4m', JSON.stringify(aheadGlance))
  check("A8 and 'in 4m' on the board", boardRowValue(ahead, [], false) === 'in 4m', boardRowValue(ahead, [], false))
  const mixed = saturnWakeGlanceWords(saturnWakeGlanceOf([{ schedules: [wake, ahead], heldFires: held }]), NOW)
  check("A9 a held fire beside a future one reads '2 scheduled · 1 held · in 4m'", mixed.name === '2 scheduled · 1 held' && mixed.verb === 'in 4m', JSON.stringify(mixed))
  const catchUp = operatorOneShot('cccc3333', NOW - 2 * MIN)
  const catchUpWords = saturnWakeGlanceWords(saturnWakeGlanceOf([{ schedules: [catchUp] }]), NOW)
  check("A10 a due, unheld one-shot reads 'due now' on both (the catch-up fire)", catchUpWords.verb === 'due now' && boardRowValue(catchUp, [], false) === 'due now', JSON.stringify({ catchUpWords, board: boardRowValue(catchUp, [], false) }))
  const owed = { ...modelRecurring('dddd4444'), createdAt: NOW - 3 * 24 * 60 * MIN }
  check('A11 a recurrence owed a past match reads due now', fireDeltaWords(saturnStandingOf(owed, undefined).nextFireMs, NOW) === 'due now')
  const fresh = { ...owed, lastFiredAt: NOW - MIN }
  const freshNext = saturnStandingOf(fresh, undefined).nextFireMs
  check('A12 a recurrence fired a minute ago reads its next match ahead', freshNext !== null && freshNext > NOW)
  const paused = { ...ahead, paused: true as const }
  const pausedWords = saturnWakeGlanceWords(saturnWakeGlanceOf([{ schedules: [paused] }]), NOW)
  check("A13 a paused row contributes no fire: '1 scheduled · no next fire' on the rail, 'paused' on the board", pausedWords.name === '1 scheduled' && pausedWords.verb === 'no next fire' && boardRowValue(paused, [], false) === 'paused', JSON.stringify(pausedWords))
  const mangled = saturnWakeGlanceOf([{ schedules: [{ id: 'junk' } as never, ahead], heldFires: 'nope' as never }])
  check('A14 a mangled row or hold field is skipped, the healthy row still counts', mangled.count === 1 && mangled.held === 0 && mangled.nextFireMs === NOW + 4 * MIN, JSON.stringify(mangled))
  const boxed = saturnWakeGlanceOf([{ schedules: [wake], heldFires: held }, { schedules: [ahead], heldFires: [] }])
  check('A15 a box-tier file beside the records folds into the same glance', boxed.count === 2 && boxed.held === 1 && boxed.nextFireMs === NOW + 4 * MIN, JSON.stringify(boxed))
}

console.log('§B the self-wake rule: the model, a one-shot, a fire, a wake spelling')
{
  check('B1 the tool-shaped row is a self-wake', isSaturnSelfWake(selfWake('aaaa1111', NOW + MIN)))
  check("B2 an operator's one-shot is not (createdBy 'operator:…')", !isSaturnSelfWake(operatorOneShot('bbbb2222', NOW + MIN)))
  const operatorWakeShaped = { ...selfWake('cccc3333', NOW + MIN), createdBy: 'operator:test' }
  check('B3 an operator row wearing the wake spelling is not (the actor decides too)', !isSaturnSelfWake(operatorWakeShaped))
  check("B4 a model's CronCreate one-shot is not (its spelling is cronToHuman's, never a wake delay)", !isSaturnSelfWake(modelCronOneShot('dddd4444', NOW + MIN)))
  check("B5 a model's recurrence is not", !isSaturnSelfWake(modelRecurring('eeee5555')))
  const birth = sched({ id: 'ffff6666', when: { kind: 'at', atMs: NOW + MIN, spelling: wakeDelaySpelling(60) }, action: { kind: 'birth', birth: { workspaceDir: '/w', modelKey: 'm', presence: 'headless' } }, createdBy: `model:${SESSION}` })
  check('B6 a birth is not (a fire alone paces a turn)', !isSaturnSelfWake(birth))
  const unspelled = { ...selfWake('0000aaaa', NOW + MIN), when: { kind: 'at' as const, atMs: NOW + MIN } }
  check('B7 a model one-shot with no spelling is not (the rule never guesses)', !isSaturnSelfWake(unspelled))

  bridge._resetScheduleBridgeForTesting()
  bridge.markScheduleSeatObserved()
  await ScheduleWakeupTool.call({ delaySeconds: 900, prompt: 'the next unit' } as never, {} as never)
  const edit = bridge.takePendingScheduleEdits()[0] as { op: string; schedule: { when: { spelling?: string } } }
  check("B8 the tool's edit carries the wake spelling the rule reads", edit.op === 'add' && edit.schedule.when.spelling === wakeDelaySpelling(900), JSON.stringify(edit))
  seedRecord()
  const applied = applyConcourseScheduleOp(SESSION, edit as never, `model:${SESSION}`, okDeps, DAEMON_DIR)
  const landed = ((rawRecord().schedules ?? []) as Schedule[]).find(s => s.id === applied.scheduleId)
  check('B9 applied through the one writer as the model, the landed row IS a self-wake', applied.outcome === 'applied' && landed !== undefined && isSaturnSelfWake(landed), JSON.stringify({ applied, landed }))
  bridge._resetScheduleBridgeForTesting()
}

console.log('§C the drop: the self-wake and its held fire leave, everything else stands')
{
  const wake = selfWake('aaaa1111', NOW - 26 * 60 * MIN)
  const op = operatorOneShot('bbbb2222', NOW + 20 * MIN)
  const cron = modelCronOneShot('cccc3333', NOW + 30 * MIN)
  const every = modelRecurring('dddd4444')
  seedRecord({ parkedAt: NOW - 25 * 60 * MIN, parkedBy: 'operator:test', schedules: [wake, op, cron, every], heldFires: [heldFor(wake, 'parked-queued')] })
  const before = removeReceipts().length
  const gone = dropSaturnSelfWakes(SESSION, 'operator:test', 'interrupted', DAEMON_DIR)
  check('C1 exactly the self-wake is dropped, with its one held fire', gone.dropped.length === 1 && gone.dropped[0] === 'aaaa1111' && gone.droppedHolds === 1, JSON.stringify(gone))
  check("C2 the operator's one-shot, the model's CronCreate one-shot and the model's recurrence stand", JSON.stringify(scheduleIds()) === JSON.stringify(['bbbb2222', 'cccc3333', 'dddd4444']), JSON.stringify(scheduleIds()))
  check('C3 the held-fires field is DROPPED WHOLE with its last hold (absent ≠ empty)', !('heldFires' in rawRecord()))
  const rows = removeReceipts()
  const row = rows[rows.length - 1]
  check('C4 one schedule-set remove receipt landed, by the actor who interrupted', rows.length === before + 1 && row !== undefined && row.by === 'operator:test', JSON.stringify(row))
  check("C5 the receipt names the schedule, why, the wake's spelling and the dropped hold", row !== undefined && row.summary === `schedule 'aaaa1111' removed — the turn was interrupted; its self-paced wake (${wakeDelaySpelling(900)}) paced a turn that is over (1 held fire dropped with it)`, row?.summary)
  check('C6 the receipt details carry the remove op, the self-wake mark and the reason', row !== undefined && row.details.op === 'remove' && row.details.id === 'aaaa1111' && row.details.selfWake === true && row.details.why === 'interrupted' && row.details.droppedHolds === 1, JSON.stringify(row?.details))
  const again = dropSaturnSelfWakes(SESSION, 'operator:test', 'interrupted', DAEMON_DIR)
  check('C7 a second drop finds nothing: nothing written, nothing rowed', again.dropped.length === 0 && again.droppedHolds === 0 && removeReceipts().length === rows.length && JSON.stringify(scheduleIds()) === JSON.stringify(['bbbb2222', 'cccc3333', 'dddd4444']))

  seedRecord({ schedules: [selfWake('eeee5555', NOW + 10 * MIN), selfWake('ffff6666', NOW + 12 * MIN)] })
  const both = dropSaturnSelfWakes(SESSION, id => `saturn:${id}`, 'parked', DAEMON_DIR)
  const tail = removeReceipts().slice(-2)
  check('C8 two self-wakes drop together and the schedules field goes whole', both.dropped.length === 2 && !('schedules' in rawRecord()), JSON.stringify({ both, rec: rawRecord() }))
  check("C9 each receipt wears its own schedule's by (the ticker's grammar) and the parked reason", tail.length === 2 && tail[0]!.by === 'saturn:eeee5555' && tail[1]!.by === 'saturn:ffff6666' && tail.every(r => r.details.why === 'parked' && r.summary.includes('the session was parked')), JSON.stringify(tail))
  seedRecord({ schedules: [op] })
  const none = dropSaturnSelfWakes(SESSION, 'operator:test', 'stopped', DAEMON_DIR)
  check("C10 a record with only an operator's schedule is untouched", none.dropped.length === 0 && JSON.stringify(scheduleIds()) === JSON.stringify(['bbbb2222']))
  const unknown = dropSaturnSelfWakes('sess-nobody', 'operator:test', 'stopped', DAEMON_DIR)
  check('C11 an unknown session drops nothing', unknown.dropped.length === 0 && unknown.droppedHolds === 0)
  seedRecord({ schedules: [{ id: 'junk-row' }, selfWake('aaaa1111', NOW + MIN)] })
  const withJunk = dropSaturnSelfWakes(SESSION, 'operator:test', 'parked', DAEMON_DIR)
  check('C12 a mangled sibling row is kept, never healed or dropped', withJunk.dropped.length === 1 && JSON.stringify(rawRecord().schedules) === JSON.stringify([{ id: 'junk-row' }]), JSON.stringify(rawRecord().schedules))
}

console.log("§D the ticker: a parked record's self-wake is dropped on the walk, never held")
{
  type Delivered = { clientMessageId: string; prompt: string; parked: boolean; sessionId: string }
  const delivered: Delivered[] = []
  const ports = {
    now: () => NOW,
    records: () => Object.values(JSON.parse(readFileSync(concourseWorkersPath(DAEMON_DIR), 'utf8')).workers as Record<string, { endedAt?: number }>).filter(r => r.endedAt === undefined) as never[],
    deriveAccount: (_m: string) => ({ ok: true as const, account: { ...ACCOUNT } }),
    liveFacts: (account: { family: string; source: 'oauth' | 'api-key' | 'keyless' }, sessionId?: string) =>
      liveFactsForSessionFire(account, sessionId, {
        presenceOf: () => ({ credentialed: true, kind: 'oauth' as const }),
        strandedNow: () => false,
        anthropicDetail: () => null,
        factsOf: () => null,
        now: () => NOW,
      }),
    deliver: async (d: Delivered) => {
      delivered.push(d)
      return { ok: true }
    },
    birth: async () => ({ ok: false, detail: 'no births in this proof' }),
    screenOpen: () => true,
    dir: DAEMON_DIR,
  } as never

  const wake = selfWake('aaaa1111', NOW - 26 * 60 * MIN)
  seedRecord({ parkedAt: NOW - 25 * 60 * MIN, parkedBy: 'operator:test', schedules: [wake], heldFires: [heldFor(wake, 'parked-queued')] })
  const before = removeReceipts().length
  const r1 = await tickSaturnOnce(ports)
  check('D1 the walk drops the held self-wake: one dropped, nothing fired, held or replayed', r1.dropped === 1 && r1.fired === 0 && r1.held === 0 && r1.replayed === 0 && r1.missed === 0 && delivered.length === 0, JSON.stringify(r1))
  check('D2 the row and its hold are gone from the record (both fields dropped whole)', !('schedules' in rawRecord()) && !('heldFires' in rawRecord()), JSON.stringify(rawRecord()))
  check('D3 the walk saw nothing pending after the drop (the change gate rests)', r1.pending === 0, String(r1.pending))
  const rows = removeReceipts()
  const row = rows[rows.length - 1]
  check("D4 the receipt is the ticker's, naming the parked reason and the dropped hold", rows.length === before + 1 && row !== undefined && row.by === 'saturn:aaaa1111' && row.details.why === 'parked' && row.details.droppedHolds === 1 && row.summary.includes('the session was parked'), JSON.stringify(row))
  const glanceAfter = saturnWakeGlanceOf(ports.records())
  check('D5 the glance over the record now shows nothing (the rail row disappears with the board row)', glanceAfter.count === 0 && glanceAfter.held === 0)
  const r2 = await tickSaturnOnce(ports)
  check('D6 a later tick finds nothing to drop', r2.dropped === 0 && r2.pending === 0, JSON.stringify(r2))

  delivered.length = 0
  seedRecord({ parkedAt: NOW - 5 * MIN, parkedBy: 'operator:test', schedules: [selfWake('bbbb2222', NOW + 10 * MIN), operatorOneShot('cccc3333', NOW - MIN)] })
  const r3 = await tickSaturnOnce(ports)
  check("D7 the pending self-wake is dropped, the operator's due one-shot fires on the wake arm", r3.dropped === 1 && r3.fired === 1 && delivered.length === 1 && delivered[0]!.parked === true && delivered[0]!.prompt === 'the nightly audit', JSON.stringify({ r3, delivered }))
  check("D8 the operator's spent one-shot left through the stamp; the self-wake through the drop — no field remains", !('schedules' in rawRecord()) && !('heldFires' in rawRecord()), JSON.stringify(rawRecord()))

  seedRecord({ stoppedAt: NOW - 5 * MIN, stoppedBy: 'operator:test', schedules: [selfWake('dddd4444', NOW + 10 * MIN)] })
  const r4 = await tickSaturnOnce(ports)
  const stoppedRow = removeReceipts().slice(-1)[0]
  check("D9 a stopped record's self-wake is dropped with the stopped reason", r4.dropped === 1 && stoppedRow !== undefined && stoppedRow.details.why === 'stopped' && stoppedRow.summary.includes('the session was stopped'), JSON.stringify({ r4, stoppedRow }))

  delivered.length = 0
  seedRecord({ schedules: [selfWake('eeee5555', NOW - MIN)] })
  const r5 = await tickSaturnOnce(ports)
  check('D10 a live record\'s due self-wake fires as before (nothing dropped)', r5.dropped === 0 && r5.fired === 1 && delivered.length === 1 && delivered[0]!.parked === false && delivered[0]!.prompt === 'carry on with the next unit', JSON.stringify({ r5, delivered }))

  delivered.length = 0
  seedRecord({ parkRequestedAt: NOW - MIN, parkRequestedBy: 'operator:test', schedules: [selfWake('ffff6666', NOW + 10 * MIN)] })
  const r6 = await tickSaturnOnce(ports)
  check('D11 a draining (park-requested, not yet parked) record keeps its self-wake until the flip', r6.dropped === 0 && JSON.stringify(scheduleIds()) === JSON.stringify(['ffff6666']), JSON.stringify(r6))
}

console.log('§E the doors drop at the flip; the surfaces paint the glance words')
{
  const read = (p: string): string => readFileSync(join(import.meta.dir, '../..', p), 'utf8')
  const main = read('src/daemon/main.ts')
  const interruptArm = main.slice(main.indexOf("if (action === 'interrupt')"), main.indexOf("if (action === 'stop-agent' || action === 'resume-agent')"))
  check("E1 the interrupt door drops the session's self-wakes once the interrupt is delivered", interruptArm.includes("if (delivered) dropSelfWakesAtFlip(sessionId, by, 'interrupted')") && interruptArm.includes("request: { subtype: 'interrupt'") && interruptArm.indexOf('dropSelfWakesAtFlip') > interruptArm.indexOf("request: { subtype: 'interrupt'"))
  const parkArm = main.slice(main.indexOf("if (action === 'park')"), main.indexOf("if (action === 'set-title')"))
  check('E2 the park door drops on both arms that flip the close state (retire · park) and never on a released newborn', parkArm.includes("if (retired.outcome === 'parked') dropSelfWakesAtFlip(sessionId, by, 'parked')") && parkArm.includes("if (out.outcome === 'applied' && !out.released) dropSelfWakesAtFlip(sessionId, by, 'parked')"))
  const stopArm = main.slice(main.indexOf("if (action === 'stop')"), main.indexOf("if (action === 'attach')"))
  check('E3 the stop door drops once the stop applied', stopArm.includes("if (out.outcome === 'applied') dropSelfWakesAtFlip(sessionId, by, 'stopped')"))
  const parkAllArm = main.slice(main.indexOf("if (action === 'park-all')"), main.indexOf("if (action === 'park')"))
  check('E4 park-all drops for every session it parked now (draining ones flip at their idle edge)', parkAllArm.includes('for (const short of all.parked)') && parkAllArm.includes("dropSelfWakesAtFlip(parkedRec.sessionId, by, 'parked')"))
  const idleEdge = main.slice(main.indexOf('onIdle: short => {'), main.indexOf('onIdle: short => {') + 900)
  check('E5 the idle-edge park completion drops with the park stamp', idleEdge.includes('if (completeRequestedPark(short, roster)) {') && idleEdge.includes("dropSelfWakesAtFlip(parkedRec.sessionId, parkedRec.parkedBy ?? 'daemon', 'parked')"))
  check('E6 the door helper rides the one writer, fail-soft, and names the drop in the daemon log', main.includes('function dropSelfWakesAtFlip(sessionId: string, by: string, why: SaturnSelfWakeDropWhy): void') && main.includes('const gone = dropSaturnSelfWakes(sessionId, by, why)') && main.includes('self-paced wake') )

  const ticker = read('src/daemon/saturnTicker.ts')
  check("E7 the ticker's walk drops a parked record's self-wakes through the pen before the ladder runs, and counts them", ticker.includes('if (parked && scheduleList.some(isSaturnSelfWake))') && ticker.includes("dropSaturnSelfWakes(sessionId, id => `saturn:${id}`, rec.parkedAt !== undefined ? 'parked' : 'stopped', ports.dir)") && ticker.includes('report.dropped += gone.dropped.length') && ticker.indexOf('if (parked && scheduleList.some(isSaturnSelfWake))') < ticker.indexOf('if (heldList.length > 0) {'))

  const rail = read('src/components/HelmLanesRail.tsx')
  check('E8 the rail row paints the glance words and nothing else (name + verb from one home; no local clamp)', rail.includes('saturnWakeGlanceWords(wakeGlance, Date.now())') && rail.includes('name={wakeWords.name}') && rail.includes('verb={wakeWords.verb}') && !rail.includes("'due now'") && !rail.includes("'no next fire'"))
  check('E9 the rail probe reads the records whole (held fires ride them) through saturnWakeGlanceOf', rail.includes('saturnWakeGlanceOf(records)') && rail.includes('readSessionWorkers()).filter(r => r.endedAt === undefined)'))
  const splash = read('src/components/BootSplashScreen.tsx')
  check("E10 the Boot face's Saturn ctx reads the same glance and names held fires", splash.includes('saturn.saturnWakeGlanceOf([...records, box.readBoxSchedules()])') && splash.includes('${glance.held > 0 ? ` · ${glance.held} held` : \'\'}'))
  const screen = read('src/components/BootSaturnScreen.tsx')
  check('E11 the board row, its trail line and its summary compose from saturnStandingOf', (screen.match(/saturnStandingOf\(/g) ?? []).length >= 3 && screen.includes('export { fireDeltaWords };'))
  const saturnSrc = read('src/daemon/saturn.ts')
  check('E12 the rule and the pen live in the one-writer home', saturnSrc.includes('export function isSaturnSelfWake(') && saturnSrc.includes('export function dropSaturnSelfWakes(') && saturnSrc.includes('export function saturnStandingOf('))
}

console.log(`\n${failures === 0 ? 'prove-saturn-self-wake: ALL LAWS HOLD' : `prove-saturn-self-wake: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
