#!/usr/bin/env bun
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'liveness-home-'))

const { onFactsAnswer, onSeatRow, onSeatSpawned } = await import('../../src/daemon/sessionSeat.ts')
const { readSessionTail, readSessionProgress } = await import('../../src/services/engine-connector/seatProjections.ts')
const { updateConcourseWorkers } = await import('../../src/daemon/concourseWorkers.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
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
  const read = (rel: string): string => readFileSync(join(import.meta.dir, '..', '..', rel), 'utf8')
  const connector = read('src/services/engine-connector/daemonConnector.ts')
  check('the connector carries no transcript-growth clock (lastGrewAtMs is gone)', !connector.includes('lastGrewAtMs'))
  check('the connector reads the seat’s stamp off the tail projection', connector.includes('tail.lastEventAtMs') && connector.includes('tail.streamBlock'))
  check('the stuck verdict is measured against the watchdog’s own warning point (one owner, streamIdleBudget)', connector.includes('streamIdleWarningMsOf(watchdogMs)'))
  const contract = read('src/services/engine-connector/seatLive.ts')
  check('SeatStatusV1 carries no silenceMs (the proxy is gone from the contract)', !contract.includes('silenceMs'))
  check('SeatStatusV1 carries the owner’s facts and its verdict', ['quietMs', 'watchdogMs', 'phaseMs', 'toolBudgetMs', 'stuck'].every(f => contract.includes(f)))
  const bar = read('src/components/SwitchboardTagBar.tsx')
  check('the row speaks "stuck" through the owner’s verdict alone (the status’s stuck field inside statusLine), never a local threshold', /\bs\.stuck\b/.test(bar) && !bar.includes('silenceMs') && !bar.includes('30_000'))
  check('the row’s copy is the one exported statusLine', bar.includes('export function statusLine') && /^\s*const line = .*\bstatusLine\(live, status, crew\)$/m.test(bar))
  const seatSrc = read('src/daemon/sessionSeat.ts')
  check('the seat stamps every partial row before the arms (the runner speaking, whatever the row)', /function onSeatPartialRow[\s\S]{0,400}noteSeatEvent\(seat, dir\)/.test(seatSrc))
  check('the seat stamps the heartbeat row on its own arm, apart from the state words', /case 'heartbeat':[\s\S]{0,300}noteSeatEvent\(seatFor\(\), dir\)/.test(seatSrc))
  const watchdog = read('src/services/providers/anthropic/streamCore.ts')
  check('the watchdog reads its budget from the one owner (no second constant)', watchdog.includes("streamIdleTimeoutMsForRoute('anthropic')") && watchdog.includes('streamIdleWarningMsOf(STREAM_IDLE_TIMEOUT_MS)') && !watchdog.includes('parsed >= 1_000 ? parsed : 90_000'))
  check("the stream core relays the transport's liveness beside the watchdog's note (a quiet chunk) and marks every parsed event", watchdog.includes('activityRelay.noteChunk()') && watchdog.includes('activityRelay.noteEvent()'))
  const machine = read('src/run-core/turn-machine.ts')
  check("the turn machine relays the stream's activity on the runner's status frame", machine.includes('onStreamActivity: atMs => toolUseContext.setSDKStatus?.({ streamActivity: atMs })'))
  const facts = read('src/cli/run.ts')
  check('the runner reports its own budget in the facts answer', facts.includes('streamIdleTimeoutMs: streamIdleTimeoutMsForRoute('))
}

console.log(
  failures === 0
    ? '\n ✅ LIVENESS STAMP — the runner speaks, the seat stamps; silence stands still, and nothing reads the transcript for it'
    : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
