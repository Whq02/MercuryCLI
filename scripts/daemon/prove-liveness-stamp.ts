#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'liveness-home-'))

const { onFactsAnswer, onSeatRow, onSeatSpawned } = await import('../../src/daemon/session-seat/sessionSeat.ts')
const { readSessionTail, readSessionProgress } = await import('../../src/engine/connector/seatProjections.ts')
const { updateConcourseWorkers } = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail ? `${detail} — ` : ''}fix by section above: L1-L5 onSeatRow, onFactsAnswer and onSeatSpawned in src/daemon/session-seat/sessionSeat.ts (what stamps lastEventAtMs and the stream block), L6 LivePart in src/engine/connector/daemon/live.ts and the status frame relay in the turn machine` : ''}`)
  if (!ok) failures++
}

const dir = mkdtempSync(join(tmpdir(), 'liveness-daemon-'))
const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-liveness0001'
const SHORT = 'concourse-lv1'
updateConcourseWorkers(workers => {
  workers[SHORT] = {
    schema: 1,
    runnerId: SHORT,
    sessionId: sid,
    workspaceId: 'ws-lv',
    isolation: 'exclusive',
    modelKey: 'claude-opus-5',
    effort: 'high',
    spawnedAt: Date.now(),
    lastLiveAt: Date.now(),
    settingsSnapshot: { schema: 1, snapshotId: 's', sessionId: sid, profileRevision: 0, profileDigest: 'd', resolvedAt: Date.now(), rows: [] } as never,
    workspaceKind: 'plain-folder',
  } as never
}, dir)
const roster = { door: () => undefined, list: () => [], patchSeatModel: () => true, patchSeatEffort: () => true }

const frame = (o: Record<string, unknown>): Record<string, unknown> => (o)
const row = (o: Record<string, unknown>): Record<string, unknown> => frame({ seq: 1, timestamp: 't', session_id: sid, turn: 1, ...o })
const USAGE = { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1 }
const outcome = (): Record<string, unknown> => row({ type: 'outcome', schema: 1, turn_id: 't-lv', status: 'completed', steps: 1, wall_ms: 1, usage: USAGE, models: [], denials: [] })
const tail = () => readSessionTail(sid, dir)
const progress = () => readSessionProgress(sid, dir)
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const cadence = (): Promise<void> => sleep(1150)

console.log('liveness stamp — the runner speaks, the seat stamps; silence stands still')

console.log('\nL1 a long think: empty reasoning deltas are the runner speaking')
{
  const t0 = Date.now()
  onSeatRow(SHORT, row({ type: 'block_start', message_id: 'msg_think', block: 0, of: 'reasoning' }), roster as never, dir)
  const atBlock = tail()
  check('the block start stamps at once (the first row after dispatch restarts the silence clock)', typeof atBlock?.lastEventAtMs === 'number' && atBlock.lastEventAtMs >= t0, JSON.stringify(atBlock))
  check("the reasoning block's start names the block 'thinking' with its own clock", atBlock?.streamBlock === 'thinking' && typeof atBlock?.blockSinceMs === 'number' && atBlock.blockSinceMs >= t0, JSON.stringify(atBlock))
  const before = atBlock?.lastEventAtMs ?? 0
  await sleep(30)
  onSeatRow(SHORT, row({ type: 'reasoning_delta', message_id: 'msg_think', block: 0, text: '' }), roster as never, dir)
  onSeatRow(SHORT, row({ type: 'reasoning_delta', message_id: 'msg_think', block: 0, text: '' }), roster as never, dir)
  await cadence()
  const afterDeltas = tail()
  check('empty reasoning deltas move the stamp (a bare bump lands within the cadence)', typeof afterDeltas?.lastEventAtMs === 'number' && afterDeltas.lastEventAtMs > before, JSON.stringify({ before, after: afterDeltas?.lastEventAtMs }))
  check('…and the tail text stays clear — reasoning streams no words', afterDeltas?.text === null, JSON.stringify(afterDeltas))
  check('…and the block stands with its original clock', afterDeltas?.streamBlock === 'thinking' && afterDeltas.blockSinceMs === atBlock?.blockSinceMs, JSON.stringify(afterDeltas))
}

