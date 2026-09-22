#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'saturn-window-home-'))
const DAEMON_DIR = mkdtempSync(join(tmpdir(), 'saturn-window-daemon-'))
process.env.MERCURY_DAEMON_DIR = DAEMON_DIR
mkdirSync(DAEMON_DIR, { recursive: true })
delete process.env.MERCURY_HOME
delete process.env.MERCURY_SATURN_DISABLE
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
delete process.env.CI
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { applyConcourseScheduleOp } = await import('../../src/daemon/saturn.ts')
const { updateConcourseWorkers, concourseWorkersPath } = await import('../../src/daemon/concourseSupervisor.ts')
const { tickSaturnOnce } = await import('../../src/daemon/saturnTicker.ts')
const { liveFactsForSessionFire, sessionWindowClosedUntil } = await import('../../src/daemon/saturnAccount.ts')
const { anthropicWindowClosedUntil } = await import('../../src/services/claudeAiLimits.ts')
const { readSessionFacts, sessionFactsDir, sessionFactsPath } = await import('../../src/services/engine-connector/seatProjections.ts')
const receipts = await import('../../src/services/switchboard/sessionReceipts.ts')
const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
const bridge = await import('../../src/services/saturn/sessionScheduleBridge.ts')
const { ScheduleWakeupTool } = await import('../../src/tools/ScheduleWakeupTool/ScheduleWakeupTool.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const SESSION = 'sess-window-1'
const OWNER = 'operator@example.com'
const FIXTURE_ACCOUNT = { family: 'anthropic', source: 'oauth' as const, scopeDir: join(DAEMON_DIR, 'scope'), identity: OWNER, knownExpiresAt: Date.now() + 86_400_000, refreshable: true }
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
      spawnedAt: Date.now(),
      lastLiveAt: Date.now(),
    } as never
  }, DAEMON_DIR)
}
function rawRecord(): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(concourseWorkersPath(DAEMON_DIR), 'utf8')) as { workers: Record<string, Record<string, unknown>> }
  return raw.workers['concourse-w1']!
}
const heldRows = (): Array<Record<string, unknown>> => (rawRecord().heldFires ?? []) as Array<Record<string, unknown>>
const park = (on: boolean): void => {
  updateConcourseWorkers(workers => {
    const r = workers['concourse-w1'] as { parkedAt?: number } | undefined
    if (!r) return
    if (on) r.parkedAt = Date.now()
    else delete r.parkedAt
  }, DAEMON_DIR)
}
const clearSchedules = (): void => {
  updateConcourseWorkers(workers => {
    for (const r of Object.values(workers)) {
      delete (r as { schedules?: unknown }).schedules
      delete (r as { heldFires?: unknown }).heldFires
    }
  }, DAEMON_DIR)
}
const addVia = (schedule: unknown): string => {
  const r = applyConcourseScheduleOp(SESSION, { op: 'add', schedule }, 'operator:test', okDeps, DAEMON_DIR)
  if (r.outcome !== 'applied') check('seed add failed', false, r.detail ?? '')
  return r.scheduleId!
}
const zeros = { totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false }
const publishFacts = (window: Record<string, unknown> | undefined): void => {
  mkdirSync(sessionFactsDir(DAEMON_DIR), { recursive: true })
  writeFileSync(sessionFactsPath(SESSION, DAEMON_DIR), `${JSON.stringify({ schema: 1, sessionId: SESSION, model: { effective: 'claude-opus-5', setting: null }, usage: { ...zeros, ...(window !== undefined ? { anthropicWindow: window } : {}) }, queue: [] })}\n`)
}
const rejectedFor = (ms: number): Record<string, unknown> => ({ status: 'rejected', observedAtMs: Date.now(), owner: OWNER, resetsAtMs: Date.now() + ms, claim: 'five_hour' })
type Delivered = { clientMessageId: string; prompt: string; parked: boolean; sessionId: string }
const delivered: Delivered[] = []
const ports = {
  now: () => Date.now(),
  records: () => Object.values(JSON.parse(readFileSync(concourseWorkersPath(DAEMON_DIR), 'utf8')).workers as Record<string, { endedAt?: number }>).filter(r => r.endedAt === undefined) as never[],
  deriveAccount: (_m: string) => ({ ok: true as const, account: { ...FIXTURE_ACCOUNT } }),
  liveFacts: (account: { family: string; source: 'oauth' | 'api-key' | 'keyless' }, sessionId?: string) =>
    liveFactsForSessionFire(account, sessionId, {
      presenceOf: () => ({ credentialed: true, kind: 'oauth' as const }),
      strandedNow: () => false,
      anthropicDetail: () => null,
      factsOf: id => readSessionFacts(id, DAEMON_DIR),
    }),
  deliver: async (d: Delivered) => {
    delivered.push(d)
    return { ok: true }
  },
  birth: async () => ({ ok: false, detail: 'no births in this proof' }),
  screenOpen: () => true,
  dir: DAEMON_DIR,
} as never
const lastHeldReceipt = (): { summary: string; details: Record<string, unknown> } | undefined => {
  const rows = receipts.readSessionReceipts(getProjectDir('/scratch/repo'), SESSION).filter(r => r.kind === 'schedule-held')
  const last = rows[rows.length - 1]
  return last === undefined ? undefined : { summary: last.summary, details: (last.details ?? {}) as Record<string, unknown> }
}
const selfWake = (prompt: string): unknown => ({ when: { kind: 'at', atMs: Date.now() - 1000 }, action: { kind: 'fire', prompt, onParked: 'queue' } })

