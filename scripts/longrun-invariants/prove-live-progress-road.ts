#!/usr/bin/env bun
// ============================================================================
//  scripts/longrun-invariants/prove-live-progress-road.ts — LIVEPAINT Layer 2:
//  the ephemeral live-tail ROAD, driven cpu-pure end to end.
//
//  The regression this road heals: since the runner re-home, ephemeral tool
//  progress lived only in the runner process — the screen's ephemeral store
//  had three readers and NO writer. The road (each hop driven here on the
//  REAL modules over scratch homes; the RUN_LIVE leg in
//  live-progress-drive.ts drives the same road through the BUILT runner):
//
//    runner tap  (normalizeMessage: one `ephemeral_tail` tool_progress
//                 frame per beat per parent tool call)            [§A]
//    seat fold   (onSeatLine → session-progress projection file)  [§B]
//    connector   (ProjectionFeed → the ephemeral store fills)     [§C]
//    row paint   (the ONE in-place line; replace, never append)   [§D]
//    mixed-version (old runner ⇒ absence; the frame is wire-legal
//                 to every schema consumer; foreign frames fold
//                 to nothing)                                     [§E]
//
//  Run: ~/.bun/bin/bun run scripts/longrun-invariants/prove-live-progress-road.ts
// ============================================================================
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'live-progress-road-'))
process.env.MERCURY_CONFIG_DIR = HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()

