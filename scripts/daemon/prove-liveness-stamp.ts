#!/usr/bin/env bun
// ============================================================================
//  scripts/daemon/prove-liveness-stamp.ts — the liveness fact at its source
//  (LIVENESS row 1, the daemon side).
//
//  THE LIE IT REPLACES: the focused chat's status row said "no new words for
//  1m — the session may be stuck" off the transcript FILE's growth. A long
//  think (Fable 5.1 reasons for minutes with the thinking text omitted), a
//  long tool run and a real hang all leave the file still, so the row
//  accused healthy turns and could not tell a hang apart from them.
//
//  THE LAW UNDER PROOF: the seat stamps the runner's LAST FRAME OF ANY KIND
//  on the tail projection (SessionTailV1.lastEventAtMs) — a thinking delta
//  with no text, a ping, a text delta, a block boundary, a tool progress
//  tick, an assistant, user or result frame, a status word — and names the
//  block in flight (streamBlock + blockSinceMs). It never invents liveness:
//  silence leaves the stamp still, and the seat's OWN facts probe traffic
//  (a control_response to its session_facts ask) is not the runner
//  speaking. A shell's progress tick carries the tool's own budget.
//
//    L1  empty thinking deltas move the stamp; the block reads 'thinking'
//        from its start frame, with its own clock;
//    L2  a text block: 'text' at its start, deltas move the stamp, the stop
//        clears the block and keeps the stamp;
//    L3  a tool call being written reads 'tool_use'; its progress tick
//        moves the stamp and carries budget_ms → budgetMs;
//    L4  silence stands still — and the seat's own facts answer moves
//        nothing (an instrument never classifies its probe traffic);
//    L5  the result frame keeps the stamp and clears the block; a respawn
//        zeroes all three (a dead child's clock never leaks);
//    L6  structural — no surface reads transcript growth as liveness: the
//        connector carries no lastGrewAtMs, SeatStatusV1 no silenceMs, and
//        the row speaks through the owner's verdict.
//
//  Run: ~/.bun/bin/bun run scripts/daemon/prove-liveness-stamp.ts
// ============================================================================
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'liveness-home-'))

const { onSeatLine, onSeatSpawned } = await import('../../src/daemon/sessionSeat.ts')
const { readSessionTail, readSessionProgress } = await import('../../src/services/engine-connector/seatProjections.ts')
const { updateConcourseWorkers } = await import('../../src/daemon/concourseSupervisor.ts')

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
const roster = { control: () => true, list: () => [], patchSeatModel: () => true }

const frame = (o: Record<string, unknown>): string => JSON.stringify(o)
const ev = (event: Record<string, unknown>): string => frame({ type: 'stream_event', event })
const tail = () => readSessionTail(sid, dir)
const progress = () => readSessionProgress(sid, dir)
/** A bare stamp rides a one-second cadence; a boundary publishes at once.
 *  Assertions after a delta burst wait the cadence out (settle before
 *  assert). */
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const cadence = (): Promise<void> => sleep(1150)

console.log('liveness stamp — the runner speaks, the seat stamps; silence stands still')

console.log('\nL1 a long think: empty thinking deltas are the runner speaking')
{
  const t0 = Date.now()
  onSeatLine(SHORT, ev({ type: 'message_start', message: { id: 'msg_think', usage: {} } }), roster as never, dir)
  const atStart = tail()
  check('message_start stamps at once (the first event after dispatch restarts the silence clock)', typeof atStart?.lastEventAtMs === 'number' && atStart.lastEventAtMs >= t0, JSON.stringify(atStart))
  check('…with no block open yet', atStart?.streamBlock === undefined && atStart?.blockSinceMs === undefined, JSON.stringify(atStart))
  onSeatLine(SHORT, ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }), roster as never, dir)
  const atBlock = tail()
  check("the thinking block's start names the block 'thinking' with its own clock", atBlock?.streamBlock === 'thinking' && typeof atBlock?.blockSinceMs === 'number' && atBlock.blockSinceMs >= t0, JSON.stringify(atBlock))
  const before = atBlock?.lastEventAtMs ?? 0
  await sleep(30)
  onSeatLine(SHORT, ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } }), roster as never, dir)
  onSeatLine(SHORT, ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } }), roster as never, dir)
  onSeatLine(SHORT, ev({ type: 'ping' }), roster as never, dir)
  await cadence()
  const afterDeltas = tail()
  check('empty thinking deltas and a ping move the stamp (a bare bump lands within the cadence)', typeof afterDeltas?.lastEventAtMs === 'number' && afterDeltas.lastEventAtMs > before, JSON.stringify({ before, after: afterDeltas?.lastEventAtMs }))
  check('…and the tail text stays clear — thinking streams no words', afterDeltas?.text === null, JSON.stringify(afterDeltas))
  check('…and the block stands with its original clock', afterDeltas?.streamBlock === 'thinking' && afterDeltas.blockSinceMs === atBlock?.blockSinceMs, JSON.stringify(afterDeltas))
  onSeatLine(SHORT, ev({ type: 'content_block_stop', index: 0 }), roster as never, dir)
  const stopped = tail()
  check('the block stop keeps the block kind and its clock (the message is still open) and the stamp', stopped?.streamBlock === 'thinking' && stopped?.blockSinceMs === atBlock?.blockSinceMs && typeof stopped?.lastEventAtMs === 'number', JSON.stringify(stopped))
}

