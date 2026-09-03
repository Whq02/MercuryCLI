#!/usr/bin/env bun
// ============================================================================
//  scripts/engine-connector/prove-liveness-owner.ts — the one liveness owner
//  and the words the status row speaks from it (LIVENESS rows 1-4).
//
//  THE LAW: the focused chat's status row may claim "the session may be
//  stuck" only on evidence of stuckness — the runner's own stream silent
//  past its watchdog's warning half — and otherwise states what the session
//  is doing and for how long. The connector folds the seat's stamps (the
//  tail projection's lastEventAtMs / streamBlock / blockSinceMs, the
//  progress projection's budgetMs, the facts' streamIdleTimeoutMs) into
//  SeatStatusV1 {quietMs, watchdogMs, phaseMs, toolBudgetMs, stuck, wait}; the
//  row's copy is the exported statusLine. Transcript growth feeds none of
//  it.
//
//  The matrix, over a REAL DaemonSessionConnector attached to a scratch
//  transcript and scratch projections (the feeds pick the files up):
//    §1 an old daemon (no stamp, no budget): durations only, never stuck;
//    §2 a long think with the runner speaking (empty thinking deltas —
//       the seat's stamp fresh, the block 'thinking' for two minutes) =
//       alive: "thinking for 2m";
//    §3 words flowing = "replying" (the block 'text');
//    §4 no stream events past the warning half = stuck, naming what it saw
//       and the watchdog's own number;
//    §5 a tool running under its deadline = alive whatever the stream's
//       silence: "running a tool for 4m (its own timeout at 10m)";
//    §6 interrupting wins over every other sentence (pure);
//    §7 the turn settles: "ready", no clocks;
//    §8 the live channel ticks once a second only while a turn is in
//       flight (the row's clocks move; an idle chat ticks nothing);
//    §9 structural: the row's snapshot key is its own words; the
//       attribution provider keys on identity alone.
//
//  Run: ~/.bun/bin/bun run scripts/engine-connector/prove-liveness-owner.ts
// ============================================================================
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
/** The feeds heartbeat at 400 ms (fs.watch usually lands sooner); every
 *  assertion waits a settle out (settle before assert). */
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
// The session file holds RECORD lines (the fabric codec): rows are described
// in the legacy entry shape and encoded through the real codec, the whole
// file rewritten per change so the ordinals stay one sequence (the
// connector reloads the whole file on every tick; a legacy line would be
// refused as a retired format and the fold would see nothing).
const rows: Array<Record<string, unknown>> = []
const land = (o: Record<string, unknown>): void => {
  rows.push({ sessionId: sid, isSidechain: false, ...o })
  writeFileSync(transcript, encodeSeedTranscript(rows, sid, new Date().toISOString()))
}
const USER_UUID = '00000000-0000-4000-8000-0000000000u1'
const TOOL_ROW_UUID = '00000000-0000-4000-8000-0000000000a1'
// The turn opened twenty seconds ago; nothing answered yet (the dispatch wait).
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
// Older daemon first: a busy turn, no budget, no stamp.
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
  check("the clock is the turn's own age (the prompt row's timestamp) — 'thinking for 20s'", s.phaseMs !== null && s.phaseMs >= 19_000 && s.phaseMs < 40_000 && words() === `thinking for ${statusDuration(s.phaseMs)}`, `${words()} · ${show()}`)
}

section('§2 a long think with the runner speaking = alive: "thinking for 2m"')
{
  facts({ streamIdleTimeoutMs: 90_000 })
  tail({ lastEventAtMs: Date.now(), streamBlock: 'thinking', blockSinceMs: Date.now() - 125_000 })
  await settle()
  const s = c.status()
  check("the block in flight is the phase — 'thinking' with the block's own clock (~2m)", c.live().phase === 'thinking' && s.phaseMs !== null && s.phaseMs >= 125_000 && s.phaseMs < 140_000, show())
  check('the stamp is fresh ⇒ quietMs small, the budget is the runner’s 90s', s.quietMs !== null && s.quietMs < 5_000 && s.watchdogMs === 90_000, show())
  check('alive: not stuck', s.stuck === false, show())
  check('the words: "thinking for 2m"', words() === 'thinking for 2m', words())
}