console.log('§W the window fact read')
{
  const NOW = 1_000_000_000_000
  check('a rejected window with a stated reset reads closed until the reset', anthropicWindowClosedUntil({ status: 'rejected', observedAtMs: NOW - 1000, owner: OWNER, resetsAtMs: NOW + 60_000 }, NOW) === NOW + 60_000)
  const noReset = anthropicWindowClosedUntil({ status: 'rejected', observedAtMs: NOW, owner: OWNER }, NOW)
  check('a rejected window with no stated reset reads closed for the default window from its observation', noReset !== undefined && noReset > NOW && noReset <= NOW + 3 * 3_600_000, String(noReset))
  check('a rejected window whose reset has passed reads open', anthropicWindowClosedUntil({ status: 'rejected', observedAtMs: NOW - 7_200_000, owner: OWNER, resetsAtMs: NOW - 1 }, NOW) === undefined)
  check('an allowed window reads open', anthropicWindowClosedUntil({ status: 'allowed', observedAtMs: NOW, owner: OWNER }, NOW) === undefined)
  check('a warning window reads open (the fire may still run)', anthropicWindowClosedUntil({ status: 'allowed_warning', observedAtMs: NOW, owner: OWNER, resetsAtMs: NOW + 60_000 }, NOW) === undefined)
  check('no fact reads open', anthropicWindowClosedUntil(undefined, NOW) === undefined)
  check("the session's facts carry the fact to the family's window", sessionWindowClosedUntil('anthropic', { usage: { anthropicWindow: { status: 'rejected', observedAtMs: NOW, owner: OWNER, resetsAtMs: NOW + 5_000 } } }, NOW) === NOW + 5_000)
  check('another family reads nothing from the anthropic fact', sessionWindowClosedUntil('openai', { usage: { anthropicWindow: { status: 'rejected', observedAtMs: NOW, owner: OWNER, resetsAtMs: NOW + 5_000 } } }, NOW) === undefined)
  check('absent facts read open', sessionWindowClosedUntil('anthropic', null, NOW) === undefined)
  const facts = liveFactsForSessionFire({ family: 'anthropic', source: 'oauth' }, 'sess-x', { presenceOf: () => ({ credentialed: true, kind: 'oauth' as const }), strandedNow: () => false, anthropicDetail: () => null, factsOf: () => ({ usage: { anthropicWindow: { status: 'rejected', observedAtMs: NOW, owner: OWNER, resetsAtMs: NOW + 9_000 } } }) as never, now: () => NOW })
  check('the fire-time facts of a session carry its window as the limit signal', facts.credentialed && facts.rateLimitedUntil === NOW + 9_000, JSON.stringify(facts))
  const noSession = liveFactsForSessionFire({ family: 'anthropic', source: 'oauth' }, undefined, { presenceOf: () => ({ credentialed: true, kind: 'oauth' as const }), strandedNow: () => false, anthropicDetail: () => null, factsOf: () => ({ usage: { anthropicWindow: { status: 'rejected', observedAtMs: NOW, owner: OWNER, resetsAtMs: NOW + 9_000 } } }) as never, now: () => NOW })
  check('a fire with no session (the box tier) carries no window signal', noSession.rateLimitedUntil === undefined)
  const openaiFact = { source: 'chatgpt-subscription', resetsAtMs: NOW + 5_000, observedAtMs: NOW - 1_000 }
  check("the openai family reads its own window from the session's facts", sessionWindowClosedUntil('openai', { usage: { openaiWindow: openaiFact } } as never, NOW) === NOW + 5_000)
  check('an openai window whose reset has passed reads open', sessionWindowClosedUntil('openai', { usage: { openaiWindow: { ...openaiFact, resetsAtMs: NOW - 1 } } } as never, NOW) === undefined)
  check('the anthropic family reads nothing from the openai fact', sessionWindowClosedUntil('anthropic', { usage: { openaiWindow: openaiFact } } as never, NOW) === undefined)
  check('the openai family reads nothing from the anthropic fact', sessionWindowClosedUntil('openai', { usage: { anthropicWindow: { status: 'rejected', observedAtMs: NOW, owner: OWNER, resetsAtMs: NOW + 5_000 } } }, NOW) === undefined)
  const openaiFacts = liveFactsForSessionFire({ family: 'openai', source: 'oauth' }, 'sess-x', { presenceOf: () => ({ credentialed: true, kind: 'oauth' as const }), factsOf: () => ({ usage: { openaiWindow: openaiFact } }) as never, now: () => NOW })
  check("an openai session's fire-time facts carry its window as the limit signal", openaiFacts.credentialed && openaiFacts.rateLimitedUntil === NOW + 5_000, JSON.stringify(openaiFacts))
  const wire = await import('../../src/services/engine-connector/seatWire.ts')
  const onWire = wire.sessionFactsToWire({ model: { effective: 'gpt-fixture', setting: null }, usage: { ...zeros, openaiWindow: openaiFact }, identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null }, skills: [], mcp: [], permissionMode: 'default', workspace: {}, queue: [] } as never) as { usage?: Record<string, unknown> }
  const wired = onWire.usage?.openai_window as Record<string, unknown> | undefined
  check("the fact rides the seat's wire as openai_window with its stamps renamed", wired !== undefined && wired.source === 'chatgpt-subscription' && wired.resets_at_ms === NOW + 5_000 && wired.observed_at_ms === NOW - 1_000, JSON.stringify(onWire.usage))
  const back = wire.sessionFactsFromWire(onWire as never) as { usage?: { openaiWindow?: { resetsAtMs?: number; observedAtMs?: number; source?: string } } }
  check('and reads back whole', back.usage?.openaiWindow?.resetsAtMs === NOW + 5_000 && back.usage?.openaiWindow?.observedAtMs === NOW - 1_000 && back.usage?.openaiWindow?.source === 'chatgpt-subscription', JSON.stringify(back.usage?.openaiWindow))
  for (const family of ['gemini', 'openrouter', 'huggingface'] as const) {
    const key = `${family}Window`
    const wireKey = `${family}_window`
    const laneFact = { resetsAtMs: NOW + 5_000, observedAtMs: NOW - 1_000 }
    check(`the ${family} family reads its own window from the session's facts`, sessionWindowClosedUntil(family, { usage: { [key]: laneFact } } as never, NOW) === NOW + 5_000)
    check(`a ${family} window whose reset has passed reads open`, sessionWindowClosedUntil(family, { usage: { [key]: { ...laneFact, resetsAtMs: NOW - 1 } } } as never, NOW) === undefined)
    check(`the ${family} family reads nothing from the anthropic or openai facts`, sessionWindowClosedUntil(family, { usage: { anthropicWindow: { status: 'rejected', observedAtMs: NOW, owner: OWNER, resetsAtMs: NOW + 5_000 }, openaiWindow: openaiFact } } as never, NOW) === undefined)
    check(`the anthropic and openai families read nothing from the ${family} fact`, sessionWindowClosedUntil('anthropic', { usage: { [key]: laneFact } } as never, NOW) === undefined && sessionWindowClosedUntil('openai', { usage: { [key]: laneFact } } as never, NOW) === undefined)
    const laneFacts = liveFactsForSessionFire({ family, source: 'api-key' }, 'sess-x', { presenceOf: () => ({ credentialed: true, kind: 'api-key' as const }), factsOf: () => ({ usage: { [key]: laneFact } }) as never, now: () => NOW })
    check(`the ${family} session's fire-time facts carry its window as the limit signal`, laneFacts.credentialed && laneFacts.rateLimitedUntil === NOW + 5_000, JSON.stringify(laneFacts))
    const laneOnWire = wire.sessionFactsToWire({ model: { effective: `${family}-fixture`, setting: null }, usage: { ...zeros, [key]: laneFact }, identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null }, skills: [], mcp: [], permissionMode: 'default', workspace: {}, queue: [] } as never) as { usage?: Record<string, unknown> }
    const laneWired = laneOnWire.usage?.[wireKey] as Record<string, unknown> | undefined
    check(`the fact rides the seat's wire as ${wireKey} with its stamps renamed`, laneWired !== undefined && laneWired.resets_at_ms === NOW + 5_000 && laneWired.observed_at_ms === NOW - 1_000, JSON.stringify(laneOnWire.usage))
    const laneBack = wire.sessionFactsFromWire(laneOnWire as never) as { usage?: Record<string, { resetsAtMs?: number; observedAtMs?: number } | undefined> }
    check(`and the ${family} fact reads back whole`, laneBack.usage?.[key]?.resetsAtMs === NOW + 5_000 && laneBack.usage?.[key]?.observedAtMs === NOW - 1_000, JSON.stringify(laneBack.usage?.[key]))
  }
}