console.log('\nL2 a text block: the words flow and the stamp moves with them')
{
  onSeatLine(SHORT, ev({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }), roster as never, dir)
  check("the text block's start reads 'text'", tail()?.streamBlock === 'text', JSON.stringify(tail()))
  const before = tail()?.lastEventAtMs ?? 0
  await sleep(30)
  onSeatLine(SHORT, ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello, ' } }), roster as never, dir)
  onSeatLine(SHORT, ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'operator.' } }), roster as never, dir)
  await sleep(80)
  const streamed = tail()
  check('text deltas carry the stamp on the tail publish (no cadence wait — the text publish carries it)', streamed?.text === 'Hello, operator.' && typeof streamed?.lastEventAtMs === 'number' && streamed.lastEventAtMs > before, JSON.stringify(streamed))
  onSeatLine(SHORT, ev({ type: 'content_block_stop', index: 1 }), roster as never, dir)
  const stopped = tail()
  check("the stop clears the text, keeps the block kind ('text' — the message is still open) and the stamp", stopped?.text === null && stopped?.streamBlock === 'text' && typeof stopped?.lastEventAtMs === 'number', JSON.stringify(stopped))
}

console.log('\nL3 a tool round: the call being written, then the tool ticking with its own budget')
{
  onSeatLine(SHORT, ev({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_lv1', name: 'Bash', input: {} } }), roster as never, dir)
  check("a tool call being written reads 'tool_use'", tail()?.streamBlock === 'tool_use', JSON.stringify(tail()))
  onSeatLine(SHORT, ev({ type: 'content_block_stop', index: 2 }), roster as never, dir)
  check("the call's block stop keeps 'tool_use' (the message is still open)", tail()?.streamBlock === 'tool_use', JSON.stringify(tail()))
  onSeatLine(SHORT, ev({ type: 'message_stop' }), roster as never, dir)
  check('the message stop leaves no block and no clock (what comes next is the fold’s to say)', tail()?.streamBlock === undefined && tail()?.blockSinceMs === undefined, JSON.stringify(tail()))
  const before = tail()?.lastEventAtMs ?? 0
  await sleep(30)
  onSeatLine(
    SHORT,
    frame({
      type: 'tool_progress',
      tool_use_id: 'toolu_lv1_p1',
      parent_tool_use_id: 'toolu_lv1',
      session_id: sid,
      uuid: 'u-p1',
      progress: { kind: 'ephemeral_tail', data_type: 'bash_progress', seq: 1, latest_line: 'building…', elapsed_time_seconds: 12, budget_ms: 600_000 },
    }),
    roster as never,
    dir,
  )
  await sleep(150)
  const p = progress()
  check("the tick lands on the progress projection with the tool's own budget (budget_ms → budgetMs)", p?.tools['toolu_lv1']?.budgetMs === 600_000 && p?.tools['toolu_lv1']?.elapsedTimeSeconds === 12, JSON.stringify(p))
  await cadence()
  check('the tool tick is the runner speaking — the stamp moved', (tail()?.lastEventAtMs ?? 0) > before, JSON.stringify({ before, after: tail()?.lastEventAtMs }))
  const beforeResult = tail()?.lastEventAtMs ?? 0
  await sleep(30)
  onSeatLine(SHORT, frame({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_lv1', content: 'done' }] } }), roster as never, dir)
  await cadence()
  check('the landed tool result (a user frame) is the runner speaking too', (tail()?.lastEventAtMs ?? 0) > beforeResult, JSON.stringify({ beforeResult, after: tail()?.lastEventAtMs }))
}

console.log('\nL4 silence stands still, and the seat never counts its own probe traffic')
{
  const stamp = tail()?.lastEventAtMs ?? 0
  await sleep(1200)
  check('no frame ⇒ the stamp does not move (the seat invents no liveness)', tail()?.lastEventAtMs === stamp, JSON.stringify({ stamp, now: tail()?.lastEventAtMs }))
  // The seat's own probe: a session_facts answer, spelled exactly as the
  // facts arm recognises it (the real request prefix, a valid answer), so
  // the arm CONSUMES it — and still stamps nothing.
  onSeatLine(
    SHORT,
    frame({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'mercury-session-facts-probe-1',
        response: {
          model: { effective: 'claude-opus-5', setting: null },
          usage: { totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false },
          identity: { firstPartyApi: true, consoleBilling: false, claudeAiBilling: false, accountEmail: null },
          skills: [],
          mcp: [],
          permissionMode: 'default',
          workspace: { cwd: dir, originalCwd: dir, projectRoot: dir, instructionRoots: [] },
          queue: [],
          streamIdleTimeoutMs: 90_000,
        },
      },
    }),
    roster as never,
    dir,
  )
  await cadence()
  check("the seat's own session_facts answer is NOT the runner speaking — the stamp still stands", tail()?.lastEventAtMs === stamp, JSON.stringify({ stamp, now: tail()?.lastEventAtMs }))
  onSeatLine(SHORT, frame({ type: 'system', subtype: 'task_progress', task_id: 't1' }), roster as never, dir)
  await cadence()
  check('a background task frame is not the foreground turn speaking either', tail()?.lastEventAtMs === stamp, JSON.stringify({ stamp, now: tail()?.lastEventAtMs }))
}

console.log('\nL5 the result keeps the stamp and clears the block; a respawn zeroes everything')
{
  onSeatLine(SHORT, ev({ type: 'content_block_start', index: 3, content_block: { type: 'text', text: '' } }), roster as never, dir)
  onSeatLine(SHORT, frame({ type: 'result', subtype: 'success' }), roster as never, dir)
  const settled = tail()
  check('the result frame stamps (the last word of the turn) and leaves no block', typeof settled?.lastEventAtMs === 'number' && settled.streamBlock === undefined && settled.blockSinceMs === undefined, JSON.stringify(settled))
  onSeatLine(SHORT, ev({ type: 'message_start', message: { id: 'msg_dead', usage: {} } }), roster as never, dir)
  onSeatLine(SHORT, ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }), roster as never, dir)
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
  check('the stuck verdict is measured against the watchdog’s own warning half (one owner, streamIdleBudget)', connector.includes('streamIdleWarningMsOf(watchdogMs)'))
  const contract = read('src/services/engine-connector/seatLive.ts')
  check('SeatStatusV1 carries no silenceMs (the proxy is gone from the contract)', !contract.includes('silenceMs'))
  check('SeatStatusV1 carries the owner’s facts and its verdict', ['quietMs', 'watchdogMs', 'phaseMs', 'toolBudgetMs', 'stuck'].every(f => contract.includes(f)))
  const bar = read('src/components/SwitchboardTagBar.tsx')
  check('the row speaks "stuck" through the owner’s verdict alone (status.stuck), never a local threshold', bar.includes('status.stuck') && !bar.includes('silenceMs') && !bar.includes('30_000'))
  check('the row’s copy is the one exported statusLine', bar.includes('export function statusLine') && bar.includes('const line = statusLine(live, status)'))
  const seatSrc = read('src/daemon/sessionSeat.ts')
  check('the seat stamps every stream event before the arms (the runner speaking, whatever the event)', seatSrc.includes("if (frame.type !== 'stream_event' || !frame.event) return false") && seatSrc.indexOf('noteSeatEvent(seat, dir)') > 0)
  const watchdog = read('src/services/providers/anthropic/streamCore.ts')
  check('the watchdog reads its budget from the one owner (no second constant)', watchdog.includes('streamIdleTimeoutMs()') && watchdog.includes('streamIdleWarningMsOf(STREAM_IDLE_TIMEOUT_MS)') && !watchdog.includes('parsed >= 1_000 ? parsed : 90_000'))
  const facts = read('src/cli/print.ts')
  check('the runner reports its own budget in the facts answer', facts.includes('streamIdleTimeoutMs: streamIdleTimeoutMsForRoute('))
}

console.log(
  failures === 0
    ? '\n ✅ LIVENESS STAMP — the runner speaks, the seat stamps; silence stands still, and nothing reads the transcript for it'
    : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
