#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'saturn-origin-home-'))
const DAEMON_DIR = mkdtempSync(join(tmpdir(), 'saturn-origin-daemon-'))
process.env.MERCURY_DAEMON_DIR = DAEMON_DIR
mkdirSync(DAEMON_DIR, { recursive: true })
delete process.env.MERCURY_HOME
delete process.env.MERCURY_SATURN_DISABLE
delete process.env.MERCURY_WAKE_REASON
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
delete process.env.CI
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { applyConcourseScheduleOp } = await import('../../src/daemon/saturn.ts')
const { updateConcourseWorkers, concourseWorkersPath } = await import('../../src/daemon/concourseSupervisor.ts')
const ticker = await import('../../src/daemon/saturnTicker.ts')
const { liveFactsForSessionFire } = await import('../../src/daemon/saturnAccount.ts')
const { readSessionFacts, sessionFactsDir, sessionFactsPath } = await import('../../src/services/engine-connector/seatProjections.ts')
const receipts = await import('../../src/services/switchboard/sessionReceipts.ts')
const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
const { buildConcoursePromptFrame } = await import('../../src/daemon/concourseDispatch.ts')
const { SDKUserMessageSchema } = await import('../../src/entrypoints/sdk/coreSchemas.ts')
const { processTextPrompt } = await import('../../src/utils/processUserInput/processTextPrompt.ts')
const { createUserMessage } = await import('../../src/utils/messages/factories.ts')
const bridge = await import('../../src/services/saturn/sessionScheduleBridge.ts')
const { ScheduleWakeupTool } = await import('../../src/tools/ScheduleWakeupTool/ScheduleWakeupTool.ts')
const rows = await import('../../src/utils/messages/noticeRows.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const j = (v: unknown): string => JSON.stringify(v)
type Raw = Record<string, unknown>

const SESSION = 'sess-origin-1'
const OWNER = 'operator@example.com'
const T0 = Date.now()
const FIRED_AT = new Date(T0).toISOString()
const REASON = 'the row-2 build is running; RUN-OK follows it'
const WAKE_PROMPT = 'carry on with the next unit'
const CRON_PROMPT = 'read the overnight landings'
const FIXTURE_ACCOUNT = { family: 'anthropic', source: 'oauth' as const, scopeDir: join(DAEMON_DIR, 'scope'), identity: OWNER, knownExpiresAt: T0 + 86_400_000, refreshable: true }
const okDeps = { deriveAccount: (_modelKey: string) => ({ ok: true as const, account: { ...FIXTURE_ACCOUNT } }) }

function seedRecord(): void {
  updateConcourseWorkers(workers => {
    for (const key of Object.keys(workers)) delete workers[key]
    workers['concourse-w1'] = {
      schema: 1,
      runnerId: 'concourse-w1',
      sessionId: SESSION,
      workspaceId: '/scratch/repo',
      isolation: 'shared',
      modelKey: 'claude-opus-5',
      effort: 'high',
      spawnedAt: T0,
      lastLiveAt: T0,
    } as never
  }, DAEMON_DIR)
}
const rawRecord = (): Raw => (JSON.parse(readFileSync(concourseWorkersPath(DAEMON_DIR), 'utf8')) as { workers: Record<string, Raw> }).workers['concourse-w1']!
const heldRows = (): Raw[] => (rawRecord().heldFires ?? []) as Raw[]
const park = (on: boolean): void => {
  updateConcourseWorkers(workers => {
    const r = workers['concourse-w1'] as { parkedAt?: number } | undefined
    if (!r) return
    if (on) r.parkedAt = T0
    else delete r.parkedAt
  }, DAEMON_DIR)
}
const addVia = (schedule: unknown): string => {
  const r = applyConcourseScheduleOp(SESSION, { op: 'add', schedule }, 'operator:test', okDeps, DAEMON_DIR)
  if (r.outcome !== 'applied') check('seed add failed', false, r.detail ?? '')
  return r.scheduleId!
}
const zeros = { totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false }
const publishFacts = (window: Raw | undefined): void => {
  mkdirSync(sessionFactsDir(DAEMON_DIR), { recursive: true })
  writeFileSync(sessionFactsPath(SESSION, DAEMON_DIR), `${JSON.stringify({ schema: 1, sessionId: SESSION, model: { effective: 'claude-opus-5', setting: null }, usage: { ...zeros, ...(window !== undefined ? { anthropicWindow: window } : {}) }, queue: [] })}\n`)
}
const openWindow = (): Raw => ({ status: 'allowed', observedAtMs: T0, owner: OWNER })
const closedWindow = (): Raw => ({ status: 'rejected', observedAtMs: T0, owner: OWNER, resetsAtMs: T0 + 120_000, claim: 'five_hour' })
const delivered: Raw[] = []
const ports = {
  now: () => T0,
  records: () => Object.values(JSON.parse(readFileSync(concourseWorkersPath(DAEMON_DIR), 'utf8')).workers as Record<string, { endedAt?: number }>).filter(r => r.endedAt === undefined) as never[],
  deriveAccount: (_m: string) => ({ ok: true as const, account: { ...FIXTURE_ACCOUNT } }),
  liveFacts: (account: { family: string; source: 'oauth' | 'api-key' | 'keyless' }, sessionId?: string) =>
    liveFactsForSessionFire(account, sessionId, {
      presenceOf: () => ({ credentialed: true, kind: 'oauth' as const }),
      strandedNow: () => false,
      anthropicDetail: () => null,
      factsOf: id => readSessionFacts(id, DAEMON_DIR),
    }),
  deliver: async (d: Raw) => {
    delivered.push({ ...d })
    return { ok: true }
  },
  birth: async () => ({ ok: false, detail: 'no births in this proof' }),
  screenOpen: () => true,
  dir: DAEMON_DIR,
} as never
const fireReceipts = (): Array<{ summary: string; details: Raw }> =>
  receipts.readSessionReceipts(getProjectDir('/scratch/repo'), SESSION).filter(r => r.kind === 'schedule-fire').map(r => ({ summary: r.summary, details: (r.details ?? {}) as Raw }))
const originOf = (d: Raw | undefined): Raw | undefined => d?.origin as Raw | undefined
const wakeSchedule = (prompt: string, note?: string): unknown => ({
  when: { kind: 'at', atMs: T0 - 1000, spelling: rows.wakeDelaySpelling(900) },
  action: { kind: 'fire', prompt, onParked: 'queue' },
  ...(note !== undefined ? { note } : {}),
})
const CRON_SPELLING = 'Every minute'
const cronSchedule = (prompt: string): unknown => ({ when: { kind: 'every', cron: '* * * * *', spelling: CRON_SPELLING }, action: { kind: 'fire', prompt } })

console.log('§1 THE CARRIER (red on the base: the delivery has no origin): a due fire delivers the schedule\'s own facts beside the prompt')
{
  seedRecord()
  publishFacts(openWindow())
  const wakeId = addVia(wakeSchedule(WAKE_PROMPT, REASON))
  const cronId = addVia(cronSchedule(CRON_PROMPT))
  updateConcourseWorkers(workers => {
    for (const rec of Object.values(workers)) {
      for (const row of ((rec as { schedules?: Raw[] }).schedules ?? [])) row.createdAt = T0 - 120_000
    }
  }, DAEMON_DIR)
  const r = await ticker.tickSaturnOnce(ports)
  check('both fires deliver', r.fired === 2 && delivered.length === 2, j({ r, delivered }))
  const wake = originOf(delivered.find(d => d.prompt === WAKE_PROMPT))
  check("a self-paced wake's delivery carries a saturn origin: the wake kind, the fire time, the schedule's id, its spelling and its reason", j(wake) === j({ kind: 'saturn', fire: 'wake', firedAt: FIRED_AT, scheduleId: wakeId, spelling: 'in ~900s', reason: REASON }), j(wake))
  const cron = originOf(delivered.find(d => d.prompt === CRON_PROMPT))
  check("a cron schedule's delivery carries the cron kind, the fire time, its id and its own spelling, no reason", j(cron) === j({ kind: 'saturn', fire: 'cron', firedAt: FIRED_AT, scheduleId: cronId, spelling: CRON_SPELLING }), j(cron))
  check('the prompt beside the origin is the schedule\'s own words, byte for byte', delivered.every(d => d.prompt === WAKE_PROMPT || d.prompt === CRON_PROMPT))
  const wakeReceipt = fireReceipts().find(x => x.details.scheduleId === wakeId)
  check("the fired wake's receipt names the fire time and the reason (red on the base: neither is on it)", wakeReceipt !== undefined && wakeReceipt.details.firedAt === T0 && wakeReceipt.details.note === REASON && wakeReceipt.summary === `fired (in ~900s) · reason: ${REASON}`, j(wakeReceipt))
  const cronReceipt = fireReceipts().find(x => x.details.scheduleId === cronId)
  check('a fire without a reason names the fire time and no reason clause', cronReceipt !== undefined && cronReceipt.details.firedAt === T0 && !('note' in cronReceipt.details) && cronReceipt.summary.startsWith('fired') && cronReceipt.summary.includes(`(${CRON_SPELLING})`) && !cronReceipt.summary.includes('reason'), j(cronReceipt))
}

console.log('§2 a wake held for a parked session replays once with the hold named in its origin')
{
  delivered.length = 0
  updateConcourseWorkers(workers => {
    for (const r of Object.values(workers)) {
      delete (r as { schedules?: unknown }).schedules
      delete (r as { heldFires?: unknown }).heldFires
    }
  }, DAEMON_DIR)
  seedRecord()
  park(true)
  publishFacts(openWindow())
  const id = addVia(wakeSchedule('the parked next unit', REASON))
  const r1 = await ticker.tickSaturnOnce(ports)
  check('parked: the wake is held for the session\'s own resume, nothing delivered', r1.held === 1 && delivered.length === 0 && heldRows()[0]?.reason === 'parked-queued', j({ r1, held: heldRows() }))
  const r2 = await ticker.tickSaturnOnce(ports)
  check('a later tick while parked queues nothing twice', r2.held === 0 && r2.replayed === 0 && delivered.length === 0 && heldRows().length === 1, j(r2))
  park(false)
  const r3 = await ticker.tickSaturnOnce(ports)
  check('the resume replays the wake exactly once', r3.replayed === 1 && delivered.length === 1 && heldRows().length === 0, j({ r3, delivered }))
  const o = originOf(delivered[0])
  check('its origin says since when it waited and why', o !== undefined && o.kind === 'saturn' && o.fire === 'wake' && o.scheduleId === id && o.reason === REASON && o.heldSince === FIRED_AT && o.heldWhy === 'parked', j(o))
  const r4 = await ticker.tickSaturnOnce(ports)
  check('nothing fires twice', r4.fired + r4.replayed + r4.held === 0 && delivered.length === 1, j(r4))
  const late = fireReceipts().at(-1)
  check('the late receipt names the fire time and the reason too', late !== undefined && late.details.outcome === 'fired-late' && late.details.firedAt === T0 && late.details.note === REASON && late.summary.endsWith(` · reason: ${REASON}`), j(late))
}

console.log('§3 a wake held by a closed usage window replays at the reopen with the window named')
{
  delivered.length = 0
  updateConcourseWorkers(workers => {
    for (const r of Object.values(workers)) {
      delete (r as { schedules?: unknown }).schedules
      delete (r as { heldFires?: unknown }).heldFires
    }
  }, DAEMON_DIR)
  seedRecord()
  publishFacts(closedWindow())
  addVia(wakeSchedule('the walled next unit'))
  const r1 = await ticker.tickSaturnOnce(ports)
  check('the due wake is held rate-limited', r1.held === 1 && delivered.length === 0 && heldRows()[0]?.reason === 'rate-limited', j({ r1, held: heldRows() }))
  publishFacts(openWindow())
  const r2 = await ticker.tickSaturnOnce(ports)
  const o = originOf(delivered[0])
  check('at the reopen it replays once and its origin names the closed window', r2.replayed === 1 && delivered.length === 1 && o !== undefined && o.heldSince === FIRED_AT && o.heldWhy === 'window' && o.fire === 'wake' && !('reason' in o), j({ r2, o }))
}

console.log('§4 the frame and the turn road carry the origin whole; the words never change')
{
  const origin = { kind: 'saturn', fire: 'wake', firedAt: FIRED_AT, scheduleId: 'ab12cd34', spelling: 'in ~900s', reason: REASON }
  const plain = JSON.parse(buildConcoursePromptFrame(WAKE_PROMPT, { priority: 'later', identity: 'saturn-s-ab12cd34-1' })) as Raw
  check('a frame without an origin is the shape it was', !('origin' in plain) && plain.priority === 'later' && (plain.message as Raw).content === WAKE_PROMPT, j(plain))
  const framed = JSON.parse(buildConcoursePromptFrame(WAKE_PROMPT, { priority: 'later', identity: 'saturn-s-ab12cd34-1', origin: origin as never })) as Raw
  check('a frame with an origin carries it beside the words, the words untouched', j(framed.origin) === j(origin) && (framed.message as Raw).content === WAKE_PROMPT && framed.priority === 'later', j(framed))
  const parsed = SDKUserMessageSchema().safeParse(framed)
  check('the public user-frame schema keeps the origin (red on the base: an undeclared key is stripped)', parsed.success && j((parsed.data as Raw).origin) === j(origin), parsed.success ? j(parsed.data) : j(parsed.error.issues))
  const text = `[self-paced wake — why you woke: ${REASON}]\n\n${WAKE_PROMPT}`
  const out = processTextPrompt(text, [], [], [], undefined, undefined, true, undefined, origin as never)
  const message = out.messages[0] as Raw
  check('the turn road stores the origin on the user message and leaves the model-facing text byte-identical', j(message.origin) === j(origin) && (message.message as Raw).content === text && message.isMeta === true, j(message))
  const bare = processTextPrompt(WAKE_PROMPT, [], [], []).messages[0] as Raw
  const factoryShape = createUserMessage({ content: WAKE_PROMPT }) as unknown as Raw
  check("a prompt with no origin stores none: the operator's line keeps the factory's own key set, origin undefined and absent from its JSON", bare.origin === undefined && j(Object.keys(bare).sort()) === j(Object.keys(factoryShape).sort()) && !JSON.stringify(bare).includes('"origin"') && (bare.message as Raw).content === WAKE_PROMPT, j(Object.keys(bare).sort()))
}

console.log('§5 the tool mints the spelling the row reads back')
{
  bridge._resetScheduleBridgeForTesting()
  bridge.markScheduleSeatObserved()
  await ScheduleWakeupTool.call({ delaySeconds: 900, prompt: WAKE_PROMPT, reason: REASON } as never, {} as never)
  const edit = bridge.takePendingScheduleEdits()[0] as { schedule?: { when?: { spelling?: string }; note?: string; action?: { prompt?: string } } } | undefined
  check("the wake's spelling is the one the row parses into a cadence", edit?.schedule?.when?.spelling === 'in ~900s' && rows.wakeDelayOfSpelling(edit?.schedule?.when?.spelling) === 900, j(edit))
  check('the reason rides the schedule as its note; the fired prompt carries it as the continuity header', edit?.schedule?.note === REASON && edit?.schedule?.action?.prompt === `[self-paced wake — why you woke: ${REASON}]\n\n${WAKE_PROMPT}`, j(edit))
  bridge._resetScheduleBridgeForTesting()
}

console.log('§6 the seatless sink: a wake that fires into a closed usage window waits with the wall\'s own delay and says so once, in the row it finally lands as (red on the base: no step planner exists)')
try {
  const { localWakeStep } = await import('../../src/tools/ScheduleWakeupTool/localWake.ts')
  const { WALL_RECHECK_MS, REOPEN_GRACE_MS } = await import('../../src/tools/MonitorTool/watchMailbox.ts')
  const facts = { spelling: 'in ~900s', reason: REASON }
  const first = localWakeStep({ closed: true, reopensAtMs: T0 + 30_000 }, T0, FIRED_AT, undefined, facts)
  check("a closed window with a known reopen waits until the reopen plus the grace, the wall's own delay", first.step === 'wait' && first.delayMs === 30_000 + REOPEN_GRACE_MS && first.heldSince === FIRED_AT, j(first))
  const unknown = localWakeStep({ closed: true }, T0, FIRED_AT, undefined, facts)
  check('a closed window with no reopen waits one recheck', unknown.step === 'wait' && unknown.delayMs === WALL_RECHECK_MS, j(unknown))
  const far = localWakeStep({ closed: true, reopensAtMs: T0 + 5 * 60_000 }, T0, FIRED_AT, undefined, facts)
  check("a window five minutes out re-arms once, for the five minutes and the grace — never the beat five times over (red on the base: the beat)", far.step === 'wait' && far.delayMs === 5 * 60_000 + REOPEN_GRACE_MS, j(far))
  const stale = localWakeStep({ closed: true, reopensAtMs: T0 - 1 }, T0, FIRED_AT, undefined, facts)
  check('a window whose named reopen has already passed rechecks at the beat, never in a one-second loop (red on the base: one second)', stale.step === 'wait' && stale.delayMs === WALL_RECHECK_MS, j(stale))
  const again = localWakeStep({ closed: true }, T0 + WALL_RECHECK_MS, FIRED_AT, FIRED_AT, facts)
  check('a window still closed at the recheck waits again and keeps the first held-since', again.step === 'wait' && again.heldSince === FIRED_AT, j(again))
  const landed = localWakeStep({ closed: false }, T0 + 2 * WALL_RECHECK_MS, FIRED_AT, FIRED_AT, facts)
  check('the reopen delivers once, the origin naming the fire, its facts and the one wait', landed.step === 'deliver' && j(landed.origin) === j({ kind: 'saturn', fire: 'wake', firedAt: FIRED_AT, spelling: 'in ~900s', reason: REASON, heldSince: FIRED_AT, heldWhy: 'window' }), j(landed))
  const open = localWakeStep({ closed: false }, T0, FIRED_AT, undefined, undefined)
  check('an open window delivers at once with no wait named and no facts invented', open.step === 'deliver' && j(open.origin) === j({ kind: 'saturn', fire: 'wake', firedAt: FIRED_AT }), j(open))
  const line = rows.saturnFirstLine((landed as { origin: never }).origin, new Date(T0 + 2 * WALL_RECHECK_MS).toISOString())
  check('and the row says it in one line', line.startsWith('self-paced wake · fifteen-minute cadence · reason: ') && line.endsWith('· the usage window was closed') && line.includes('held since '), line)
} catch (error) {
  check('the local wake step planner stands', false, String(error))
}

console.log("§7 the seatless arm hands the wake's facts to the sink (red on the base: the sink receives the prompt alone)")
{
  bridge._resetScheduleBridgeForTesting()
  const seen: Array<{ prompt: string; facts: unknown }> = []
  bridge.registerLocalWakeSink((prompt: string, facts?: unknown) => {
    seen.push({ prompt, facts })
  })
  const armed = bridge.armLocalWake(1, 'wake up and continue', { spelling: 'in ~60s', reason: REASON })
  check('the arm is taken', armed.ok === true, j(armed))
  await new Promise(resolve => setTimeout(resolve, 1_300))
  check('the sink receives the prompt and the facts the tool armed it with', seen.length === 1 && seen[0]!.prompt === 'wake up and continue' && j(seen[0]!.facts) === j({ spelling: 'in ~60s', reason: REASON }), j(seen))
  bridge._resetScheduleBridgeForTesting()
}

console.log("§8 one fire instant: the row's fire time is the tick's own stamp — the instant the record and the receipt name — never the delivery's clock (red on the base: the origin reads the clock at the delivery)")
{
  delivered.length = 0
  updateConcourseWorkers(workers => {
    for (const r of Object.values(workers)) {
      delete (r as { schedules?: unknown }).schedules
      delete (r as { heldFires?: unknown }).heldFires
    }
  }, DAEMON_DIR)
  seedRecord()
  publishFacts(openWindow())
  addVia(cronSchedule('the first delivery, slow'))
  addVia(cronSchedule('the cron fire after it'))
  updateConcourseWorkers(workers => {
    for (const rec of Object.values(workers)) {
      for (const row of ((rec as { schedules?: Raw[] }).schedules ?? [])) row.createdAt = Date.now() - 120_000
    }
  }, DAEMON_DIR)
  const ticking = {
    ...(ports as Record<string, unknown>),
    now: () => Date.now(),
    deliver: async (d: Raw) => {
      delivered.push({ ...d })
      if (delivered.length === 1) await new Promise(resolve => setTimeout(resolve, 1_200))
      return { ok: true }
    },
  } as never
  const before = Date.now()
  const r = await ticker.tickSaturnOnce(ticking)
  check('two cron fires deliver in one tick, the first delivery taking a beat', r.fired === 2 && delivered.length === 2, j({ r, delivered }))
  const second = originOf(delivered[1])
  const secondId = second?.scheduleId
  const receipt = fireReceipts().find(x => x.details.scheduleId === secondId)
  const stamped = ((rawRecord().schedules ?? []) as Raw[]).find(s => s.id === secondId)?.lastFiredAt
  check("the second fire's row names the fire time its receipt names, not the clock after the first delivery's wait", second !== undefined && receipt !== undefined && Date.parse(String(second.firedAt)) === receipt.details.firedAt, j({ origin: second, receipt: receipt?.details }))
  check("the record's own stamp is that same instant", receipt !== undefined && stamped === receipt.details.firedAt, j({ stamped, receipt: receipt?.details }))
  check("the instant is the tick's start, before any delivery waited", receipt !== undefined && typeof receipt.details.firedAt === 'number' && receipt.details.firedAt >= before && receipt.details.firedAt < before + 1_200, j({ before, receipt: receipt?.details }))
}

console.log(`\n${failures === 0 ? '✅' : '❌'} saturn origin carry: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
