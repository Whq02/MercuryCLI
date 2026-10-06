#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReactNode } from 'react'
import stripAnsi from 'strip-ansi'
import { check, cleanup, finish, loadEval, makeContext, refusingBridge, section, setup, sleep, within } from './lib.js'

const { work } = setup()
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.MERCURY_LIVE_GLYPHS = '0'
const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const j = (v: unknown): string => JSON.stringify(v)
const { evalKernelManager } = await loadEval()
const { EvalTool } = await import('../../src/tools/EvalTool/EvalTool.js')
const { renderEvalProgressMessage } = await import('../../src/tools/EvalTool/UI.js')
type Progress = import('../../src/types/tools.js').EvalToolProgress
type ProgressMessage = import('../../src/types/message.js').ProgressMessage

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
    check('RED ON THE BASE: the started mark fired exactly once', marks.length === 1, j(marks))
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
    check('RED ON THE BASE: running ticks arrived while the silent cell ran (two or more over 2.3 s)', ticks.length >= 2, j({ ticks: ticks.length, kinds: events.map(e => e.kind) }))
    check('the first tick is the start (0 s elapsed) and the elapsed climbs, never falls', ticks[0]?.elapsedSeconds === 0 && ticks.every((t, i) => i === 0 || t.elapsedSeconds >= ticks[i - 1]!.elapsedSeconds), j(ticks.map(t => t.elapsedSeconds)))
    check('every tick carries the cell\'s budget (180 s) and the cell\'s language and title', ticks.every(t => t.budgetMs === 180_000 && t.language === 'py' && t.title === 'Mutation spot-checks on a scratch copy'), j(ticks[0]))
    check('no output event (the cell printed nothing) — the ticks are the only progress', outputs === 0, String(outputs))
    check(`the ticks stop with the cell (none later than the settle: ${settledAfter} ms)`, ticks.every(t => t.elapsedSeconds * 1000 <= settledAfter + 1000))
  }

  section('§3 THE CELL ROW — Starting kernel… only until the kernel has the cell; then running with the elapsed and the timeout')
  {
    const reactModule = (await import('react')) as typeof import('react')
    const React = reactModule.default ?? reactModule
    const { default: Ink } = await import('../../src/ink/ink.js')
    const { default: instances } = await import('../../src/ink/instances.js')
    const { App } = await import('../../src/components/App.js')
    const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
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
      const ink = new Ink({ stdout: stdout as never, stdin: new Input() as never, stderr: new Output() as never, exitOnCtrlC: false, patchConsole: false })
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
    check(`no event yet: the row says the kernel is starting (${starting})`, starting.includes('Starting kernel…'), starting)
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
    const vocabulary = await import('../../src/rows/vocabulary.js')
    const update = vocabulary.ToolUpdateRowSchema().safeParse({ type: 'tool_update', seq: 1, timestamp: 't', session_id: 's', call_id: 'toolu_eval_1', tick: 1, source: 'eval', elapsed_s: 12, budget_ms: 180_000 })
    check('RED ON THE BASE: the rows vocabulary admits source eval on a tool_update row', update.success, update.success ? '' : j(update.error.issues[0]))
    if (existsSync(join(ROOT, 'sdk', 'src', 'rows.ts'))) check('the generated SDK rows carry the eval source', /'shell' \| 'powershell' \| 'mcp' \| 'eval'/.test(read('sdk/src/rows.ts')))
    else console.log('  [skip] the SDK is parked and not on this tree (the published lineage carries no sdk/)')
    const turn = read('src/rows/turn.ts')
    check('the runner projects an eval running tick as a tool_update row (source eval, the elapsed and the budget)', turn.includes("source: 'eval'") && turn.includes('elapsedS: evalRunning.elapsedSeconds') && turn.includes('budgetMs: evalRunning.budgetMs'))
    const { onSeatRow } = await import('../../src/daemon/sessionSeat.js')
    const { readSessionProgress } = await import('../../src/services/engine-connector/seatProjections.js')
    const { updateConcourseWorkers } = await import('../../src/daemon/concourseWorkers.js')
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
    check('RED ON THE BASE: the seat keeps the eval tick as eval_progress with its elapsed, budget and line', entry?.dataType === 'eval_progress' && entry.elapsedTimeSeconds === 12 && entry.budgetMs === 180_000 && entry.latestLine === 'test_two ok', j(entries))
    const connector = read('src/services/engine-connector/daemonConnector.ts')
    check('the connector hands the cell row a running tick rebuilt from the entry (elapsed, budget, tail)', connector.includes("if (entry.dataType === 'eval_progress')") && connector.includes("kind: 'running'") && connector.includes('elapsedSeconds: entry.elapsedTimeSeconds ?? 0'))
  }
} finally {
  await evalKernelManager.disposeAll()
  cleanup()
}

finish('CELL RUNNING ROW')
