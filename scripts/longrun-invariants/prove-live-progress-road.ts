#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'live-progress-road-'))
process.env.MERCURY_CONFIG_DIR = HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()

const { updateConcourseWorkers } = await import('../../src/daemon/concourseWorkers.js')
const seatMod = await import('../../src/daemon/sessionSeat.js')
const {
  publishSessionProgress,
  readSessionProgress,
  resetSeatProjections,
  retireSeatProjections,
  sessionProgressPath,
} = await import('../../src/services/engine-connector/seatProjections.js')
const { daemonSessionConnectorFor, HEARTBEAT_MS, IDLE_PROJECTION_FLOOR_MS } = await import('../../src/services/engine-connector/daemonConnector.js')
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
const FEED_BOUND_MS = IDLE_PROJECTION_FLOOR_MS + HEARTBEAT_MS
const until = async (cond: () => boolean, boundMs: number): Promise<number> => {
  const t0 = Date.now()
  while (!cond() && Date.now() - t0 < boundMs) await sleep(50)
  return Date.now() - t0
}

section('§A the runner tap — one bounded latest-line row per beat per tool (the turn runner, read at its source)')
{
  const turn = readFileSync(join(import.meta.dir, '../../src/rows/turn.ts'), 'utf8')
  const tapAt = turn.indexOf('if (isEphemeralToolProgress(data.type) || evalRunning !== null) {')
  const tap = turn.slice(tapAt, turn.indexOf('return rows\n      }', tapAt))
  check('a shell or mcp progress tick yields ONE tool_update row through toolUpdateRow', tap.includes('toolUpdateRow(updateScope, {') && tap.includes('callId,') && tap.includes('const key = JSON.stringify([scope.session_id, callId])'))
  check('…naming its RUNNING call (the call the turn knows, else its parent) in that call\'s own scope — a child\'s row carries parent_call_id', tap.includes('const callId = callScopes.has(progress.toolUseID) ? progress.toolUseID : progress.parentToolUseID') && tap.includes('const updateScope = callScopes.get(callId) ?? rowScope') && turn.includes('callScopes.set(item.call_id, rowScope)') && turn.includes("const scopeFor = (parentCallId: string | undefined): RowScope => (parentCallId === undefined ? scope : { ...scope, parent_call_id: parentCallId })"))
  check('…carrying the LAST non-blank line, trimmed', turn.includes("const lines = text.split('\\n')") && turn.includes('const line = lines[i]!.trim()') && turn.includes("if (line === '') continue"))
  check('…with the source word, the tick, elapsed and totals', tap.includes("source: isMcp ? 'mcp' : data.type === 'powershell_progress' ? 'powershell' : 'shell',") && tap.includes('const tick = (state?.tick ?? 0) + 1') && tap.includes("elapsedS: typeof data.elapsedTimeSeconds === 'number' ? data.elapsedTimeSeconds : undefined,") && tap.includes("lines: !isMcp && typeof shell.totalLines === 'number' ? shell.totalLines : undefined,"))
  check('a tick inside the beat is DROPPED at the source (never a backlog)', turn.includes('const TOOL_UPDATE_BEAT_MS = 250') && tap.includes('if (state !== undefined && now - state.lastEmitMs < TOOL_UPDATE_BEAT_MS) return rows'))
  check('a long line lands wire-bounded at 300 + the honest cut mark', turn.includes('const TOOL_UPDATE_LINE_MAX = 300') && turn.includes('return line.length > TOOL_UPDATE_LINE_MAX ? `${line.slice(0, TOOL_UPDATE_LINE_MAX)}…` : line'))
  check('an mcp tick carries the message tail + the bar numbers', tap.includes('line: isMcp ? latestLineOf(mcp.progressMessage) : latestLineOf(shell.output),') && tap.includes("progress: isMcp && typeof mcp.progress === 'number' ? mcp.progress : undefined,") && tap.includes("total: isMcp && typeof mcp.total === 'number' ? mcp.total : undefined,"))
  check('agent_progress still rides the TRAIL arm (the inner message\'s own rows, never a tool_update)', turn.includes("if (data.type === 'agent_progress' || data.type === 'skill_progress') {") && turn.includes('return rowsOfMessage(inner, progress.parentToolUseID)'))
}

section('§B the seat fold — tool_update rows → the session-progress projection')
const DAEMON_DIR = mkdtempSync(join(tmpdir(), 'live-progress-daemon-'))
const SHORT = 'concourse-w7'
const SESSION = 'sess-live-road'
updateConcourseWorkers(workers => {
  workers[SHORT] = {
    schema: 1, runnerId: SHORT, sessionId: SESSION, workspaceId: '/scratch/road',
    isolation: 'shared', modelKey: 'claude-opus-5', spawnedAt: Date.now(), lastLiveAt: Date.now(),
  } as never
}, DAEMON_DIR)
const roster = { door: () => undefined, list: () => [], patchSeatModel: () => true, patchSeatEffort: () => true }
let seq = 0
const envelope = (o: Record<string, unknown>): Record<string, unknown> => ({ seq: ++seq, timestamp: 't', session_id: SESSION, turn: 1, ...o })
const updateRow = (parent: string, tick: number, line: string): Record<string, unknown> =>
  envelope({ type: 'tool_update', call_id: `progress_${parent}_${tick}`, parent_call_id: parent, tick, source: 'shell', line, elapsed_s: tick, lines: tick })