console.log('\nL2 a text block: the words flow and the stamp moves with them')
{
  onSeatRow(SHORT, row({ type: 'block_start', message_id: 'msg_think', block: 1, of: 'text' }), roster as never, dir)
  check("the text block's start reads 'text'", tail()?.streamBlock === 'text', JSON.stringify(tail()))
  const before = tail()?.lastEventAtMs ?? 0
  await sleep(30)
  onSeatRow(SHORT, row({ type: 'text_delta', message_id: 'msg_think', block: 1, text: 'Hello, ' }), roster as never, dir)
  onSeatRow(SHORT, row({ type: 'text_delta', message_id: 'msg_think', block: 1, text: 'operator.' }), roster as never, dir)
  await sleep(80)
  const streamed = tail()
  check('text deltas carry the stamp on the tail publish (no cadence wait — the text publish carries it)', streamed?.text === 'Hello, operator.' && typeof streamed?.lastEventAtMs === 'number' && streamed.lastEventAtMs > before, JSON.stringify(streamed))
  onSeatRow(SHORT, row({ type: 'text', message_id: 'msg_think', block: 1, text: 'Hello, operator.' }), roster as never, dir)
  const settled = tail()
  check("the settled row clears the text, keeps the block kind ('text' — the message is still open) and the stamp", settled?.text === null && settled?.streamBlock === 'text' && typeof settled?.lastEventAtMs === 'number', JSON.stringify(settled))
}

console.log('\nL3 a tool round: the call being written, then the tool ticking with its own budget')
{
  onSeatRow(SHORT, row({ type: 'block_start', message_id: 'msg_think', block: 2, of: 'tool_call' }), roster as never, dir)
  check("a tool call being written reads 'tool_use'", tail()?.streamBlock === 'tool_use', JSON.stringify(tail()))
  onSeatRow(SHORT, row({ type: 'tool_call', message_id: 'msg_think', block: 2, call_id: 'toolu_lv1', tool: 'Bash', input: {} }), roster as never, dir)
  check("the landed call keeps 'tool_use' (the message is still open)", tail()?.streamBlock === 'tool_use', JSON.stringify(tail()))
  onSeatRow(SHORT, row({ type: 'step', message_id: 'msg_think', model: 'claude-opus-5', usage: USAGE }), roster as never, dir)
  check('the step leaves no block and no clock (what comes next is the fold’s to say)', tail()?.streamBlock === undefined && tail()?.blockSinceMs === undefined, JSON.stringify(tail()))
  const before = tail()?.lastEventAtMs ?? 0
  await sleep(30)
  onSeatRow(SHORT, row({ type: 'tool_update', call_id: 'toolu_lv1', tick: 1, source: 'shell', line: 'building…', elapsed_s: 12, budget_ms: 600_000 }), roster as never, dir)
  await sleep(150)
  const p = progress()
  check("the tick lands on the progress projection with the tool's own budget (budget_ms → budgetMs)", p?.tools['toolu_lv1']?.budgetMs === 600_000 && p?.tools['toolu_lv1']?.elapsedTimeSeconds === 12, JSON.stringify(p))
  await cadence()
  check('the tool tick is the runner speaking — the stamp moved', (tail()?.lastEventAtMs ?? 0) > before, JSON.stringify({ before, after: tail()?.lastEventAtMs }))
  const beforeResult = tail()?.lastEventAtMs ?? 0
  await sleep(30)
  onSeatRow(SHORT, row({ type: 'tool_result', call_id: 'toolu_lv1', status: 'ok', output: 'done' }), roster as never, dir)
  await cadence()
  check('the landed tool_result row is the runner speaking too', (tail()?.lastEventAtMs ?? 0) > beforeResult, JSON.stringify({ beforeResult, after: tail()?.lastEventAtMs }))
}

console.log('\nL4 silence stands still, and the seat never counts its own probe traffic')
{
  const stamp = tail()?.lastEventAtMs ?? 0
  await sleep(1200)
  check('no row ⇒ the stamp does not move (the seat invents no liveness)', tail()?.lastEventAtMs === stamp, JSON.stringify({ stamp, now: tail()?.lastEventAtMs }))
  onFactsAnswer(
    SHORT,
    {
      model: { effective: 'claude-opus-5', setting: null },
      usage: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0, total_input_tokens: 0, total_output_tokens: 0, total_cache_read_input_tokens: 0, total_cache_creation_input_tokens: 0, has_unknown_model_cost: false },
      identity: { first_party_api: true, console_billing: false, claude_ai_billing: false, account_email: null },
      skills: [],
      mcp: [],
      permission_mode: 'default',
      workspace: { cwd: dir, original_cwd: dir, project_root: dir, instruction_roots: [] },
      queue: [],
      stream_idle_timeout_ms: 90_000,
    },
    roster as never,
    dir,
  )
  await cadence()
  check("the seat's own session_facts answer is NOT the runner speaking — the stamp still stands", tail()?.lastEventAtMs === stamp, JSON.stringify({ stamp, now: tail()?.lastEventAtMs }))
  onSeatRow(SHORT, row({ type: 'task', state: 'progress', task_id: 't1' }), roster as never, dir)
  await cadence()
  check('a background task row is not the foreground turn speaking either', tail()?.lastEventAtMs === stamp, JSON.stringify({ stamp, now: tail()?.lastEventAtMs }))
  onSeatRow(SHORT, row({ type: 'compaction', state: 'started', trigger: 'manual' }), roster as never, dir)
  check("fixture: the fold's word stands", tail()?.stateWord === 'compacting', JSON.stringify(tail()))
  const beforeAlive = tail()?.lastEventAtMs ?? 0
  await sleep(30)
  onSeatRow(SHORT, row({ type: 'heartbeat' }), roster as never, dir)
  await cadence()
  check('the heartbeat row (the stream alive with nothing for the tail) is the runner speaking — the stamp moved', (tail()?.lastEventAtMs ?? 0) > beforeAlive, JSON.stringify({ beforeAlive, after: tail()?.lastEventAtMs }))
  check("…and it touches no other word: the fold's word still stands", tail()?.stateWord === 'compacting', JSON.stringify(tail()))
  onSeatRow(SHORT, row({ type: 'compaction', state: 'ended', trigger: 'manual' }), roster as never, dir)
  check("fixture: the fold's word cleared by its own ended row", tail()?.stateWord === undefined, JSON.stringify(tail()))
}