section('§3 words flowing = "replying"')
{
  tail({ lastEventAtMs: Date.now(), streamBlock: 'text', blockSinceMs: Date.now() - 3_000, text: 'Hello, ' })
  await settle()
  check("a text block in flight is 'responding' on the live view", c.live().phase === 'responding', show())
  check('the words: "replying" (the tail paints the words; the row adds no clock)', words() === 'replying', words())
}

section('§4 no stream events past the watchdog’s warning half = stuck, naming what it saw')
{
  // The runner's watchdog budget is 4s here (a fixture's env would set it);
  // the warning half is 2s. Three seconds of silence: stuck.
  facts({ streamIdleTimeoutMs: 4_000 })
  tail({ lastEventAtMs: Date.now() - 3_000 })
  await settle()
  const s = c.status()
  check('the warning half is the one owner’s rule', streamIdleWarningMsOf(4_000) === 2_000)
  check('3s of silence against a 4s budget ⇒ stuck (quietMs ≥ the warning half)', s.stuck === true && s.quietMs !== null && s.quietMs >= 3_000 && s.watchdogMs === 4_000, show())
  check('the words name what it saw and the watchdog’s own number', words() === `no stream events for ${statusDuration(s.quietMs ?? 0)} — the session may be stuck (the watchdog aborts at 4s)`, words())
  // The mirror: the same silence under the real 90s budget is NOT stuck.
  facts({ streamIdleTimeoutMs: 90_000 })
  await settle()
  const m = c.status()
  check('the same 3s under a 90s budget is not stuck (the number is the runner’s, never a local constant)', m.stuck === false && m.watchdogMs === 90_000, show())
  check('…and the row states the dispatch-wait clock instead', words().startsWith('thinking for '), words())
}

section('§5 a tool running under its deadline = alive, whatever the stream’s silence')
{
  // The runner's assistant row carrying the tool_use lands (four minutes
  // ago); the progress projection ticks with the shell's own budget.
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
  check('the words: "running a tool for 4m (its own timeout at 10m)"', words() === 'running a tool for 4m (its own timeout at 10m)', words())
}

section('§6 interrupting wins over every other sentence')
{
  const live: SessionLiveV1 = { inFlight: true, phase: 'thinking', inProgressToolUseIDs: new Set(), turnStartedAtMs: Date.now() - 1000 }
  const stuck: SeatStatusV1 = { title: 't', projectLabel: 'p', interrupting: true, hardStopping: false, quietMs: 50_000, watchdogMs: 90_000, phaseMs: 50_000, toolBudgetMs: null, stuck: true, wait: null }
  // The interrupt's words claim exactly what the road does: the request
  // is torn down and every agent the turn waits on is stopped; a second
  // esc is the hard stop that cuts the runner if the turn is still open.
  check('interrupting + stuck ⇒ the interrupting sentence', statusLine(live, stuck) === 'interrupting — the request is torn down · esc again forces a stop', statusLine(live, stuck))
  check('the hard stop outranks the interrupting sentence', statusLine(live, { ...stuck, hardStopping: true }) === 'stopping — the runner is cut if the turn is still open in a second', statusLine(live, { ...stuck, hardStopping: true }))
  const idle: SessionLiveV1 = { ...live, inFlight: false, phase: 'idle' }
  check('idle ⇒ "ready" whatever the stale numbers say', statusLine(idle, { ...stuck, interrupting: false }) === 'ready')
  const young: SeatStatusV1 = { ...stuck, interrupting: false, stuck: false, quietMs: 500, phaseMs: 4_000 }
  check('a young phase paints no clock (durations from ten seconds on)', statusLine(live, young) === 'thinking', statusLine(live, young))
  const compacting: SessionLiveV1 = { ...live, phase: 'compacting' }
  check('the fold speaks its own word', statusLine(compacting, { ...young, phaseMs: 30_000 }) === 'compacting for 30s', statusLine(compacting, { ...young, phaseMs: 30_000 }))
  const tool: SessionLiveV1 = { ...live, phase: 'tool' }
  check('a tool without a known budget names no deadline', statusLine(tool, { ...young, phaseMs: 61_000, toolBudgetMs: null }) === 'running a tool for 1m', statusLine(tool, { ...young, phaseMs: 61_000, toolBudgetMs: null }))
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
  facts({ streamIdleTimeoutMs: 90_000, busy: true })
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
console.log('✅ prove-liveness-owner — the row speaks the runner’s facts; "stuck" only past the watchdog’s warning half')
process.exit(0)
