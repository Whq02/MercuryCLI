#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSeedTranscript } from '../lib/seedTranscript.ts'

const scratch = mkdtempSync(join(tmpdir(), 'liveness-owner-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const settle = (): Promise<void> => sleep(750)

const seat = await import('../../src/services/engine-connector/daemonConnector.ts')
const projections = await import('../../src/services/engine-connector/seatProjections.ts')
const { statusLine, statusDuration } = await import('../../src/components/SwitchboardTagBar.tsx')
const { streamIdleWarningMsOf } = await import('../../src/services/providers/streamIdleBudget.ts')
type SeatStatusV1 = import('../../src/services/engine-connector/seatLive.ts').SeatStatusV1
type SessionLiveV1 = import('../../src/services/engine-connector/seatLive.ts').SessionLiveV1

const sid = '00000000-aaaa-bbbb-cccc-0000live0001'
const transcript = join(scratch, `${sid}.jsonl`)
const stamp = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString()
const rows: Array<Record<string, unknown>> = []
const land = (o: Record<string, unknown>): void => {
  rows.push({ sessionId: sid, isSidechain: false, ...o })
  writeFileSync(transcript, encodeSeedTranscript(rows, sid, new Date().toISOString()))
}
const USER_UUID = '00000000-0000-4000-8000-0000000000u1'
const TOOL_ROW_UUID = '00000000-0000-4000-8000-0000000000a1'
land({ parentUuid: null, type: 'user', uuid: USER_UUID, timestamp: stamp(20_000), message: { role: 'user', content: 'hello' } })

function facts(extra: Record<string, unknown>): void {
  projections.publishSessionFacts({
    schema: 1,
    sessionId: sid,
    atMs: Date.now(),
    pendingModel: null,
    busy: true,
    model: { effective: 'claude-opus-5', setting: null },
    usage: { totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false },
    identity: { firstPartyApi: true, consoleBilling: false, claudeAiBilling: false, accountEmail: null },
    skills: [],
    mcp: [],
    permissionMode: 'default',
    workspace: { cwd: scratch, originalCwd: scratch, projectRoot: scratch, instructionRoots: [] },
    queue: [],
    ...extra,
  } as never)
}
function tail(extra: Record<string, unknown>): void {
  projections.publishSessionTail({ schema: 1, sessionId: sid, atMs: Date.now(), text: null, ...extra } as never)
}

const c = seat.daemonSessionConnectorFor({ sessionId: sid, runnerId: 'runner-live-1', title: 'liveness fixture', projectLabel: 'proj', workspaceId: scratch, home: scratch })
facts({})
tail({})
await c.attach()
await settle()

const words = (): string => statusLine(c.live(), c.status())
const show = (): string => JSON.stringify({ live: { inFlight: c.live().inFlight, phase: c.live().phase }, status: { ...c.status(), title: undefined } })

section('§1 an old daemon (no stamp, no budget): the row states a duration and never accuses')
{
  const s = c.status()
  check('the turn is in flight (the facts busy edge) and the phase is the dispatch wait', c.live().inFlight && c.live().phase === 'thinking', show())
  check('no stamp ⇒ quietMs null; no budget ⇒ watchdogMs null', s.quietMs === null && s.watchdogMs === null, show())
  check('…so stuck is false by construction', s.stuck === false, show())
  check("the clock is the turn's own age (the prompt row's timestamp, ~20s) — a fact of the seat; the row repeats no main-agent clock", s.phaseMs !== null && s.phaseMs >= 19_000 && s.phaseMs < 40_000 && words() === '', `${words()} · ${show()}`)
}

section('§2 a long think with the runner speaking = alive: "thinking for 2m"')
{
  facts({ streamIdleTimeoutMs: 300_000 })
  tail({ lastEventAtMs: Date.now(), streamBlock: 'thinking', blockSinceMs: Date.now() - 125_000 })
  await settle()
  const s = c.status()
  check("the block in flight is the phase — 'thinking' with the block's own clock (~2m)", c.live().phase === 'thinking' && s.phaseMs !== null && s.phaseMs >= 125_000 && s.phaseMs < 140_000, show())
  check('the stamp is fresh ⇒ quietMs small, the budget is the runner’s 5m', s.quietMs !== null && s.quietMs < 5_000 && s.watchdogMs === 300_000, show())
  check('alive: not stuck', s.stuck === false, show())
  check('the words: none — the transcript and the card narrate the think, the row does not', words() === '', words())
}

section('§3 words flowing = "replying"')
{
  tail({ lastEventAtMs: Date.now(), streamBlock: 'text', blockSinceMs: Date.now() - 3_000, text: 'Hello, ' })
  await settle()
  check("a text block in flight is 'responding' on the live view", c.live().phase === 'responding', show())
  check('the words: none (the tail paints the words; the row repeats no phase)', words() === '', words())
}

section('§4 no stream events past the watchdog’s warning point = stuck, naming what it saw — and nothing before it')
{
  const points = [streamIdleWarningMsOf(4_000), streamIdleWarningMsOf(300_000), streamIdleWarningMsOf(600_000), streamIdleWarningMsOf(900_000)]
  check('the warning point is the one owner’s rule: half, never before five minutes, never after the budget (4s→4s · 5m→5m · 10m→5m · 15m→7m 30s)', points[0] === 4_000 && points[1] === 300_000 && points[2] === 300_000 && points[3] === 450_000, JSON.stringify(points))
  facts({ streamIdleTimeoutMs: 4_000 })
  tail({ lastEventAtMs: Date.now() - 2_000 })
  await settle()
  const early = c.status()
  check('2s of silence against a 4s budget is NOT stuck — the row never accuses before the watchdog’s own point', early.stuck === false && early.quietMs !== null && early.quietMs >= 2_000 && early.watchdogMs === 4_000, show())
  check('…and the row paints nothing', words() === '', words())
  tail({ lastEventAtMs: Date.now() - 5_000 })
  await settle()
  const s = c.status()
  check('5s of silence against a 4s budget ⇒ stuck (quietMs ≥ the warning point)', s.stuck === true && s.quietMs !== null && s.quietMs >= 5_000 && s.watchdogMs === 4_000, show())
  const spoken = words()
  check('the words name what it saw and the watchdog’s own number', /^no stream events for \d+s — the session may be stuck \(the watchdog aborts at 4s\)$/.test(spoken) && spoken.startsWith(`no stream events for ${statusDuration(Math.max(5_000, s.quietMs ?? 0))}`.slice(0, 21)), spoken)
  facts({ streamIdleTimeoutMs: 300_000 })
  await settle()
  const m = c.status()
  check('the same 5s under a 5m budget is not stuck (the number is the runner’s, never a local constant)', m.stuck === false && m.watchdogMs === 300_000, show())
  check('…and the row states no main-agent clock either', words() === '', words())
}

section('§5 a tool running under its deadline = alive, whatever the stream’s silence')
{
  land({
    parentUuid: USER_UUID,
    type: 'assistant',
    uuid: TOOL_ROW_UUID,
    timestamp: stamp(240_000),
    message: { id: 'msg_tool', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', id: 'toolu_live_1', name: 'Bash', input: { command: 'sleep 1000' } }], stop_reason: 'tool_use' },
  })
  facts({ streamIdleTimeoutMs: 4_000 })
  tail({ lastEventAtMs: Date.now() - 60_000 })
  projections.publishSessionProgress({
    schema: 1,
    sessionId: sid,
    atMs: Date.now(),
    tools: { toolu_live_1: { toolUseID: 'toolu_live_1_p1', dataType: 'bash_progress', seq: 1, latestLine: 'building…', elapsedTimeSeconds: 240, budgetMs: 600_000 } },
  })
  await settle()
  await settle()
  const s = c.status()
  check("the unresolved tool_use makes the phase 'tool'", c.live().phase === 'tool' && c.live().inProgressToolUseIDs.has('toolu_live_1'), show())
  check('a tool’s silence is the tool’s: not stuck despite 60s of stream silence under a 4s budget', s.stuck === false && s.quietMs !== null && s.quietMs >= 60_000, show())
  check("the tool's elapsed (~4m) and its own budget (10m) are the row's facts", s.phaseMs !== null && s.phaseMs >= 240_000 && s.phaseMs < 300_000 && s.toolBudgetMs === 600_000, show())
  check('the words: none — the tool\'s own card narrates it, the row repeats no tool clock', words() === '', words())
}

section('§6 interrupting wins over every other sentence')
{
  const live: SessionLiveV1 = { inFlight: true, phase: 'thinking', inProgressToolUseIDs: new Set(), turnStartedAtMs: Date.now() - 1000 }
  const stuck: SeatStatusV1 = { title: 't', projectLabel: 'p', interrupting: true, hardStopping: false, quietMs: 305_000, watchdogMs: 300_000, phaseMs: 305_000, toolBudgetMs: null, stuck: true, wait: null }
  check('interrupting + stuck ⇒ the interrupting sentence', statusLine(live, stuck) === 'interrupting — the request is torn down', statusLine(live, stuck))
  check('the hard stop outranks the interrupting sentence', statusLine(live, { ...stuck, hardStopping: true }) === 'stopping — the runner is cut if the turn is still open in a second', statusLine(live, { ...stuck, hardStopping: true }))
  const idle: SessionLiveV1 = { ...live, inFlight: false, phase: 'idle' }
  check('idle ⇒ "ready" whatever the stale numbers say', statusLine(idle, { ...stuck, interrupting: false }) === 'ready')
  const young: SeatStatusV1 = { ...stuck, interrupting: false, stuck: false, quietMs: 500, phaseMs: 4_000 }
  check('a running turn with no crew paints no state words (the main agent is narrated once, elsewhere)', statusLine(live, young) === '', statusLine(live, young))
  const compacting: SessionLiveV1 = { ...live, phase: 'compacting' }
  check('the fold paints nothing on the row either (its dress is the face\'s)', statusLine(compacting, { ...young, phaseMs: 30_000 }) === '', statusLine(compacting, { ...young, phaseMs: 30_000 }))
  const tool: SessionLiveV1 = { ...live, phase: 'tool' }
  check('a tool paints nothing on the row (its card names its own clock and deadline)', statusLine(tool, { ...young, phaseMs: 61_000, toolBudgetMs: null }) === '', statusLine(tool, { ...young, phaseMs: 61_000, toolBudgetMs: null }))
  const crew = { active: true, line: 'agents thought for 28m' }
  check('the crew\'s clock paints under a thinking main agent', statusLine(live, young, crew) === 'agents thought for 28m', statusLine(live, young, crew))
  check('the crew\'s clock paints under a running tool', statusLine(tool, young, crew) === 'agents thought for 28m')
  check('the crew\'s clock stands after the turn ends (esc left the crew running: never "ready")', statusLine(idle, { ...young }, crew) === 'agents thought for 28m')
  check('a settled crew\'s receipt stands while idle', statusLine(idle, young, { active: false, line: 'agents thought for 28m' }) === 'agents thought for 28m')
  check('the interrupt outranks the crew\'s clock', statusLine(live, { ...young, interrupting: true }, crew) === 'interrupting — the request is torn down')
  check('the stuck verdict outranks the crew\'s clock', statusLine(live, { ...stuck, interrupting: false }, crew).startsWith('no stream events for '))
  check('a wait on agents outranks the crew\'s clock', statusLine({ ...live, phase: 'waiting', agentsWaiting: 2 }, young, crew) === 'waiting on 2 agents')
  check('no crew line ⇒ the plain words', statusLine(idle, young, { active: false, line: null }) === 'ready' && statusLine(live, young, { active: false, line: null }) === '')
}

section('§7 the turn settles: "ready", no clocks')
{
  land({ parentUuid: TOOL_ROW_UUID, type: 'user', uuid: '00000000-0000-4000-8000-0000000000u2', timestamp: stamp(1_000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_live_1', content: 'done' }] } })
  land({ parentUuid: '00000000-0000-4000-8000-0000000000u2', type: 'assistant', uuid: '00000000-0000-4000-8000-0000000000a2', timestamp: stamp(500), message: { id: 'msg_done', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'done.' }], stop_reason: 'end_turn' } })
  facts({ streamIdleTimeoutMs: 4_000, busy: false })
  projections.publishSessionProgress({ schema: 1, sessionId: sid, atMs: Date.now(), tools: {} })
  tail({ lastEventAtMs: Date.now() - 60_000 })
  await settle()
  await settle()
  const s = c.status()
  check('idle: no turn in flight', c.live().inFlight === false, show())
  check('idle: every clock null, never stuck', s.quietMs === null && s.phaseMs === null && s.toolBudgetMs === null && s.stuck === false, show())
  check('the words: "ready"', words() === 'ready', words())
}

section('§8 the live channel ticks once a second only while a turn is in flight')
{
  let idleEmits = 0
  const offIdle = c.subscribeLive(() => idleEmits++)
  await sleep(1_300)
  offIdle()
  check('an idle chat ticks nothing (no emit in 1.3s with nothing moving)', idleEmits === 0, `${idleEmits} emit(s)`)
  facts({ streamIdleTimeoutMs: 300_000, busy: true })
  tail({ lastEventAtMs: Date.now(), streamBlock: 'thinking', blockSinceMs: Date.now() })
  await settle()
  check('fixture: in flight again', c.live().inFlight === true, show())
  let busyEmits = 0
  const offBusy = c.subscribeLive(() => busyEmits++)
  await sleep(2_300)
  offBusy()
  check('a busy chat’s live channel ticks about once a second with nothing else moving (the row’s clocks move on it)', busyEmits >= 2 && busyEmits <= 4, `${busyEmits} emit(s) in 2.3s`)
  c.detach()
  let detachedEmits = 0
  const offDetached = c.subscribeLive(() => detachedEmits++)
  await sleep(1_300)
  offDetached()
  check('detach stops the tick (the slot no longer holds the session)', detachedEmits === 0, `${detachedEmits} emit(s)`)
}

section('§9 structural: the row keys on its own words; the attribution provider on identity alone')
{
  const bar = readFileSync(join(import.meta.dir, '..', '..', 'src/components/SwitchboardTagBar.tsx'), 'utf8')
  check('the row’s snapshot key carries the sentence it paints (repaint economy keyed on the owner’s fact)', bar.includes('${statusLine(live, s)}'))
  check('the attribution provider subscribes on the identity key, never the per-second one', bar.includes('useSyncExternalStore(subscribeFocusedSeat, getFocusedSeatIdentityKey, getFocusedSeatIdentityKey)'))
  check('the row reads no transcript-growth proxy', !bar.includes('silenceMs') && !bar.includes('no new words'))
  const connector = readFileSync(join(import.meta.dir, '..', '..', 'src/services/engine-connector/daemonConnector.ts'), 'utf8')
  check('the ticker runs only in flight and only while attached', connector.includes('if (inFlight && this.attached) {') && connector.includes('this.syncLivenessTicker(false)'))
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ prove-liveness-owner — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ prove-liveness-owner — the row speaks the runner’s facts; "stuck" only past the watchdog’s warning point')
process.exit(0)