console.log('§H a due self-wake inside a closed window holds and replays once at the reopen')
{
  seedRecord()
  publishFacts(rejectedFor(120_000))
  const id = addVia(selfWake('carry on with the next unit'))
  const r1 = await tickSaturnOnce(ports)
  const held = heldRows()
  check('the due fire is held rate-limited, nothing delivered', r1.held === 1 && r1.fired === 0 && delivered.length === 0 && held.length === 1 && held[0]!.reason === 'rate-limited' && held[0]!.scheduleId === id, JSON.stringify({ r1, held, delivered }))
  const receipt = lastHeldReceipt()
  check("the receipt says held: rate-limited — the window's end releases it, with the reset", receipt !== undefined && receipt.summary.startsWith("held: rate-limited — the window's end releases 1 held fire") && receipt.details.retryAt !== undefined, JSON.stringify(receipt))
  const r2 = await tickSaturnOnce(ports)
  check('a second tick inside the window holds nothing new and delivers nothing', r2.held === 0 && r2.fired === 0 && r2.replayed === 0 && delivered.length === 0 && heldRows().length === 1, JSON.stringify(r2))
  publishFacts({ status: 'allowed', observedAtMs: Date.now(), owner: OWNER })
  const r3 = await tickSaturnOnce(ports)
  check('at the reopen the held wake replays once, whole, on the live arm, and the hold is gone', r3.replayed === 1 && delivered.length === 1 && delivered[0]!.parked === false && delivered[0]!.prompt === 'carry on with the next unit' && heldRows().length === 0, JSON.stringify({ r3, delivered, held: heldRows() }))
  const r4 = await tickSaturnOnce(ports)
  check('nothing fires twice', r4.fired + r4.replayed + r4.held === 0 && delivered.length === 1, JSON.stringify(r4))
}

