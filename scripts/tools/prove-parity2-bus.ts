#!/usr/bin/env bun
// ============================================================================
//  prove-parity2-bus — frontier-sweep #2, the bus / session-fabric
//  tier, mechanism-pinned:
//
//   1. Stream iterator stays O(1) under consumer lag (C25): the head cursor
//      hands out every value in order, compacts, and a 200k-event lag drains
//      in linear time.
//   2. Piped-stdout drain at exit (packet 76) — CROSS-MODULE with a SLOW
//      READER: a child writes a multi-megabyte stream-json-shaped payload
//      through unawaited stdout writes and exits through the REAL
//      gracefulShutdown; the parent reads slowly. Every byte arrives,
//      terminal marker included. The drain's progress law and stall bound
//      are pinned on a stdout double too.
//   3. Subagent badges bind to the RESOLVED model/effort (packet 63): the
//      workflow frame repaints with what the runner resolved, not what the
//      script declared.
//   4. Idle retirement of EMPTY background sessions (rider R5 + packet 74):
//      the pure decision table (every refusal reason), the conversation
//      probe over both envelope generations, and a real sweep over a scratch
//      daemon dir — the empty idle worker is stopped through the roster
//      with the typed retired fact; a worker with conversation, a paused
//      one, an attached one, a busy one, a young one all survive; the
//      session list's sentence derives from the fact.
//   5. A pending extensions reload raises no notification (the board carries it) —
//      structural (a React effect).
// ============================================================================
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { entryToRecord } from '../../src/fabric/entryCodec.js'
import { ordinalOf } from '../../src/fabric/ordinal.js'
let __ord = 0
const __encRecordLine = (e: unknown): string =>
  JSON.stringify(
    entryToRecord(e as never, {
      sessionId: 'parity2-proof',
      nextOrdinal: () => ordinalOf(++__ord),
      observedAt: '2026-08-01T10:00:00.000Z',
      source: { channel: 'interactive' },
    } as never),
  )