console.log('\nL5 the outcome keeps the stamp and clears the block; a respawn zeroes everything')
{
  onSeatRow(SHORT, row({ type: 'block_start', message_id: 'msg_last', block: 0, of: 'text' }), roster as never, dir)
  onSeatRow(SHORT, outcome(), roster as never, dir)
  const settled = tail()
  check('the outcome row stamps (the last word of the turn) and leaves no block', typeof settled?.lastEventAtMs === 'number' && settled.streamBlock === undefined && settled.blockSinceMs === undefined, JSON.stringify(settled))
  onSeatRow(SHORT, row({ type: 'block_start', message_id: 'msg_dead', block: 0, of: 'reasoning' }), roster as never, dir)
  onSeatSpawned(SHORT, roster as never, dir)
  const reborn = tail()
  check("a respawn zeroes the dead child's stamp, block and clock (the new child starts unspoken)", reborn !== null && reborn.lastEventAtMs === undefined && reborn.streamBlock === undefined && reborn.blockSinceMs === undefined, JSON.stringify(reborn))
}

console.log('\nL6 structural — no surface reads transcript growth as liveness')
{
  const { LivePart } = await import('../../src/engine/connector/daemon/live.ts')
  const { IDLE_LIVE } = await import('../../src/engine/connector/seatLive.ts')
  const liveWith = (over: Record<string, unknown> = {}): InstanceType<typeof LivePart> => new LivePart({ sessionId: () => 'proof', attached: () => false, factsBusy: () => true, work: () => [], factsTurnStartedAt: () => undefined, streamIdleTimeoutMs: () => undefined, model: () => 'the-model', anySendDelivered: () => false, redressQueuedSends: () => {}, transcriptLive: () => IDLE_LIVE, toolStartedAtMs: () => null, tailHeld: () => false, clearTail: () => {}, tailInterrupted: () => {}, tailInterruptUndone: () => {}, foldStillRuns: () => true, setLiveFold: () => {}, dropRunningFoldAtIdle: () => {}, stepTurnCompletion: () => false, syncFeedCadence: () => {}, probeCarrier: () => {}, ...over } as never)
  const tailOf = (says: Record<string, unknown>): never => ({ schema: 1, sessionId: 'proof', atMs: 1, text: null, ...says }) as never
  const { streamIdleWarningMsOf } = await import('../../src/models/roads/streamIdleBudget.ts')
  const realNow = Date.now
  let clock = 5_000_000
  Date.now = () => clock
  const WATCHDOG = 900_000
  const seat = { title: 'the chat', projectLabel: 'proof', runner: null }
  let grown = IDLE_LIVE
  const seatLive = liveWith({ streamIdleTimeoutMs: () => WATCHDOG, transcriptLive: () => grown })
  seatLive.recomputeLive()
  grown = { ...IDLE_LIVE, inFlight: true, phase: 'thinking', turnStartedAtMs: clock - 60_000 }
  seatLive.recomputeLive()
  const unstamped = seatLive.status(seat)
  check('the connector carries no transcript-growth clock (lastGrewAtMs is gone)', unstamped.quietMs === null && unstamped.stuck === false && unstamped.phaseMs === 60_000, JSON.stringify(unstamped))
  seatLive.takeTail(tailOf({ lastEventAtMs: clock - 5000, streamBlock: 'text', blockSinceMs: clock - 2000 }))
  const stamped = seatLive.status(seat)
  check('the connector reads the seat’s stamp off the tail projection', stamped.quietMs === 5000 && stamped.phaseMs === 2000 && seatLive.live().phase === 'responding', JSON.stringify(stamped))
  const warnAt = streamIdleWarningMsOf(WATCHDOG)
  seatLive.takeTail(tailOf({ lastEventAtMs: clock - (warnAt - 1), streamBlock: 'text', blockSinceMs: clock }))
  const before = seatLive.status(seat).stuck
  clock += 1
  const at = seatLive.status(seat)
  check('the stuck verdict is measured against the watchdog’s own warning point (one owner, streamIdleBudget)', before === false && at.stuck === true && at.watchdogMs === WATCHDOG && at.quietMs === warnAt, JSON.stringify({ before, at, warnAt }))
  Date.now = realNow
  const t = await import('../core-runtime/turnScenarios.ts')
  const { makeRequest } = await import('../../src/engine/loop/turn/makeRequest.ts')
  const { modelReply } = await import('../../src/engine/loop/turn/modelReply.ts')
  const seam = await import('../../src/crew/board/seam.ts')
  const { runSwarmCommand } = await import('../../src/commands/swarm/swarm.ts')
  const { getSwarmAttachments } = await import('../../src/engine/attachments/queuedCommands.ts')
  const { createAttachmentMessage } = await import('../../src/engine/attachments/attachments.ts')
  const STREAM_SPOKE_AT = 4_242
  const relayed: Array<{ frame: unknown; unpresented: number }> = []
  const unpresented = { beforeTheStreamSpoke: -1, afterItSpoke: -1 }
  const reader = await t.plantRun({
    agentId: 'reader',
    querySource: 'agent:mercury-crew',
    script: [
      [
        {
          kind: 'do',
          fn: env => {
            unpresented.beforeTheStreamSpoke = getSwarmAttachments(env.rig.ctx as never, []).length
            ;(env.options.onStreamActivity as (atMs: number) => void)(STREAM_SPOKE_AT)
            unpresented.afterItSpoke = getSwarmAttachments(env.rig.ctx as never, []).length
          },
        },
        ...t.fixtures.yields(t.fixtures.says('read.')),
      ],
    ],
  })
  runSwarmCommand('on')
  await seam.latchSwarmCrewmate('reader', 'Reader')
  await seam.latchSwarmCrewmate('writer', 'Writer')
  const board = seam.swarmStore()
  const posted = board?.post(seam.swarmPrincipal('writer')!, { clientOpId: 'liveness-stamp', kind: 'message', text: 'Read this before you answer.', mentions: ['reader'] })
  reader.rig.ctx.setSDKStatus = (frame: unknown): void => {
    relayed.push({ frame, unpresented: getSwarmAttachments(reader.rig.ctx as never, []).length })
  }
  ;(reader.state.messages as unknown[]).push(...getSwarmAttachments(reader.rig.ctx as never, []).map(createAttachmentMessage))
  const asked = await t.drain(makeRequest(reader.run as never, reader.state as never, 1))
  if (asked.decision.kind === 'go_on') await t.drain(modelReply(reader.run as never, asked.decision.iter as never))
  reader.close()
  board?.close()
  check(
    "the turn machine relays the stream's activity on the runner's status frame, then presents the crew board",
    posted?.ok === true && JSON.stringify(relayed) === JSON.stringify([{ frame: { streamActivity: STREAM_SPOKE_AT }, unpresented: 1 }]) && unpresented.beforeTheStreamSpoke === 1 && unpresented.afterItSpoke === 0,
    `a crewmate's model call with one board post in its request, the provider reporting stream activity before any event: status frames ${JSON.stringify(relayed)} (one frame { streamActivity: ${STREAM_SPOKE_AT} }, relayed while the post was still unpresented); posts unpresented before the stream spoke ${unpresented.beforeTheStreamSpoke} and after ${unpresented.afterItSpoke} (1, then 0) — onStreamActivity of the model call in src/engine/loop/turn/streamModel.ts hands the moment to setSDKStatus, then presents the crew board`,
  )
  const { liveFactsOf, withFixtureRunner, withLiveRunner } = await import('../lib/builtProduct.ts')
  const { streamIdleTimeoutMs, streamIdleTimeoutMsForRoute } = await import('../../src/models/roads/streamIdleBudget.ts')
  const pinned = (await withLiveRunner(liveFactsOf, { env: { MERCURY_STREAM_IDLE_TIMEOUT_MS: '4321' } })).streamIdleTimeoutMs
  const routed = (await withFixtureRunner([], liveFactsOf)).streamIdleTimeoutMs
  check('the runner reports its own budget in the facts answer', pinned === 4321 && routed === streamIdleTimeoutMsForRoute('anthropic') && routed !== streamIdleTimeoutMs(), `${pinned} · ${routed}`)
}

console.log(
  failures === 0
    ? '\n ✅ LIVENESS STAMP — the runner speaks, the seat stamps; silence stands still, and nothing reads the transcript for it'
    : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