const USAGE = { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1 }
const outcomeRow = (): Record<string, unknown> => envelope({ type: 'outcome', schema: 1, turn_id: 't-road', status: 'completed', steps: 1, wall_ms: 1, usage: USAGE, models: [], denials: [] })
const feed = (row: Record<string, unknown>): void => seatMod.onSeatRow(SHORT, row as never, roster as never, DAEMON_DIR)
{
  feed(updateRow('toolu_A', 1, 'first'))
  feed(updateRow('toolu_B', 1, 'beside it'))
  feed(updateRow('toolu_A', 2, 'second'))
  feed(updateRow('toolu_A', 2, 'stale-duplicate'))
  await sleep(200)
  const p = readSessionProgress(SESSION, DAEMON_DIR)
  check('two tools fold side by side, keyed by parent id', p?.tools['toolu_A'] !== undefined && p?.tools['toolu_B'] !== undefined)
  check('a moved seq REPLACES the entry (latest line only)', p?.tools['toolu_A']?.latestLine === 'second' && p?.tools['toolu_A']?.seq === 2)
  check('a stale duplicate seq never regresses the entry', p?.tools['toolu_A']?.latestLine !== 'stale-duplicate')

  feed(envelope({ type: 'tool_update', source: 'shell', line: 'no call id, no tick' }))
  feed(envelope({ type: 'tool_update', call_id: 'progress_x', tick: 'one', source: 'shell' }))
  await sleep(150)
  const p2 = readSessionProgress(SESSION, DAEMON_DIR)
  check('malformed rows fold to NOTHING (fail-soft)', Object.keys(p2?.tools ?? {}).length === 2)

  feed(outcomeRow())
  await sleep(150)
  const p3 = readSessionProgress(SESSION, DAEMON_DIR)
  check('CLEAR-ON-SETTLE: the outcome row publishes the EMPTY map', p3 !== null && Object.keys(p3.tools).length === 0)

  feed(updateRow('toolu_C', 1, 'mid-turn line'))
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
  const filledMs = await until(() => getEphemeralProgressFrame('toolu_A') !== undefined, FEED_BOUND_MS)
  const frame = getEphemeralProgressFrame('toolu_A') as { data?: { type?: string; output?: string } } | undefined
  check('the store fills from the driven feed (the writer is BACK)', frame?.data?.type === 'bash_progress' && frame?.data?.output === 'compiling module 7', `after ${filledMs} ms (the feed's own bound ${FEED_BOUND_MS} ms)`)

  const before = getEphemeralProgressFrame('toolu_A')
  publishSessionProgress({
    schema: 1, sessionId: SESSION, atMs: Date.now(),
    tools: { toolu_A: { toolUseID: 'progress_a_3', dataType: 'bash_progress', seq: 3, latestLine: 'compiling module 7', elapsedTimeSeconds: 4, totalLines: 21 } },
  })
  await sleep(700)
  check('an unmoved seq keeps the SAME store frame (no phantom re-renders)', getEphemeralProgressFrame('toolu_A') === before)

  publishSessionProgress({ schema: 1, sessionId: SESSION, atMs: Date.now(), tools: {} })
  const emptiedMs = await until(() => getEphemeralProgressFrame('toolu_A') === undefined, FEED_BOUND_MS)
  check('the seat\'s empty map empties the store (clear-on-settle, screen side)', getEphemeralProgressFrame('toolu_A') === undefined, `after ${emptiedMs} ms`)

  publishSessionProgress({
    schema: 1, sessionId: SESSION, atMs: Date.now(),
    tools: { toolu_A: { toolUseID: 'progress_a_9', dataType: 'bash_progress', seq: 9, latestLine: 'refilled', elapsedTimeSeconds: 9, totalLines: 1 } },
  })
  const refilledMs = await until(() => getEphemeralProgressFrame('toolu_A') !== undefined, FEED_BOUND_MS)
  const refilled = getEphemeralProgressFrame('toolu_A') !== undefined
  connector.detach()
  check('detach empties the store with the slot (no ghost line after a hop)', refilled && getEphemeralProgressFrame('toolu_A') === undefined, `refilled after ${refilledMs} ms`)
}

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

section('§E mixed-version — absence is lawful both directions')
{
  const OLD_SESSION = 'sess-old-runner'
  check('an OLD runner sends nothing ⇒ the projection is ABSENT and reads null', readSessionProgress(OLD_SESSION, DAEMON_DIR) === null)
  const fold = liveTurnStateOf([
    { type: 'user', uuid: 'u1', timestamp: new Date().toISOString(), message: { role: 'user', content: 'run it' } },
    { type: 'assistant', uuid: 'a1', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_old', name: 'Bash', input: {} }] } },
  ] as never)
  check('…and Layer 1 still pulses (the records fold needs no wire)', fold.inProgressToolUseIDs.has('toolu_old'))

  const { ToolUpdateRowSchema } = await import('../../src/rows/vocabulary.js')
  const sample = updateRow('toolu_S', 1, 'schema-legal')
  check('the row is the DECLARED tool_update row (every row reader parses it; an old screen ignores an unknown type)', ToolUpdateRowSchema().safeParse(sample).success === true)

  const seat = readFileSync(join(import.meta.dir, '../../src/daemon/sessionSeat.ts'), 'utf8')
  check("the seat's fold is the row's own arm (a tool_update case — no substring sniff of a line)",
    seat.includes("case 'tool_update':") && !/includes\('"ephemeral_tail"'\)/.test(seat))
  check('the seat republishes its whole progress map and clears it at the outcome row (transient by design, no last-line guarantee)',
    seat.includes('tools: Object.fromEntries(seat.progress)') && seat.includes('seat.progress.clear()'))
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