import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'parity2-bus-'))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
mkdirSync(home, { recursive: true })
mkdirSync(daemonDir, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonDir
delete process.env.MERCURY_HOME
delete process.env.MERCURY_HOME

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// —— 1. stream iterator under lag (C25) ————————————————————————————————
{
  const { Stream } = await import('../../src/utils/stream.ts')
  const stream = new Stream<number>()
  const N = 200_000
  for (let i = 0; i < N; i++) stream.enqueue(i)
  stream.done()
  const started = performance.now()
  let expected = 0
  let ordered = true
  for await (const value of stream) {
    if (value !== expected) ordered = false
    expected++
  }
  const elapsed = performance.now() - started
  t('every lagged value drains in order', ordered && expected === N)
  t('200k lagged events drain in linear time (< 2s)', elapsed < 2_000, `${Math.round(elapsed)}ms`)
  const interleaved = new Stream<string>()
  const reader = (async () => {
    const seen: string[] = []
    for await (const v of interleaved) seen.push(v)
    return seen
  })()
  interleaved.enqueue('a')
  await sleep(5)
  interleaved.enqueue('b')
  interleaved.enqueue('c')
  await sleep(5)
  interleaved.done()
  t('interleaved enqueue/park/drain keeps order', (await reader).join('') === 'abc')
}

// —— 2. piped-stdout drain at exit (packet 76) —————————————————————————
{
  const { drainPipedStdoutForExit } = await import('../../src/utils/gracefulShutdown.ts')
  t('a TTY never waits', (await drainPipedStdoutForExit({ isTTY: true, writableLength: 5_000 })).drained)
  t('an empty pipe buffer is already drained', (await drainPipedStdoutForExit({ isTTY: false, writableLength: 0 })).drained)
  // Progress law: a buffer that keeps shrinking is waited on past the stall
  // bound; one that stops shrinking is abandoned after it.
  const shrinking = { isTTY: false, writableLength: 1_000 }
  const drainer = setInterval(() => {
    shrinking.writableLength = Math.max(0, shrinking.writableLength - 50)
  }, 20)
  const shrinkStart = Date.now()
  const shrinkResult = await drainPipedStdoutForExit(shrinking, 120)
  clearInterval(drainer)
  t('a draining consumer is waited on past the stall bound (progress, not a flat cap)', shrinkResult.drained && Date.now() - shrinkStart > 120)
  const stuck = { isTTY: false, writableLength: 777 }
  const stuckStart = Date.now()
  const stuckResult = await drainPipedStdoutForExit(stuck, 80)
  t('a stalled consumer is abandoned after the stall bound with the remainder counted', !stuckResult.drained && stuckResult.remainingBytes === 777 && Date.now() - stuckStart >= 80)

  // —— the exit-cliff quiescence (TASK-017 D3, the 0xC0000409 family):
  // process.exit under a knowingly in-flight cleanup is the win32 libuv
  // async.c:94 abort — the shutdown holds the cleanup promise past its cap
  // and gives it one bounded grace at the cliff. ——
  const { quiesceCleanupBeforeExit, EXIT_QUIESCENCE_MS } = await import('../../src/utils/gracefulShutdown.ts')
  t('the quiescence grace is bounded and small (a wedged cleanup cannot hold the exit)', EXIT_QUIESCENCE_MS > 0 && EXIT_QUIESCENCE_MS <= 1_000)
  const settledStart = Date.now()
  await quiesceCleanupBeforeExit(Promise.resolve())
  t('a settled cleanup costs the exit nothing', Date.now() - settledStart < 50)
  const rejectedStart = Date.now()
  await quiesceCleanupBeforeExit(Promise.reject(new Error('cleanup failed')))
  t('a rejected cleanup never throws at the cliff and costs nothing', Date.now() - rejectedStart < 50)
  const landAt = Date.now() + 60
  let landed = false
  const late = new Promise<void>(res => setTimeout(() => { landed = true; res() }, 60))
  await quiesceCleanupBeforeExit(late, 500)
  t('an in-flight cleanup LANDS inside the grace (the exit is quiesced, not raced)', landed && Date.now() >= landAt)
  const wedgedStart = Date.now()
  await quiesceCleanupBeforeExit(new Promise(() => {}), 80)
  const wedgedMs = Date.now() - wedgedStart
  t('a wedged cleanup is abandoned at the grace, never held forever', wedgedMs >= 80 && wedgedMs < 500)
  const shutdownSrc = readFileSync(join(process.cwd(), 'src/utils/gracefulShutdown.ts'), 'utf8')
  t('POISON (the raced cliff): the shutdown quiesces the HELD cleanup promise after the stdout drain, before forceExit', /await drainPipedStdoutForExit\(\)[\s\S]{0,600}await quiesceCleanupBeforeExit\(cleanupRun\)[\s\S]{0,200}forceExit\(exitCode\)/.test(shutdownSrc))
  t('POISON (the abandoned promise): the cleanup race consumes the held promise, not a fresh call', shutdownSrc.includes('const cleanupRun = runCleanupFunctions()') && /Promise\.race\(\[\s*\n\s*cleanupRun,/.test(shutdownSrc))

  // Cross-module: a real child, real pipes, a slow reader.
  const childScript = join(SCRATCH, 'child.ts')
  writeFileSync(
    childScript,
    `
const { gracefulShutdown } = await import(${JSON.stringify(join(process.cwd(), 'src/utils/gracefulShutdown.ts'))})
const line = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x'.repeat(900) } } }) + '\\n'
for (let i = 0; i < 4000; i++) process.stdout.write(line)
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', marker: 'END-OF-STREAM' }) + '\\n')
await gracefulShutdown(0)
`,
  )
  const child = spawn(process.execPath, ['run', childScript], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let received = 0
  let sawMarker = false
  let tail = ''
  child.stdout.pause()
  await sleep(400) // the slow reader: let the child finish writing and try to exit first
  child.stdout.on('data', (chunk: Buffer) => {
    received += chunk.length
    tail = (tail + chunk.toString('utf8')).slice(-200)
    if (tail.includes('END-OF-STREAM')) sawMarker = true
  })
  child.stdout.resume()
  const exit = await new Promise<number | null>(resolve => child.on('close', code => resolve(code)))
  t('the child exits 0 through the real graceful shutdown', exit === 0, `exit ${exit}`)
  const expectedBytes = (JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x'.repeat(900) } } }).length + 1) * 4000
  t('a slow reader still receives every streamed byte (no tail loss at exit)', received > expectedBytes, `${received} bytes (>${expectedBytes} expected)`)
  t('the terminal result frame arrives last', sawMarker)
}

// —— 3. badges bind to the RESOLVED identity (packet 63) ————————————————
{
  const { makeWorkflowHooks } = await import('../../src/tools/WorkflowTool/agentHooks.ts')
  type FakeArgs = { onResolvedIdentity?: (i: { model: string; effort?: string }) => void }
  const frames: Array<Record<string, unknown>> = []
  const fakeSpawn = (args: FakeArgs): AsyncGenerator<unknown, void> => {
    async function* run(): AsyncGenerator<unknown, void> {
      // The runner resolves a definition-pinned model the script never named.
      args.onResolvedIdentity?.({ model: 'claude-sonnet-5', effort: 'max' })
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }
    }
    return run()
  }
  const hooks = makeWorkflowHooks({
    toolUseContext: {
      abortController: new AbortController(),
      getAppState: () => ({
        toolPermissionContext: { mode: 'default', additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {} },
        mcp: { tools: [] },
      }),
      options: { agentDefinitions: { activeAgents: [] }, mainLoopModel: 'claude-opus-5' },
    },
    canUseTool: async () => ({ behavior: 'allow' }),
    emitProgress: (f: unknown) => {
      const data = (f as { data?: Record<string, unknown> }).data
      if (data) frames.push(data)
    },
    workflowRunId: undefined,
    onAgentController: () => {},
    seedPhaseTitles: [],
    args: undefined,
    spawnSubagentStream: fakeSpawn as never,
  } as never) as unknown as { agent: (p: string, o?: Record<string, unknown>) => Promise<unknown> }
  await hooks.agent('badge truth')
  const startFrame = frames.find(f => f.state === 'start')
  const resolvedFrame = frames.find(f => f.model === 'claude-sonnet-5')
  const doneFrame = [...frames].reverse().find(f => f.state === 'done')
  t('the start frame paints the declared default (the script named nothing)', startFrame?.model === 'claude-opus-5')
  t('a frame repaints with the RESOLVED model and effort once the runner knows them', resolvedFrame !== undefined && resolvedFrame.effort === 'max')
  t('the done frame carries the resolved identity, not the declaration', doneFrame?.model === 'claude-sonnet-5' && doneFrame?.effort === 'max')
}

// —— 4. idle retirement of EMPTY sessions (rider R5 + packet 74) —————————
{
  const { decideIdleRetirement, transcriptTextHasConversation, transcriptHasConversation, sweepIdleEmptyConcourseSessions, retiredNowLabel, concourseIdleRetireMs, DEFAULT_CONCOURSE_IDLE_RETIRE_MINUTES } =
    await import('../../src/daemon/idleRetirement.ts')
  const { concourseWorkersPath, readSessionWorkers } = await import('../../src/daemon/concourseSupervisor.ts')
  const { workerTranscriptPath } = await import('../../src/services/concourse/workerTranscript.ts')

  t('the default threshold is the operator\'s ten minutes', concourseIdleRetireMs() === DEFAULT_CONCOURSE_IDLE_RETIRE_MINUTES * 60_000 && DEFAULT_CONCOURSE_IDLE_RETIRE_MINUTES === 10)

  const T = 10 * 60_000
  const now = 1_000_000_000
  const base = { spawnedAt: now - 2 * T }
  const facts = (over: Record<string, unknown>) => ({ rec: { ...base, ...over } as never, alive: true, hasConversation: false, hasPendingWork: false, nowMs: now, thresholdMs: T })
  const reason = (d: ReturnType<typeof decideIdleRetirement>) => (d.retire ? 'retire' : d.reason)
  t('empty + live + idle past the threshold ⇒ retire', reason(decideIdleRetirement(facts({}))) === 'retire')
  t('threshold 0 ⇒ disabled', reason(decideIdleRetirement({ ...facts({}), thresholdMs: 0 })) === 'disabled')
  t('a dead worker is not retired by this owner', reason(decideIdleRetirement({ ...facts({}), alive: false })) === 'not-live')
  t('paused ⇒ kept', reason(decideIdleRetirement(facts({ pausedAt: now - T }))) === 'paused')
  t('attached ⇒ kept', reason(decideIdleRetirement(facts({ attachedAt: now - T }))) === 'attached')
  t('attach requested ⇒ kept', reason(decideIdleRetirement(facts({ attachRequestedAt: now - 1 }))) === 'attached')
  t('a turn in flight ⇒ kept', reason(decideIdleRetirement(facts({ lastDeliveryAt: now - T, lastTurnSettledAt: now - 2 * T }))) === 'turn-in-flight')
  t('conversation present ⇒ never retired by idleness', reason(decideIdleRetirement({ ...facts({}), hasConversation: true })) === 'has-conversation')
  t('pending work ⇒ kept', reason(decideIdleRetirement({ ...facts({}), hasPendingWork: true })) === 'pending-work')
  t('younger than the threshold ⇒ not yet', reason(decideIdleRetirement(facts({ spawnedAt: now - T + 1 }))) === 'not-idle-long-enough')
  // THE BIRTH GRACE: a newborn — born blank
  // through New Session, never messaged — is never "empty and idle".
  // Poison = today's reap: the same record without bornBlankAt retires.
  t('a blank newborn idle past the threshold is KEPT (the birth grace; poison: the reap of a chat the operator just opened)', reason(decideIdleRetirement(facts({ bornBlankAt: now - 2 * T }))) === 'newborn')
  t('the grace is unbounded by default (no newbornGraceMs ⇒ never)', reason(decideIdleRetirement({ ...facts({ bornBlankAt: now - 100 * T }), newbornGraceMs: 0 })) === 'newborn')
  t('a bounded grace keeps the newborn inside its window', reason(decideIdleRetirement({ ...facts({ bornBlankAt: now - T }), newbornGraceMs: 2 * T })) === 'newborn')
  t('a bounded grace lapses: past the window the newborn is judged like any empty session', reason(decideIdleRetirement({ ...facts({ bornBlankAt: now - 3 * T }), newbornGraceMs: 2 * T })) === 'retire')
  t("the first delivery ends the grace (a messaged newborn is an ordinary session — here: settled after delivery, empty, idle ⇒ retire)", reason(decideIdleRetirement(facts({ bornBlankAt: now - 3 * T, lastDeliveryAt: now - 2 * T, lastTurnSettledAt: now - 2 * T + 1 }))) === 'retire')
  t('the poison control: the same idle record WITHOUT the birth stamp retires', reason(decideIdleRetirement(facts({}))) === 'retire')
  t('idle counts from the latest activity stamp', reason(decideIdleRetirement(facts({ lastAttachGrantAt: now - T / 2 }))) === 'not-idle-long-enough')
  t('already stopped ⇒ refused', reason(decideIdleRetirement(facts({ stoppedAt: now - 1 }))) === 'stopped')

  t('a retired-format object line refuses the emptiness judgment (counts as conversation)', transcriptTextHasConversation(JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })))
  t('a record user line is conversation', transcriptTextHasConversation(__encRecordLine({ type: 'user', message: { role: 'user', content: 'hi' } })))
  t('a summary/system-only transcript is not conversation', !transcriptTextHasConversation(__encRecordLine({ type: 'summary', summary: 'x', leafUuid: 'leaf-1' }) + '\n' + __encRecordLine({ type: 'system', subtype: 'init', content: 'boot' })))
  t('junk lines are not conversation', !transcriptTextHasConversation('not json\n{"type":'))

  // The truncated-window class (external-review claim 1): a transcript whose
  // FIRST conversation record crosses the probe boundary must never be judged
  // empty from the torn window — emptiness is only proven over the whole file.
  const hugeWs = join(SCRATCH, 'ws-huge')
  mkdirSync(hugeWs, { recursive: true })
  const hugePath = workerTranscriptPath({ sessionId: 'sess-huge-first', workspaceId: hugeWs })
  mkdirSync(join(hugePath, '..'), { recursive: true })
  writeFileSync(
    hugePath,
    JSON.stringify({ type: 'summary', summary: 'operator session' }) +
      '\n' +
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'big paste: ' + 'x'.repeat(300 * 1024) } }) +
      '\n',
  )
  t(
    'a >probe-window transcript is never provably empty (torn tail is not a content verdict)',
    transcriptHasConversation({ sessionId: 'sess-huge-first', workspaceId: hugeWs }),
  )

  // The sweep against a scratch daemon dir: three live workers (this very
  // process's pid — alive), one empty and idle, one with conversation, one
  // empty but young; plus a paused empty one.
  const ws = join(SCRATCH, 'ws')
  mkdirSync(ws, { recursive: true })
  const rec = (runnerId: string, sessionId: string, extra: Record<string, unknown>) => ({
    schema: 1,
    runnerId,
    sessionId,
    workspaceId: ws,
    isolation: 'exclusive',
    modelKey: 'claude-opus-5',
    spawnedAt: Date.now() - 3 * T,
    lastLiveAt: Date.now(),
    pid: process.pid,
    title: `t-${runnerId}`,
    ...extra,
  })
  writeFileSync(
    concourseWorkersPath(daemonDir),
    JSON.stringify({
      version: 1,
      workers: {
        'concourse-w1': rec('concourse-w1', 'sess-empty-idle', {}),
        'concourse-w2': rec('concourse-w2', 'sess-with-content', {}),
        'concourse-w3': rec('concourse-w3', 'sess-empty-young', { spawnedAt: Date.now() - 1_000 }),
        'concourse-w4': rec('concourse-w4', 'sess-empty-paused', { pausedAt: Date.now() - T }),
        'concourse-w5': rec('concourse-w5', 'sess-huge-first-msg', {}),
      },
    }),
  )
  const withContent = workerTranscriptPath({ sessionId: 'sess-with-content', workspaceId: ws })
  mkdirSync(join(withContent, '..'), { recursive: true })
  writeFileSync(withContent, JSON.stringify({ type: 'user', message: { role: 'user', content: 'build the thing' } }) + '\n')
  const hugeInSweep = workerTranscriptPath({ sessionId: 'sess-huge-first-msg', workspaceId: ws })
  writeFileSync(
    hugeInSweep,
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'big paste: ' + 'x'.repeat(300 * 1024) } }) + '\n',
  )
  const killed: string[] = []
  const roster = { kill: (short: string) => (killed.push(short), true) }
  const retired = sweepIdleEmptyConcourseSessions(roster, { dir: daemonDir })
  t('exactly the empty idle worker is retired', retired.length === 1 && retired[0]!.runnerId === 'concourse-w1', JSON.stringify(retired))
  t('the retirement stops the child through the roster', killed.length === 1 && killed[0] === 'concourse-w1')
  const after = readSessionWorkers(daemonDir)
  const w1 = after['concourse-w1']!
  t('the record stays on the board as stopped with the typed retired fact', w1.stoppedAt !== undefined && w1.retired?.reason === 'idle-empty' && w1.retired.thresholdMs === T && /retired — empty and idle/.test(w1.stoppedBy ?? ''))
  t('the worker with conversation, the young one and the paused one are untouched', after['concourse-w2']!.stoppedAt === undefined && after['concourse-w3']!.stoppedAt === undefined && after['concourse-w4']!.stoppedAt === undefined)
  t('the huge-first-message session survives the sweep (truncated-window class)', after['concourse-w5']!.stoppedAt === undefined)
  t('the session list sentence derives from the fact', retiredNowLabel(w1.retired!) === `retired — empty and idle for ${(await import('../../src/utils/deadline.ts')).formatLimit(w1.retired!.idleMs)}`)
  const again = sweepIdleEmptyConcourseSessions(roster, { dir: daemonDir })
  t('a second sweep is idempotent (a retired row refuses again)', again.length === 0 && killed.length === 1)

  // The session list paints the fact: the REAL snapshot builder over the
  // same scratch records projects the retired row as stopped with the
  // retirement sentence in its NOW cell.
  const crewDir = join(SCRATCH, 'crew')
  mkdirSync(crewDir, { recursive: true })
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const { buildConcourseSnapshot } = await import('../../src/services/concourse/concourseSnapshot.ts')
  // The board is project-scoped: the seeded workspace's identity rides the
  // build (the process cwd is the repo, not ws).
  const { projectIdentity } = await import('../../src/utils/bootCardFacts.ts')
  const snapshot = await buildConcourseSnapshot({ recordsDir: daemonDir, crewDir, nowMs: Date.now(), project: projectIdentity(ws) })
  const rows = snapshot.groups.flatMap(g => g.rows.map(r => ({ group: g.id, ...r })))
  const retiredRow = rows.find(r => r.sessionId === 'sess-empty-idle')
  t('the board lists the retired session in the STOPPED group', retiredRow?.group === 'stopped' && retiredRow.state === 'stopped', JSON.stringify(retiredRow))
  t('its NOW cell carries the retirement fact', /^retired — empty and idle for /.test(retiredRow?.nowLabel ?? ''), retiredRow?.nowLabel ?? '(none)')
  const liveRow = rows.find(r => r.sessionId === 'sess-with-content')
  t('a session with conversation keeps its ordinary live row', liveRow !== undefined && liveRow.state !== 'stopped')
}

// —— 5. a pending extensions reload raises no notification ————————————————
{
  const source = readFileSync('src/hooks/useExtensions.ts', 'utf8')
  t('the pending flag reaches app state, never a notification (structural — a React effect)', /onExtensionsPending\(pending =>/.test(source) && !/key: 'extensions-pending'/.test(source))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures ? '\nFAILURES' : '\nALL GREEN')
process.exit(failures)