const { normalizeMessage } = await import('../../src/utils/queryHelpers.js')
const { updateConcourseWorkers } = await import('../../src/daemon/concourseSupervisor.js')
const seatMod = await import('../../src/daemon/sessionSeat.js')
const {
  publishSessionProgress,
  readSessionProgress,
  resetSeatProjections,
  retireSeatProjections,
  sessionProgressPath,
} = await import('../../src/services/engine-connector/seatProjections.js')
const { daemonSessionConnectorFor } = await import('../../src/services/engine-connector/daemonConnector.js')
const { getEphemeralProgressFrame, _resetEphemeralProgressForTesting } = await import(
  '../../src/state/ephemeralProgressStore.js'
)
const { liveTurnStateOf } = await import('../../src/utils/conversationRecovery.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

// ── §A the runner tap ───────────────────────────────────────────────────────
section('§A the runner tap — one bounded latest-line frame per beat per tool')
type TapFrame = {
  type?: string
  tool_use_id?: string
  parent_tool_use_id?: string
  progress?: {
    kind?: string
    data_type?: string
    seq?: number
    latest_line?: string
    elapsed_time_seconds?: number
    total_lines?: number
    mcp_progress?: number
    mcp_total?: number
  }
}
const bashTick = (parent: string, n: number, output: string): unknown => ({
  type: 'progress',
  uuid: `uuid-${parent}-${n}`,
  timestamp: new Date().toISOString(),
  toolUseID: `progress_${parent}_${n}`,
  parentToolUseID: parent,
  data: { type: 'bash_progress', output, fullOutput: output, elapsedTimeSeconds: n, totalLines: n * 2 },
})
{
  const first = [...normalizeMessage(bashTick('toolu_tap', 1, 'one\ntwo trailing  ') as never)] as TapFrame[]
  check('a bash tick yields ONE ephemeral_tail tool_progress frame', first.length === 1 && first[0]!.type === 'tool_progress' && first[0]!.progress?.kind === 'ephemeral_tail')
  check('…keyed by the PARENT tool-use id (the store key)', first[0]!.parent_tool_use_id === 'toolu_tap')
  check('…carrying the LAST non-blank line, trimmed', first[0]!.progress?.latest_line === 'two trailing')
  check('…with data_type + seq + elapsed + totals', first[0]!.progress?.data_type === 'bash_progress' && first[0]!.progress?.seq === 1 && first[0]!.progress?.elapsed_time_seconds === 1 && first[0]!.progress?.total_lines === 2)

  const inBeat = [...normalizeMessage(bashTick('toolu_tap', 2, 'three') as never)]
  check('a tick inside the beat is DROPPED at the source (never a backlog)', inBeat.length === 0)
  await sleep(300)
  const nextBeat = [...normalizeMessage(bashTick('toolu_tap', 3, 'four') as never)] as TapFrame[]
  check('the next beat carries the then-latest line at the NEXT seq', nextBeat.length === 1 && nextBeat[0]!.progress?.seq === 2 && nextBeat[0]!.progress?.latest_line === 'four')

  const long = 'x'.repeat(400)
  const bounded = [...normalizeMessage(bashTick('toolu_bound', 1, long) as never)] as TapFrame[]
  check('a 400-char line lands wire-bounded at 300 + the honest cut mark', bounded[0]!.progress?.latest_line?.length === 301 && bounded[0]!.progress!.latest_line!.endsWith('…') === true)

  const mcp = [...normalizeMessage({
    type: 'progress', uuid: 'uuid-mcp', timestamp: new Date().toISOString(),
    toolUseID: 'progress_mcp_1', parentToolUseID: 'toolu_mcp',
    data: { type: 'mcp_progress', status: 'progress', serverName: 's', toolName: 't', progress: 3, total: 10, progressMessage: 'stage a\nstage b' },
  } as never)] as TapFrame[]
  check('an mcp tick carries the message tail + the bar numbers', mcp[0]!.progress?.data_type === 'mcp_progress' && mcp[0]!.progress?.latest_line === 'stage b' && mcp[0]!.progress?.mcp_progress === 3 && mcp[0]!.progress?.mcp_total === 10)

  const agent = [...normalizeMessage({
    type: 'progress', uuid: 'uuid-agent', timestamp: new Date().toISOString(),
    toolUseID: 'progress_agent_1', parentToolUseID: 'toolu_agent',
    data: { type: 'agent_progress', message: { type: 'assistant', uuid: 'am', message: { role: 'assistant', content: [{ type: 'text', text: 'sub reply', citations: [] }] } } },
  } as never)] as Array<{ type?: string }>
  check('agent_progress still rides the TRAIL arm (never ephemeral_tail)', agent.length === 1 && agent[0]!.type === 'assistant')
}

// ── §B the seat fold ────────────────────────────────────────────────────────
section('§B the seat fold — frames → the session-progress projection')
const DAEMON_DIR = mkdtempSync(join(tmpdir(), 'live-progress-daemon-'))
const SHORT = 'concourse-w7'
const SESSION = 'sess-live-road'
updateConcourseWorkers(workers => {
  workers[SHORT] = {
    schema: 1, runnerId: SHORT, sessionId: SESSION, workspaceId: '/scratch/road',
    isolation: 'shared', modelKey: 'claude-opus-5', spawnedAt: Date.now(), lastLiveAt: Date.now(),
  } as never
}, DAEMON_DIR)
const roster = { control: () => true, list: () => [], patchSeatModel: () => true, patchSeatEffort: () => true }
const wireFrame = (parent: string, seq: number, line: string): string =>
  JSON.stringify({
    type: 'tool_progress', tool_use_id: `progress_${parent}_${seq}`, parent_tool_use_id: parent,
    session_id: SESSION, uuid: `u-${parent}-${seq}`,
    progress: { kind: 'ephemeral_tail', data_type: 'bash_progress', seq, latest_line: line, elapsed_time_seconds: seq, total_lines: seq },
  })
{
  seatMod.onSeatLine(SHORT, wireFrame('toolu_A', 1, 'first'), roster as never, DAEMON_DIR)
  seatMod.onSeatLine(SHORT, wireFrame('toolu_B', 1, 'beside it'), roster as never, DAEMON_DIR)
  seatMod.onSeatLine(SHORT, wireFrame('toolu_A', 2, 'second'), roster as never, DAEMON_DIR)
  seatMod.onSeatLine(SHORT, wireFrame('toolu_A', 2, 'stale-duplicate'), roster as never, DAEMON_DIR)
  await sleep(200)
  const p = readSessionProgress(SESSION, DAEMON_DIR)
  check('two tools fold side by side, keyed by parent id', p?.tools['toolu_A'] !== undefined && p?.tools['toolu_B'] !== undefined)
  check('a moved seq REPLACES the entry (latest line only)', p?.tools['toolu_A']?.latestLine === 'second' && p?.tools['toolu_A']?.seq === 2)
  check('a stale duplicate seq never regresses the entry', p?.tools['toolu_A']?.latestLine !== 'stale-duplicate')

  seatMod.onSeatLine(SHORT, '{"type":"tool_progress","progress":{"kind":"ephemeral_tail"}}', roster as never, DAEMON_DIR)
  seatMod.onSeatLine(SHORT, 'torn line mentioning "ephemeral_tail" mid-write', roster as never, DAEMON_DIR)
  await sleep(150)
  const p2 = readSessionProgress(SESSION, DAEMON_DIR)
  check('malformed/torn frames fold to NOTHING (fail-soft)', Object.keys(p2?.tools ?? {}).length === 2)

  seatMod.onSeatLine(SHORT, JSON.stringify({ type: 'result', subtype: 'success' }), roster as never, DAEMON_DIR)
  await sleep(150)
  const p3 = readSessionProgress(SESSION, DAEMON_DIR)
  check('CLEAR-ON-SETTLE: the result frame publishes the EMPTY map', p3 !== null && Object.keys(p3.tools).length === 0)

  seatMod.onSeatLine(SHORT, wireFrame('toolu_C', 1, 'mid-turn line'), roster as never, DAEMON_DIR)
  await sleep(150)
  seatMod.onSeatSpawned(SHORT, roster as never, DAEMON_DIR)
  await sleep(150)
  const p4 = readSessionProgress(SESSION, DAEMON_DIR)
  check('a respawn clears too (a dead child leaves no ghost line)', p4 !== null && Object.keys(p4.tools).length === 0)

  retireSeatProjections(SESSION, DAEMON_DIR)
  check('retire removes the projection with the record', !existsSync(sessionProgressPath(SESSION, DAEMON_DIR)))
  publishSessionProgress({ schema: 1, sessionId: SESSION, atMs: Date.now(), tools: {} }, DAEMON_DIR)
  resetSeatProjections(DAEMON_DIR)
  check('a daemon boot reset sweeps the projection dir', !existsSync(sessionProgressPath(SESSION, DAEMON_DIR)))
  seatMod.onSeatSettled(SHORT)
}

// ── §C the connector feed ───────────────────────────────────────────────────
section('§C the connector feed — the projection fills the ephemeral store')
const CHAT_HOME = mkdtempSync(join(tmpdir(), 'live-progress-chat-'))
mkdirSync(CHAT_HOME, { recursive: true })
writeFileSync(join(CHAT_HOME, `${SESSION}.jsonl`), '')
const connector = daemonSessionConnectorFor({
  sessionId: SESSION, runnerId: SHORT, title: 't', projectLabel: 'p',
  workspaceId: '/scratch/road', home: CHAT_HOME,
})
{
  _resetEphemeralProgressForTesting()
  await connector.attach()
  publishSessionProgress({
    schema: 1, sessionId: SESSION, atMs: Date.now(),
    tools: { toolu_A: { toolUseID: 'progress_a_3', dataType: 'bash_progress', seq: 3, latestLine: 'compiling module 7', elapsedTimeSeconds: 4, totalLines: 21 } },
  })
  await sleep(700)
  const frame = getEphemeralProgressFrame('toolu_A') as { data?: { type?: string; output?: string } } | undefined
  check('the store fills from the driven feed (the writer is BACK)', frame?.data?.type === 'bash_progress' && frame?.data?.output === 'compiling module 7')

  const before = getEphemeralProgressFrame('toolu_A')
  publishSessionProgress({
    schema: 1, sessionId: SESSION, atMs: Date.now(),
    tools: { toolu_A: { toolUseID: 'progress_a_3', dataType: 'bash_progress', seq: 3, latestLine: 'compiling module 7', elapsedTimeSeconds: 4, totalLines: 21 } },
  })
  await sleep(700)
  check('an unmoved seq keeps the SAME store frame (no phantom re-renders)', getEphemeralProgressFrame('toolu_A') === before)

  publishSessionProgress({ schema: 1, sessionId: SESSION, atMs: Date.now(), tools: {} })
  await sleep(700)
  check('the seat\'s empty map empties the store (clear-on-settle, screen side)', getEphemeralProgressFrame('toolu_A') === undefined)

  publishSessionProgress({
    schema: 1, sessionId: SESSION, atMs: Date.now(),
    tools: { toolu_A: { toolUseID: 'progress_a_9', dataType: 'bash_progress', seq: 9, latestLine: 'refilled', elapsedTimeSeconds: 9, totalLines: 1 } },
  })
  await sleep(700)
  const refilled = getEphemeralProgressFrame('toolu_A') !== undefined
  connector.detach()
  check('detach empties the store with the slot (no ghost line after a hop)', refilled && getEphemeralProgressFrame('toolu_A') === undefined)
}

// ── §D the row paint — ONE in-place line, replace never append ─────────────
section('§D the row paint — one in-place line; a new beat replaces, never appends')
{
  const React = (await import('react')).default
  const { renderToString } = await import('../../src/utils/staticRender.tsx')
  const { AssistantToolUseMessage } = await import('../../src/components/messages/AssistantToolUseMessage.js')
  const { BashTool } = await import('../../src/tools/BashTool/BashTool.js')
  const { AppStateProvider } = await import('../../src/state/AppState.js')
  const TOOL_ID = 'toolu_paint'
  const lookups = {
    siblingToolUseIDs: new Map(), progressMessagesByToolUseID: new Map(),
    inProgressHookCounts: new Map(), resolvedHookCounts: new Map(),
    toolResultByToolUseID: new Map(), toolUseByToolUseID: new Map(),
    normalizedMessageCount: 1, resolvedToolUseIDs: new Set<string>(),
    erroredToolUseIDs: new Set<string>(), deniedToolUseIDs: new Set<string>(),
  }
  const storeFrame = (seq: number, line: string): unknown => ({
    type: 'progress', uuid: `p-${seq}`, timestamp: new Date().toISOString(),
    toolUseID: `progress_${TOOL_ID}_${seq}`, parentToolUseID: TOOL_ID,
    data: { type: 'bash_progress', output: line, fullOutput: line, elapsedTimeSeconds: seq, totalLines: seq },
  })
  const renderWith = async (frames: unknown[]): Promise<string> =>
    renderToString(
      React.createElement(
        AppStateProvider as never,
        {},
        React.createElement(AssistantToolUseMessage as never, {
          param: { type: 'tool_use', id: TOOL_ID, name: 'Bash', input: { command: 'bun run build.ts' } },
          tools: [BashTool], verbose: false,
          inProgressToolUseIDs: new Set([TOOL_ID]),
          progressMessagesForMessage: frames as never,
          shouldAnimate: true, shouldShowDot: true,
          lookups: lookups as never,
        } as never),
      ) as never,
      100,
    )
  const beat1 = await renderWith([storeFrame(1, 'chatty line 1')])
  const beat2 = await renderWith([storeFrame(2, 'chatty line 2')])
  const rows1 = beat1.split('\n').filter(l => l.trim() !== '').length
  const rows2 = beat2.split('\n').filter(l => l.trim() !== '').length
  check('the running row paints the latest line under the header', beat1.includes('chatty line 1'))
  check('the next beat REPLACES the line in place', beat2.includes('chatty line 2') && !beat2.includes('chatty line 1'))
  check('…with ZERO row growth between beats (the calm identity)', rows1 === rows2, `${rows1} → ${rows2}`)
  const wide = await renderWith([storeFrame(3, 'w'.repeat(280))])
  check('an over-wide line stays ONE truncated row (never wraps the block open)',
    wide.split('\n').filter(l => l.includes('www')).length === 1)
}

// ── §E the mixed-version laws ───────────────────────────────────────────────
section('§E mixed-version — absence is lawful both directions')
{
  const OLD_SESSION = 'sess-old-runner'
  check('an OLD runner sends nothing ⇒ the projection is ABSENT and reads null', readSessionProgress(OLD_SESSION, DAEMON_DIR) === null)
  const fold = liveTurnStateOf([
    { type: 'user', uuid: 'u1', timestamp: new Date().toISOString(), message: { role: 'user', content: 'run it' } },
    { type: 'assistant', uuid: 'a1', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_old', name: 'Bash', input: {} }] } },
  ] as never)
  check('…and Layer 1 still pulses (the records fold needs no wire)', fold.inProgressToolUseIDs.has('toolu_old'))

  // lazySchema exports are thunks: calling one yields the live ZodType.
  const { SDKToolProgressMessageSchema } = await import('../../src/entrypoints/sdk/coreSchemas.js')
  const sample = JSON.parse(wireFrame('toolu_S', 1, 'schema-legal')) as Record<string, unknown>
  const schema = (SDKToolProgressMessageSchema as unknown as () => { safeParse: (v: unknown) => { success: boolean } })()
  check('the frame is WIRE-LEGAL to the declared SDK schema (an old screen parses and ignores)', schema.safeParse(sample).success === true)

  const seat = readFileSync(join(import.meta.dir, '../../src/daemon/sessionSeat.ts'), 'utf8')
  check('the seat arm is substring-dispatched (an OLD daemon simply has no arm — no throw road)',
    seat.includes(`line.includes('"ephemeral_tail"')`))
  check('the projection docblock names the transient-by-design law (no last-line guarantee)',
    readFileSync(join(import.meta.dir, '../../src/services/engine-connector/seatProjections.ts'), 'utf8').includes('TRANSIENT BY DESIGN'))
}

rmSync(HOME, { recursive: true, force: true })
rmSync(DAEMON_DIR, { recursive: true, force: true })
rmSync(CHAT_HOME, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} LIVE-PROGRESS-ROAD PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL LIVE-PROGRESS-ROAD PROOFS PASS (the store has its writer back)')
process.exit(0)