console.log('§P a parked session is never woken by a held self-wake: it waits for the resume')
{
  delivered.length = 0
  clearSchedules()
  seedRecord()
  park(true)
  publishFacts(rejectedFor(120_000))
  addVia(selfWake('the parked next unit'))
  const r1 = await tickSaturnOnce(ports)
  check('parked and walled: the wake is held rate-limited, the session untouched', r1.held === 1 && delivered.length === 0 && heldRows()[0]?.reason === 'rate-limited', JSON.stringify({ r1, held: heldRows() }))
  publishFacts({ status: 'allowed', observedAtMs: Date.now(), owner: OWNER })
  const r2 = await tickSaturnOnce(ports)
  check("the window's end does not resume the parked session: the wake waits for its own resume", delivered.length === 0 && heldRows().length === 1 && heldRows()[0]!.reason === 'parked-queued', JSON.stringify({ r2, held: heldRows(), delivered }))
  const receipt = lastHeldReceipt()
  check("the receipt says it is held for the session's next wake", receipt !== undefined && receipt.summary.startsWith("held for the session's next wake"), JSON.stringify(receipt))
  const r3 = await tickSaturnOnce(ports)
  check('a later tick while parked re-holds nothing and delivers nothing', r3.held === 0 && r3.replayed === 0 && delivered.length === 0 && heldRows().length === 1, JSON.stringify(r3))
  park(false)
  const r4 = await tickSaturnOnce(ports)
  check('the resume replays the wake once on the live arm', r4.replayed === 1 && delivered.length === 1 && delivered[0]!.parked === false && delivered[0]!.prompt === 'the parked next unit' && heldRows().length === 0, JSON.stringify({ r4, delivered, held: heldRows() }))
}

