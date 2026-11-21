import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SaturnScheduleV1, ScheduleOpRequestV1, ScheduleOpDepsV1 } from '../../src/daemon/saturn.ts'

const home = mkdtempSync(join(tmpdir(), 'cron-answer-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.TZ = 'Europe/London'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bridge = await import('../../src/services/saturn/sessionScheduleBridge.ts')
const saturn = await import('../../src/daemon/saturn.ts')
const { updateConcourseWorkers, concourseWorkersPath } = await import('../../src/daemon/concourseWorkers.ts')
const { CronCreateTool: tool } = await import('../../src/tools/ScheduleCronTool/CronCreateTool.ts')
const { CronDeleteTool } = await import('../../src/tools/ScheduleCronTool/CronDeleteTool.ts')
const ui = await import('../../src/tools/ScheduleCronTool/UI.tsx')
const { PeerClosed } = await import('../../src/runner/wire/peer.ts')
const SESSION = 'cron-answer-fixture'
const SHORT = 'concourse-cron-answer'
const now = new Date('2026-10-07T14:52:20.000Z').getTime()
const realNow = Date.now
let failures = 0
function check(label: string, ok: boolean, detail = '', hint = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!ok && hint ? ` — change: ${hint}` : ''}`)
}
const context = { abortController: new AbortController() }
const call = async (input: Record<string, unknown>, ctx = context): Promise<Record<string, any>> => (await tool.call(input as never, ctx as never) as { data: Record<string, any> }).data
const validate = (input: Record<string, unknown>) => tool.validateInput!(input as never)
const text = (data: Record<string, any>): string => String(tool.mapToolResultToToolResultBlockParam(data as never, 'cron-proof').content)
const rejection = async (f: () => Promise<unknown>): Promise<string> => { try { await f(); return '' } catch (error) { return error instanceof Error ? error.message : String(error) } }
const rows = (): SaturnScheduleV1[] => JSON.parse(readFileSync(concourseWorkersPath(process.env.MERCURY_DAEMON_DIR), 'utf8')).workers[SHORT].schedules ?? []
function seed(): void {
  bridge._resetScheduleBridgeForTesting()
  bridge.markScheduleSeatObserved()
  updateConcourseWorkers(workers => {
    for (const key of Object.keys(workers)) delete workers[key]
    workers[SHORT] = { schema: 1, runnerId: SHORT, sessionId: SESSION, workspaceId: home, isolation: 'shared', modelKey: 'fixture-model', spawnedAt: now, lastLiveAt: now } as never
  }, process.env.MERCURY_DAEMON_DIR)
}
const register = (bridge as Record<string, any>).registerScheduleEditDoor as undefined | ((send: (edit: ScheduleOpRequestV1, signal: AbortSignal) => Promise<unknown>) => void)
const ready: ScheduleOpDepsV1 = { deriveAccount: () => ({ ok: true, account: { family: 'fixture', source: 'api-key' } }), preflight: () => ({ state: 'ready' }) }
function door(deps = ready): void {
  register?.(async edit => {
    const answer = saturn.applyConcourseScheduleOp(SESSION, edit, `model:${SESSION}`, deps, process.env.MERCURY_DAEMON_DIR)
    const p = answer.preflight
    return { outcome: answer.outcome, detail: answer.detail, schedule_id: answer.scheduleId, next_fire_ms: answer.nextFireMs, time_zone: 'Europe/London', family: answer.family,
      ...(p ? { preflight: { state: p.state, ...('expiresAt' in p ? { expires_at: p.expiresAt, before_fire: p.beforeFire } : {}), ...('retryAt' in p ? { retry_at: p.retryAt } : {}) } } : {}) }
  })
}
try {
  Date.now = () => now
  seed()
  door({ deriveAccount: () => ({ ok: false, reason: 'no-credential:openai — /logins openai connects an account or an API key' }) })
  const refused = await rejection(() => call({ cron: '0 9 * * 1-5', prompt: 'nightly audit' }))
  check('daemon refusal reaches the model instead of submitted success', refused.startsWith('CronCreate: the daemon refused this schedule, so nothing was scheduled.') && refused.includes('schedule refused — no-credential:openai') && refused.endsWith('Nothing was scheduled.'), refused, 'the call and scheduleRefusal in src/tools/ScheduleCronTool/CronCreateTool.ts and createAnswer.ts must throw the daemon refusal text for a refused answer')
  check('refused add writes no schedule', rows().length === 0, `${rows().length} rows written`, 'applyConcourseScheduleOp in src/daemon/saturn.ts must not store a schedule when deriveAccount refuses')
  for (const [label, input, words] of [
    ['no time', { prompt: 'x' }, 'Say when: pass exactly one'],
    ['two times', { cron: '* * * * *', delayMinutes: 10, prompt: 'x' }, 'has cron and delayMinutes'],
    ['three times', { cron: '* * * * *', at: '2026-10-07T18:00', delayMinutes: 10, prompt: 'x' }, 'has cron, at and delayMinutes'],
    ['recurring absolute', { at: '2026-10-07T18:00', recurring: true, prompt: 'x' }, 'recurring: true needs cron'],
    ['blank prompt', { cron: '0 9 * * *', prompt: '  \r\n ' }, 'prompt is empty'],
    ['oversized prompt', { cron: '0 9 * * *', prompt: 'x'.repeat(20_001) }, '20,001 characters'],
    ['title shape', { cron: '* * * * *', prompt: 'x', title: 'x'.repeat(201) }, saturn.SATURN_TITLE_SHAPE],
    ['cron count', { cron: '0 9 * *', prompt: 'x' }, 'has 4 fields'],
    ['cron token', { cron: '0 9 * * MON-FRI', prompt: 'x' }, 'day-of-week field "MON-FRI"'],
    ['cron no date', { cron: '0 9 31 2 *', prompt: 'x' }, 'matches no date in the next 366 days'],
    ['past pinned cron', { cron: '47 15 7 10 *', recurring: false, prompt: 'x' }, 'next match would be 7 Oct 2027'],
    ['at format', { at: '15:47', prompt: 'x' }, 'not a date and time'],
    ['calendar rollover', { at: '2026-02-30T09:00', prompt: 'x' }, 'not a real calendar date'],
    ['spring gap', { at: '2027-03-28T01:30', prompt: 'x' }, 'clocks skip that time'],
    ['past absolute', { at: '2026-10-07T15:47', prompt: 'x' }, '5 minutes in the past'],
    ['horizon', { at: '2028-01-01T09:00', prompt: 'x' }, 'at most 366 days out'],
  ] as const) {
    let result: any
    try { result = await validate(input) } catch (error) { result = { message: String(error) } }
    check(`validation ${label} refuses with a next step`, result.result === false && result.message.includes(words) && result.message.endsWith('Nothing was scheduled.'), result.result === false ? result.message : 'accepted or threw without validation', 'validateInput in src/tools/ScheduleCronTool/CronCreateTool.ts (time wording in createTime.ts) must refuse this input with a message that holds the expected words and ends with Nothing was scheduled.')
  }
  check('delay schema accepts numeric strings and remains strict', tool.inputSchema.safeParse({ delayMinutes: '10', prompt: 'x' }).success && !tool.inputSchema.safeParse({ delayMinutes: 0, prompt: 'x' }).success && !tool.inputSchema.safeParse({ delayMinutes: 525601, prompt: 'x' }).success && !tool.inputSchema.safeParse({ delayMinutes: 'ten', prompt: 'x' }).success && !tool.inputSchema.safeParse({ delayMinutes: 10, prompt: 'x', when: 'later' }).success, '', 'the delayMinutes field of the input schema in src/tools/ScheduleCronTool/CronCreateTool.ts must accept 1 to 525600 as number or numeric string and reject unknown keys')
  const old = { submitted: true, humanSchedule: 'Weekdays at 9:00 AM', recurring: true, title: 'morning brief', note: 'Submitted to the session record' }
  check('saved result and cron input remain readable', tool.outputSchema.safeParse(old).success && ui.renderCreateResultMessage(old) !== null && tool.inputSchema.safeParse({ cron: '0 9 * * 1-5', prompt: 'x', recurring: true, onParked: 'queue', title: 't' }).success && ui.renderCreateToolUseMessage({ cron: '0 9 * * 1-5', prompt: 'x' }) === '0 9 * * 1-5: x', '', 'the output schema and input schema in src/tools/ScheduleCronTool/CronCreateTool.ts and the renderers in UI.tsx must still read the saved result and the cron input')
  check('description says what comes back and the fire facts the answer cannot show, and names no other tool', (await tool.prompt()).includes("returns the schedule's id and its fire time in local time and UTC") && (await tool.prompt()).includes('a schedule outlives interrupts') && (await tool.prompt()).includes('only while the session is idle') && !/\b(?:ScheduleWakeup|CronList|CronDelete)\b/.test(await tool.prompt()) && !(await tool.prompt()).includes('this call answers "submitted"'), '', 'buildCronCreatePrompt in src/tools/ScheduleCronTool/prompt.ts must carry the id and fire-time sentence, the interrupt and idle sentences, and name no other schedule tool')
  check('direct schedule answer door exists', register !== undefined, '', 'src/services/saturn/sessionScheduleBridge.ts must export registerScheduleEditDoor')
  if (register !== undefined) {
    seed(); bridge.latchSessionScheduleRoster([]); door()
    const data = await call({ delayMinutes: 10, prompt: 'deploy check', title: 'deploy check' })
    const row = rows()[0]!
    check('answer returns daemon id and minute-rounded fire time', data.state === 'scheduled' && /^[0-9a-f]{8}$/.test(data.id) && data.id === row.id && row.when.kind === 'at' && data.nextFireMs === row.when.atMs && data.nextFireMs === 1791385380000, JSON.stringify({ data, row }), 'the call in src/tools/ScheduleCronTool/CronCreateTool.ts must return the id and nextFireMs the daemon wrote, rounded to the minute')
    check('model result carries both clocks and cancel id', text(data).includes(`Scheduled ${data.id}`) && text(data).includes('Wed 7 Oct 2026 16:03 BST (2026-10-07T15:03:00.000Z), in 11 minutes') && text(data).includes(`CronDelete with id "${data.id}"`), text(data), 'createResultText in src/tools/ScheduleCronTool/createAnswer.ts must print the id, both clocks and the CronDelete id')
    check('new id is immediately deletable before roster push', (await CronDeleteTool.validateInput!({ id: data.id } as never)).result, '', 'CronDeleteTool validateInput in src/tools/ScheduleCronTool/CronDeleteTool.ts must accept an id the create answer just returned, before the roster is pushed')
    check('one-shot survives interruption rather than becoming a self-wake', row.when.spelling?.startsWith('once at ') === true && !saturn.isSaturnSelfWake(row) && !saturn.dropSaturnSelfWakes(SESSION, 'operator:test', 'interrupted', process.env.MERCURY_DAEMON_DIR).dropped.includes(row.id), JSON.stringify(row.when), 'a one-shot at-schedule must not count as a self-wake in src/daemon/saturn.ts (isSaturnSelfWake, dropSaturnSelfWakes)')
    const recurrence = await call({ cron: '0 9 * * 1-5', prompt: 'morning brief' })
    check('recurring result uses writer fire instant and explicit cron', recurrence.nextFireMs === 1791446400000 && text(recurrence).includes('(cron "0 9 * * 1-5"), read in Europe/London.'), text(recurrence), 'createResultText in src/tools/ScheduleCronTool/createAnswer.ts must print the daemon fire instant and the explicit cron with its zone')
    for (const [at, instant] of [['2026-10-07T17:52', '2026-10-07T16:52:00.000Z'], ['2026-10-25T01:30', '2026-10-25T00:30:00.000Z'], ['2026-10-25T01:30+00:00', '2026-10-25T01:30:00.000Z'], ['2026-10-07T15:52', '2026-10-07T14:52:00.000Z']] as const) {
      const absolute = await call({ at, prompt: 'absolute check' })
      check(`absolute ${at} resolves without moving its instant`, absolute.nextFireUtc === instant, String(absolute.nextFireUtc), 'resolveCreateTime in src/tools/ScheduleCronTool/createTime.ts must resolve this local time to the expected UTC instant')
    }
    door({ ...ready, preflight: () => ({ state: 'expiring', expiresAt: now + 60000, beforeFire: true }) })
    const warning = await call({ delayMinutes: 10, prompt: 'held check' })
    check('write-time account warning reaches model', text(warning).includes('Warning: the fixture sign-in expires') && text(warning).includes('before this fire') && text(warning).includes('held (not dropped)'), text(warning), 'scheduleWarnings in src/tools/ScheduleCronTool/createAnswer.ts must print the preflight expiry warning for an expiring account')
    seed(); register(async () => { throw { code: -32601 } })
    const queued = await call({ delayMinutes: 10, prompt: 'older host' })
    check('unknown method queues exactly once without inventing an id', queued.state === 'queued' && queued.id === undefined && text(queued).startsWith('Queued, not confirmed:') && bridge.takePendingScheduleEdits().length === 1, JSON.stringify(queued), 'the call in src/tools/ScheduleCronTool/CronCreateTool.ts must queue exactly one edit with no id when the door answers method not found')
    seed()
    const noDoor = await call({ delayMinutes: 10, prompt: 'no direct host' })
    check('observed seat without door keeps facts fallback', noDoor.state === 'queued' && text(noDoor).includes('could not be asked directly') && bridge.takePendingScheduleEdits().length === 1, JSON.stringify(noDoor), 'the call in src/tools/ScheduleCronTool/CronCreateTool.ts must queue one edit and say it could not be asked directly when no door is registered')
    for (let i = 0; i < 20; i++) bridge.submitSessionScheduleEdit({ op: 'remove', scheduleId: '12345678' })
    check('full fallback queue refuses without losing an edit', (await rejection(() => call({ delayMinutes: 10, prompt: 'overflow' }))).includes('20 schedule edits are already waiting') && bridge.takePendingScheduleEdits().length === 20, '', 'submitSessionScheduleEdit in src/services/saturn/sessionScheduleBridge.ts and the call in CronCreateTool.ts must refuse the 21st edit and keep the 20 waiting')
    seed(); process.env.MERCURY_SCHEDULE_ANSWER_DEADLINE_MS = '200'
    let cancelled = false
    register(async (_edit, signal) => { signal.addEventListener('abort', () => { cancelled = true }); return await new Promise(() => {}) })
    const start = performance.now()
    const deadline = await rejection(() => call({ delayMinutes: 10, prompt: 'no answer' }))
    check('deadline is NOT confirmed and never resends', deadline.startsWith('CronCreate: NOT confirmed.') && deadline.includes('Call CronList next') && !deadline.includes('Nothing was scheduled.') && bridge.takePendingScheduleEdits().length === 0 && cancelled && performance.now() - start < 1000, deadline, 'the deadline path of the call in src/tools/ScheduleCronTool/CronCreateTool.ts and scheduleUnconfirmed in createAnswer.ts must say NOT confirmed, point to CronList, abort the door call and queue nothing')
    delete process.env.MERCURY_SCHEDULE_ANSWER_DEADLINE_MS
    seed(); register(async () => { throw new PeerClosed('schedule/edit', 'proof') })
    check('closed connection is NOT confirmed and never resends', (await rejection(() => call({ delayMinutes: 10, prompt: 'closed' }))).includes('connection to the daemon closed') && bridge.takePendingScheduleEdits().length === 0, '', 'the PeerClosed branch of the call in src/tools/ScheduleCronTool/CronCreateTool.ts must throw the connection closed text and queue nothing')
    seed(); const controller = new AbortController(); register(async () => await new Promise(() => {}))
    const pending = rejection(() => call({ delayMinutes: 10, prompt: 'interrupt' }, { abortController: controller }))
    controller.abort(new Error('proof interrupted'))
    check('interrupt retains turn reason and never queues', (await pending).includes('proof interrupted') && bridge.takePendingScheduleEdits().length === 0, '', 'the call in src/tools/ScheduleCronTool/CronCreateTool.ts must keep the abort reason of the turn in its error and queue nothing')
    bridge._resetScheduleBridgeForTesting()
    check('seatless refuses instead of queueing', (await rejection(() => call({ delayMinutes: 10, prompt: 'seatless' }))).includes('has no session record on the Mercury daemon'), '', 'the call in src/tools/ScheduleCronTool/CronCreateTool.ts must refuse with the no session record text when no seat was observed')
  }
} finally {
  Date.now = realNow
  bridge._resetScheduleBridgeForTesting()
  rmSync(home, { recursive: true, force: true })
}
console.log(`cron create answer: ${failures} failures`)
process.exitCode = failures ? 1 : 0
