#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReactNode } from 'react'
import stripAnsi from 'strip-ansi'
import { check, cleanup, finish, loadEval, makeContext, refusingBridge, section, setup, sleep, within } from './lib.js'

const checkWithFix = (label: string, cond: boolean, detail: string, fix: string): void => check(label, cond, cond ? detail : detail === '' ? fix : `${detail} — ${fix}`)
const { work } = setup()
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.MERCURY_LIVE_GLYPHS = '0'
const j = (v: unknown): string => JSON.stringify(v)
const { evalKernelManager } = await loadEval()
const { EvalTool } = await import('../../src/tools/eval/EvalTool.js')
const { renderEvalProgressMessage } = await import('../../src/tools/eval/rows.js')
type Progress = import('../../src/tools/kit/toolProgress.js').EvalToolProgress
type ProgressMessage = import('../../src/engine/message-shapes/message.js').ProgressMessage

const SLEEPING_CELL = 'import time\ntime.sleep(2.3)\n'

try {
  section('§1 THE KERNEL MANAGER — the cell\'s started mark fires with the cell\'s own budget, before the cell settles')
  {
    const marks: Array<{ atMs: number; budgetMs: number | null }> = []
    const t0 = Date.now()
    const outcome = await within(
      'the sleeping cell',
      60_000,
      evalKernelManager.runCell({
        owner: 'running-row-owner',
        cwd: work,
        input: { language: 'py', code: SLEEPING_CELL, timeoutSeconds: 60 },
        abortSignal: new AbortController().signal,
        serveBridge: refusingBridge(),
        onCellStarted: facts => marks.push({ atMs: Date.now(), ...facts }),
      }),
    )
    const settledAt = Date.now()
    check('the sleeping cell ran clean with no output', outcome.status === 'ok' && outcome.stdout.text === '' && outcome.stderr.text === '', j({ status: outcome.status, out: outcome.stdout.text }))
    checkWithFix('RED ON THE BASE: the started mark fired exactly once', marks.length === 1, j(marks), 'runCell in src/tools/engines/eval-kernels/kernelManager.ts must call the onCellStarted callback once, when the kernel has the cell')
    check('…with the cell\'s effective budget (60 s)', marks[0]?.budgetMs === 60_000, j(marks))
    check('…at least two seconds before the cell settled (the kernel had the cell from the start)', marks.length === 1 && settledAt - marks[0]!.atMs >= 2_000 && marks[0]!.atMs - t0 < settledAt - t0, j({ markAfterMs: (marks[0]?.atMs ?? 0) - t0, settledAfterMs: settledAt - t0 }))
    const unbounded = await within(
      'the unbounded cell',
      30_000,
      evalKernelManager.runCell({
        owner: 'running-row-owner',
        cwd: work,
        input: { language: 'py', code: '1 + 1', timeoutSeconds: 0 },
        abortSignal: new AbortController().signal,
        serveBridge: refusingBridge(),
        onCellStarted: facts => marks.push({ atMs: Date.now(), ...facts }),
      }),
    )
    check('a cell with no budget (timeoutSeconds 0) marks a null budget', unbounded.status === 'ok' && marks[1]?.budgetMs === null, j(marks))
  }

  section('§2 THE TOOL — a running cell with no output emits running ticks with the elapsed and the budget, every second')
  let ticks: Array<Extract<Progress, { kind: 'running' }>> = []
  let outputs = 0
  {
    const events: Progress[] = []
    const context = await makeContext({ mode: 'sovereign' })
    ;(context as { toolUseId?: string }).toolUseId = 'toolu_eval_1'
    const canUseTool = (async () => ({ behavior: 'allow', updatedInput: {} })) as never
    const t0 = Date.now()
    const result = await within(
      'the tool call',
      60_000,
      (EvalTool as unknown as { call: (input: unknown, context: unknown, canUseTool: unknown, parent: unknown, onProgress: (p: { toolUseID: string; data: Progress }) => void) => Promise<{ data: { status: string } }> }).call(
        { language: 'py', code: SLEEPING_CELL, title: 'Mutation spot-checks on a scratch copy', timeoutSeconds: 180 },
        context,
        canUseTool,
        undefined,
        p => events.push(p.data),
      ),
    )
    const settledAfter = Date.now() - t0
    ticks = events.filter((e): e is Extract<Progress, { kind: 'running' }> => e.kind === 'running')
    outputs = events.filter(e => e.kind === 'output').length
    check('the cell ran clean', result.data.status === 'ok', j(result.data.status))
    checkWithFix('RED ON THE BASE: running ticks arrived while the silent cell ran (two or more over 2.3 s)', ticks.length >= 2, j({ ticks: ticks.length, kinds: events.map(e => e.kind) }), 'call in src/tools/eval/EvalTool.ts must emit an eval_progress running tick every second while a cell runs')
    check('the first tick is the start (0 s elapsed) and the elapsed climbs, never falls', ticks[0]?.elapsedSeconds === 0 && ticks.every((t, i) => i === 0 || t.elapsedSeconds >= ticks[i - 1]!.elapsedSeconds), j(ticks.map(t => t.elapsedSeconds)))
    check('every tick carries the cell\'s budget (180 s) and the cell\'s language and title', ticks.every(t => t.budgetMs === 180_000 && t.language === 'py' && t.title === 'Mutation spot-checks on a scratch copy'), j(ticks[0]))
    check('no output event (the cell printed nothing) — the ticks are the only progress', outputs === 0, String(outputs))
    check(`the ticks stop with the cell (none later than the settle: ${settledAfter} ms)`, ticks.every(t => t.elapsedSeconds * 1000 <= settledAfter + 1000))
  }

  section('§3 THE CELL ROW — Starting kernel… only until the kernel has the cell; then running with the elapsed and the timeout')
  {
    const reactModule = (await import('react')) as typeof import('react')
    const React = reactModule.default ?? reactModule
    const { default: ScreenInstance } = await import('../../src/screen/renderer/screenInstance.js')
    const { default: instances } = await import('../../src/screen/renderer/instances.js')
    const { App } = await import('../../src/boot/App.js')
    const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.js')
    class Output extends EventEmitter {
      isTTY = true
      rows = 40
      columns = 100
      write(): boolean {
        return true
      }
    }
    class Input extends EventEmitter {
      isTTY = true
      isRaw = false
      setEncoding(): this {
        return this
      }
      setRawMode(value: boolean): this {
        this.isRaw = value
        return this
      }
      ref(): this {
        return this
      }
      unref(): this {
        return this
      }
      read(): string | null {
        return null
      }
      get readableLength(): number {
        return 0
      }
    }
    const mount = async (node: ReactNode): Promise<string> => {
      const stdout = new Output()
      const ink = new ScreenInstance({ stdout: stdout as never, stdin: new Input() as never, stderr: new Output() as never, exitOnCtrlC: false, patchConsole: false })
      instances.set(stdout as never, ink)
      ink.render(React.createElement(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined }, node as never))
      await sleep(250)
      const frame = stripAnsi(ink.lastFrameText()).split('\n').map(row => row.trimEnd()).filter(row => row !== '').join('\n')
      ink.unmount()
      instances.delete(stdout as never)
      return frame
    }
    const progress = (data: Progress): ProgressMessage => ({ type: 'progress', uuid: `p-${Math.random()}`, timestamp: new Date().toISOString(), toolUseID: 'toolu_eval_1', parentToolUseID: 'toolu_eval_1', data } as never)
    const starting = await mount(renderEvalProgressMessage([], { verbose: false }))
    checkWithFix(`no event yet: the row says the kernel is starting (${starting})`, starting.includes('Starting kernel…'), starting, 'renderEvalProgressMessage in src/tools/eval/rows.tsx must read Starting kernel… until a running tick arrives')
    const running = await mount(renderEvalProgressMessage([progress({ type: 'eval_progress', kind: 'running', elapsedSeconds: 12, budgetMs: 180_000, language: 'py' })], { verbose: false }))
    check(`RED ON THE BASE: a running tick with no output: the row reads running with the elapsed and the timeout (${running})`, running.includes('running…') && running.includes('(12s · timeout 3m)') && !running.includes('Starting kernel'), running)
    const later = await mount(renderEvalProgressMessage([progress({ type: 'eval_progress', kind: 'running', elapsedSeconds: 12, budgetMs: 180_000 }), progress({ type: 'eval_progress', kind: 'running', elapsedSeconds: 119, budgetMs: 180_000 })], { verbose: false }))
    check(`the latest tick wins: 119 s (${later})`, later.includes('(1m 59s · timeout 3m)'), later)
    const withOutput = await mount(
      renderEvalProgressMessage(
        [
          progress({ type: 'eval_progress', kind: 'running', elapsedSeconds: 3, budgetMs: 180_000 }),
          progress({ type: 'eval_progress', kind: 'output', stream: 'stdout', tail: 'test_one ok\ntest_two ok\n', language: 'py' }),
          progress({ type: 'eval_progress', kind: 'running', elapsedSeconds: 5, budgetMs: 180_000, tail: 'test_two ok' }),
        ],
        { verbose: false },
      ),
    )
    check(`output and a tick: the tail paints with the running line beneath it (${withOutput.replace(/\n/g, ' ↵ ')})`, withOutput.includes('test_one ok') && withOutput.includes('test_two ok') && withOutput.includes('running…') && withOutput.includes('(5s · timeout 3m)'), withOutput)
    const unbounded = await mount(renderEvalProgressMessage([progress({ type: 'eval_progress', kind: 'running', elapsedSeconds: 7 })], { verbose: false }))
    check(`a cell with no budget shows the elapsed alone (${unbounded})`, unbounded.includes('running…') && unbounded.includes('(7s)') && !unbounded.includes('timeout'), unbounded)
  }

  section('§4 THE DAEMON ROAD — the tick rides a tool_update row with source eval; the seat keeps it; the connector hands the cell row its tick')
  {
    const vocabulary = await import('../../src/engine/rows/vocabulary.js')
    const update = vocabulary.ToolUpdateRowSchema().safeParse({ type: 'tool_update', seq: 1, timestamp: 't', session_id: 's', call_id: 'toolu_eval_1', tick: 1, source: 'eval', elapsed_s: 12, budget_ms: 180_000 })
    check('RED ON THE BASE: the rows vocabulary admits source eval on a tool_update row', update.success, update.success ? '' : j(update.error.issues[0]))
    const { onSeatRow } = await import('../../src/daemon/session-seat/sessionSeat.js')
    const { readSessionProgress } = await import('../../src/engine/connector/seatProjections.js')
    const { updateConcourseWorkers } = await import('../../src/daemon/concourse-workers/concourseWorkers.js')
    const dir = mkdtempSync(join(tmpdir(), 'cell-running-daemon-'))
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-evalrunning1'
    const SHORT = 'concourse-ev1'
    updateConcourseWorkers(workers => {
      workers[SHORT] = { schema: 1, runnerId: SHORT, sessionId: sid, workspaceId: 'ws-ev', isolation: 'exclusive', modelKey: 'claude-opus-5', effort: 'max', spawnedAt: Date.now(), lastLiveAt: Date.now(), settingsSnapshot: { schema: 1, snapshotId: 's', sessionId: sid, profileRevision: 0, profileDigest: 'd', resolvedAt: Date.now(), rows: [] } as never, workspaceKind: 'plain-folder' } as never
    }, dir)
    const roster = { door: () => undefined, list: () => [], patchSeatModel: () => true, patchSeatEffort: () => true }
    onSeatRow(SHORT, { seq: 1, timestamp: 't', session_id: sid, turn: 1, type: 'tool_update', call_id: 'toolu_eval_1', tick: 3, source: 'eval', elapsed_s: 12, budget_ms: 180_000, line: 'test_two ok' } as never, roster as never, dir)
    await sleep(400)
    const entries = readSessionProgress(sid, dir)
    const entry = entries?.tools['toolu_eval_1']
    check('RED ON THE BASE: the seat keeps the eval tick as eval_progress with its elapsed, budget and line', entry?.dataType === 'eval_progress' && entry.elapsedTimeSeconds === 12 && entry.budgetMs === 180_000 && entry.latestLine === 'test_two ok', j(entries) + (entry?.dataType === 'eval_progress' && entry.elapsedTimeSeconds === 12 && entry.budgetMs === 180_000 && entry.latestLine === 'test_two ok' ? '' : ' — onSeatRow in src/daemon/session-seat/sessionSeat.ts must keep a tool_update row with source eval as eval_progress (elapsed, budget, line)'))
    const { LivePart } = await import('../../src/engine/connector/daemon/live.js')
    const { IDLE_LIVE } = await import('../../src/engine/connector/seatLive.js')
    const { getEphemeralProgressFrame } = await import('../../src/screen/app-state/ephemeralProgressStore.js')
    const planeBefore = process.env.MERCURY_DAEMON_DIR
    process.env.MERCURY_DAEMON_DIR = dir
    const window = new LivePart({ sessionId: () => 'proof', attached: () => false, factsBusy: () => true, work: () => [], factsTurnStartedAt: () => undefined, streamIdleTimeoutMs: () => undefined, model: () => 'the-model', anySendDelivered: () => false, redressQueuedSends: () => {}, transcriptLive: () => IDLE_LIVE, toolStartedAtMs: () => null, tailHeld: () => false, clearTail: () => {}, tailInterrupted: () => {}, tailInterruptUndone: () => {}, foldStillRuns: () => true, setLiveFold: () => {}, dropRunningFoldAtIdle: () => {}, stepTurnCompletion: () => false, syncFeedCadence: () => {}, probeCarrier: () => {}, sessionId: () => sid } as never)
    window.readProgress()
    if (planeBefore === undefined) delete process.env.MERCURY_DAEMON_DIR
    else process.env.MERCURY_DAEMON_DIR = planeBefore
    const tick = getEphemeralProgressFrame('toolu_eval_1')
    check('the connector hands the cell row a running tick rebuilt from the entry (elapsed, budget, tail)', tick?.type === 'progress' && j(tick.data) === j({ type: 'eval_progress', kind: 'running', elapsedSeconds: 12, budgetMs: 180_000, tail: 'test_two ok' }), j(tick) + (tick?.type === 'progress' && j(tick.data) === j({ type: 'eval_progress', kind: 'running', elapsedSeconds: 12, budgetMs: 180_000, tail: 'test_two ok' }) ? '' : ' — readProgress in src/engine/connector/daemon/live.ts must rebuild the running tick from the seat entry'))
  }
} finally {
  await evalKernelManager.disposeAll()
  cleanup()
}

finish('CELL RUNNING ROW')