console.log("§O an operator's own schedule keeps its documented default: parked, it wakes the session at the window's end")
{
  delivered.length = 0
  clearSchedules()
  seedRecord()
  park(true)
  publishFacts(rejectedFor(120_000))
  addVia({ when: { kind: 'at', atMs: Date.now() - 1000 }, action: { kind: 'fire', prompt: 'the nightly audit' } })
  await tickSaturnOnce(ports)
  publishFacts({ status: 'allowed', observedAtMs: Date.now(), owner: OWNER })
  const r2 = await tickSaturnOnce(ports)
  check("the default 'wake' arm still reactivates the parked session once the window ends", r2.replayed === 1 && delivered.length === 1 && delivered[0]!.parked === true && delivered[0]!.prompt === 'the nightly audit', JSON.stringify({ r2, delivered }))
  park(false)
}

console.log('§N nothing armed, nothing woken')
{
  delivered.length = 0
  clearSchedules()
  seedRecord()
  publishFacts({ status: 'allowed', observedAtMs: Date.now(), owner: OWNER })
  const r = await tickSaturnOnce(ports)
  check('a session with no schedule and no hold gets no fire, no hold, no replay', r.fired + r.held + r.replayed + r.missed === 0 && r.pending === 0 && delivered.length === 0, JSON.stringify(r))
}

console.log('§T the self-paced wake tool arms the queue arm')
{
  bridge._resetScheduleBridgeForTesting()
  bridge.markScheduleSeatObserved()
  const out = await ScheduleWakeupTool.call({ delaySeconds: 60, prompt: 'the next unit' } as never, {} as never)
  const edits = bridge.takePendingScheduleEdits()
  const edit = edits[0] as { op?: string; schedule?: { action?: { kind?: string; onParked?: string } } } | undefined
  check('the tool rides the seat road', (out as { data?: { road?: string } }).data?.road === 'session', JSON.stringify(out))
  check("the submitted schedule's fire waits for a parked session's own resume (onParked 'queue')", edit?.op === 'add' && edit.schedule?.action?.kind === 'fire' && edit.schedule.action.onParked === 'queue', JSON.stringify(edit))
  bridge._resetScheduleBridgeForTesting()
}

console.log(`\n${failures === 0 ? 'prove-saturn-window-hold: ALL LAWS HOLD' : `prove-saturn-window-hold: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
