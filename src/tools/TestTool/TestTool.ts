// ============================================================================
//  Test tool — structured test transactions. The agent-facing
//  surface over services/ide/pythonTests: discovery, runs, failed-only
//  reruns and one-test debugging as TYPED transactions with durable
//  mercury://test/* records — never exit-code guesswork over prose output.
//
//  Python (pytest + unittest) is the first provider; the op surface is
//  deliberately language-neutral so later lanes (cargo test, ctest, gdscript
//  tests) join without a new tool. Ops that execute project code (discover
//  imports test modules; run/rerunFailed/debug execute them) are Bash-class
//  permission asks; report/list read durable records and ride free.
//
//  debug: builds the one-test shim and launches it through the SAME
//  owner-addressed Debug-session machinery as the Debug tool (session name
//  'test' by default) — no second debugger path. Two debug lanes: python
//  (debugpy, a scratch shim program) and node-test (js-debug, the test file
//  run directly under node's own anchored --test-name-pattern — the stop
//  lands in the js-debug child session). Other runners refuse naming the
//  lane. Continue stepping with the Debug tool.
//
//  Catalog gate: MERCURY_TESTS (default-on, registered).
//  Proof: scripts/ide/prove-python-tests.ts.
// ============================================================================

import { z } from 'zod/v4'
import { buildTool, type ToolEffectOutcome, type ToolUseContext } from '../../Tool.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { expandPath } from '../../utils/path.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import { createDapSession } from '../../services/dap/dapClient.js'
import {
  buildDebugTestShim,
  discoverPythonTests,
  getRun,
  latestRun,
  listRuns,
  pytestFallbackNote,
  rerunFailedTests,
  runPythonTests,
  type TestRunRecord,
} from '../../services/ide/pythonTests.js'
import {
  buildNodeTestDebugShim,
  changedRunnerSelection,
  discoverRunnerProfiles,
  rerunRunnerFailures,
  resolveTestLane,
  runRunnerProfile,
} from '../../services/ide/projectRunners.js'
import type { ToolCallProgress } from '../../Tool.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
  userFacingName,
} from './UI.js'

const OPS = ['discover', 'run', 'rerunFailed', 'debug', 'report'] as const

const inputSchema = lazySchema(() =>
  z.strictObject({
    op: z.enum(OPS).describe('The test operation to perform'),
    framework: z
      .enum(['pytest', 'unittest', 'node-test', 'vitest', 'jest', 'cargo', 'go'])
      .optional()
      .describe('Force a framework. Default: python (pytest when detected+importable, else unittest) in python projects; otherwise the single manifest-declared runner (package.json → node-test/vitest/jest · Cargo.toml → cargo · go.mod → go); an ambiguous project names its options instead of guessing'),
    path: z
      .string()
      .optional()
      .describe('run: limit to one test file/directory (a selection of one path)'),
    node: z
      .string()
      .optional()
      .describe('run: one test node id (pytest: file::test_name · unittest: module.Class.test). debug: REQUIRED — the node to debug (node-test: file::name, or a bare name the latest run\'s case rows place)'),
    changed: z
      .boolean()
      .optional()
      .describe("run: focus on the working tree's CHANGED files via the runner's own related-test machinery (vitest related · jest --findRelatedTests · changed test files for node-test/pytest · changed packages for go; cargo declines honestly)"),
    profile: z
      .string()
      .optional()
      .describe('run: an exact runner-profile id (rp-… from op:"discover") — the explicit runner/target override'),
    session: z
      .string()
      .optional()
      .describe('debug: the Debug-tool session name to create (default "test"; continue with the Debug tool)'),
    file: z.string().optional().describe('debug: source file for breakpoints'),
    lines: z
      .array(semanticNumber(z.number().int().positive()))
      .optional()
      .describe('debug: breakpoint lines in file'),
    runId: z.string().optional().describe('report: a specific run id (default: the latest run)'),
  }),
)

type SchemaType = ReturnType<typeof inputSchema>
export type Input = z.infer<SchemaType>
export type Output = {
  op: Input['op']
  result: string
  outcome: ToolEffectOutcome
  record?: TestRunRecord
}

/** The pytest-fallback honesty suffix for a discover/run answer: applied
 *  only when NO explicit framework was requested and the resolved lane is
 *  unittest — a pytest-configured project silently answering
 *  "unittest: 0 test(s)" taught nothing about why its tests vanished
 *  (pythonTests.pytestFallbackNote carries the exact why + install line). */
function fallbackNoteSuffix(explicit: string | undefined, resolved: string): string {
  if (explicit !== undefined || resolved !== 'unittest') return ''
  try {
    const note = pytestFallbackNote()
    return note ? `\n${note}` : ''
  } catch {
    return ''
  }
}

function summarize(record: TestRunRecord): string {
  const c = record.counts
  const head =
    `${record.framework} ${record.selection} — ${c.passed} passed · ${c.failed} failed · ` +
    `${c.skipped} skipped · ${c.errored} errored (${record.durationMs}ms, exit ${record.exitCode ?? 'null'})`
  const failures = record.cases
    .filter(x => x.outcome === 'failed' || x.outcome === 'errored')
    .slice(0, 10)
    .map(x => `  ${x.id}${x.file ? ` (${x.file}${x.line ? `:${x.line}` : ''})` : ''}\n    ${(x.message ?? '').split('\n').slice(-2).join(' · ').slice(0, 200)}`)
  return [
    `ran: ${record.command.join(' ')}`,
    head,
    ...(failures.length ? ['failures:', ...failures] : []),
    ...(record.verdictNote ? [`NOTE: ${record.verdictNote}`] : []),
    ...(record.diagnosticsNote ? [`diagnostics: ${record.diagnosticsNote}`] : []),
    `record: mercury://test/run/${record.id}${record.outputArtifactRef ? ` · full output: ${record.outputArtifactRef}` : ''}`,
  ].join('\n')
}

// Family 3: streamed bounded progress — one throttled status line
// while the runner is live (never a second executor; the seam is the
// runner's own output stream).
function runnerProgress(
  runner: string,
  onProgress: ToolCallProgress | undefined,
): ((view: { tail: string; lines: number }, elapsedMs: number) => void) | undefined {
  if (!onProgress) return undefined
  let lastEmit = 0
  let seq = 0
  return (view, elapsedMs) => {
    if (elapsedMs - lastEmit < 2_000) return
    lastEmit = elapsedMs
    const lastLine = view.tail
      .split('\n')
      .reverse()
      .find(l => l.trim().length > 0) ?? ''
    onProgress({
      toolUseID: `test-progress-${seq++}`,
      data: {
        type: 'test_progress',
        line: `${runner} · ${Math.round(elapsedMs / 1000)}s · ${view.lines} output line(s) · ${lastLine.trim().slice(0, 80)}`,
        elapsedTimeSeconds: Math.round(elapsedMs / 1000),
      },
    })
  }
}

// Discover/run through the polyglot runner registry (records land
// in the SAME durable store — mercury://test/report/rerun serve them as-is).
async function runRunnerOp(
  input: Input,
  profile: import('../../services/ide/projectRunners.js').RunnerProfile,
  signal: AbortSignal | undefined,
  onProgress?: ToolCallProgress,
): Promise<{ result: string; outcome: ToolEffectOutcome; record?: TestRunRecord }> {
  if (input.op === 'discover') {
    const { profiles } = discoverRunnerProfiles()
    const lines = profiles.map(p =>
      `${p.id} [${p.runner}/${p.kind}] ${p.title}` +
      (p.availability.state === 'ok' ? '' : ` — UNAVAILABLE: ${p.availability.reason} (remedy: ${p.availability.remedy})`),
    )
    return {
      result: lines.length
        ? `runner profiles (manifest-driven):\n${lines.join('\n')}`
        : 'no runner profiles discovered from this project\'s manifests',
      outcome: 'no-change',
    }
  }
  // op === 'run'
  const onOutput = runnerProgress(profile.runner, onProgress)
  // changed-file-focused runs via the runner's OWN machinery.
  if (input.changed) {
    const sel = changedRunnerSelection(profile)
    if (sel.state === 'unavailable') {
      return { result: `changed-file selection unavailable: ${sel.reason}\nremedy: ${sel.remedy}`, outcome: 'failed' }
    }
    const out = await runRunnerProfile(profile, {
      argvOverride: sel.argv,
      selectionLabel: `changed (${sel.changedCount} target(s))`,
      ...(onOutput ? { onOutput } : {}),
      ...(signal ? { signal } : {}),
    })
    if (out.state === 'unavailable') {
      return { result: `test run unavailable: ${out.reason}\nremedy: ${out.remedy}`, outcome: 'failed' }
    }
    if (out.state === 'stale-profile') {
      return { result: `stale profile: ${out.reason}`, outcome: 'failed' }
    }
    return {
      result: summarize(out.record),
      outcome: out.record.counts.failed === 0 && out.record.counts.errored === 0 && out.record.exitCode === 0 ? 'succeeded' : 'failed',
      record: out.record,
    }
  }
  const selection = input.node ?? (input.path ? expandPath(input.path) : undefined)
  const label = input.node ? `nodes:${input.node}` : input.path ? `file:${input.path}` : 'all'
  const out = await runRunnerProfile(profile, {
    ...(selection !== undefined ? { selection, selectionLabel: label } : {}),
    ...(onOutput ? { onOutput } : {}),
    ...(signal ? { signal } : {}),
  })
  if (out.state === 'unavailable') {
    return { result: `test run unavailable: ${out.reason}\nremedy: ${out.remedy}`, outcome: 'failed' }
  }
  if (out.state === 'stale-profile') {
    return { result: `stale profile: ${out.reason}`, outcome: 'failed' }
  }
  return {
    result: summarize(out.record),
    outcome: out.record.counts.failed === 0 && out.record.counts.errored === 0 && out.record.exitCode === 0 ? 'succeeded' : 'failed',
    record: out.record,
  }
}

async function runOp(
  input: Input,
  context: ToolUseContext,
  onProgress?: ToolCallProgress,
): Promise<{ result: string; outcome: ToolEffectOutcome; record?: TestRunRecord }> {
  const signal = context.abortController?.signal
  // an exact profile id is the EXPLICIT runner/target override —
  // it wins over lane resolution.
  if (input.profile && input.op === 'run') {
    const { profiles } = discoverRunnerProfiles()
    const found = profiles.find(p => p.id === input.profile)
    if (!found) {
      return {
        result: `no runner profile '${input.profile}' in the current discovery${profiles.length ? ` — discovered: ${profiles.map(p => `${p.id} [${p.runner}/${p.kind}]`).join(', ')}` : ''}`,
        outcome: 'failed',
      }
    }
    if (found.kind !== 'test') {
      return {
        result: `profile '${input.profile}' is a ${found.kind} profile — run builds/checks with the Launch tool`,
        outcome: 'failed',
      }
    }
    return runRunnerOp(input, found, signal, onProgress)
  }
  // Route by lane FIRST — explicit frameworks win, python signals
  // keep the exact pre-S3 default, a single discovered runner routes there,
  // ambiguity NAMES the options.
  const lane = resolveTestLane(getCwd(), input.framework)
  if (lane.lane === 'ambiguous' && (input.op === 'discover' || input.op === 'run')) {
    return {
      result: `this project declares multiple test runners: ${lane.options.join(', ')} — pass framework: to pick one`,
      outcome: 'no-change',
    }
  }
  if (lane.lane === 'runner-missing' && (input.op === 'discover' || input.op === 'run')) {
    const { profiles } = discoverRunnerProfiles()
    return {
      result: `no ${lane.runner} test profile in this project's manifests${profiles.length ? ` — discovered: ${profiles.map(p => `${p.runner}/${p.kind}`).join(', ')}` : ''}`,
      outcome: 'failed',
    }
  }
  if (lane.lane === 'runner' && (input.op === 'discover' || input.op === 'run')) {
    return runRunnerOp(input, lane.profile, signal, onProgress)
  }
  // rerunFailed follows the LATEST RECORD's framework (one store, one truth)
  if (input.op === 'rerunFailed') {
    const latest = latestRun()
    if (latest && latest.framework !== 'pytest' && latest.framework !== 'unittest') {
      const out = await rerunRunnerFailures(latest, { ...(signal ? { signal } : {}) })
      if (out.state === 'unavailable') {
        return { result: `rerun unavailable: ${out.reason}\nremedy: ${out.remedy}`, outcome: 'failed' }
      }
      if (out.state === 'stale-profile') {
        return { result: `rerun unavailable: ${out.reason}`, outcome: 'failed' }
      }
      return {
        result: summarize(out.record),
        outcome: out.record.counts.failed === 0 && out.record.exitCode === 0 ? 'succeeded' : 'failed',
        record: out.record,
      }
    }
  }
  switch (input.op) {
    case 'discover': {
      const out = await discoverPythonTests({
        ...(input.framework === 'pytest' || input.framework === 'unittest' ? { framework: input.framework } : {}),
        ...(signal ? { signal } : {}),
      })
      if ('state' in out) {
        return { result: `test discovery unavailable: ${out.reason}\nremedy: ${out.remedy}`, outcome: 'failed' }
      }
      const lines = out.tests.slice(0, 100)
      return {
        result:
          `${out.framework}: ${out.tests.length} test(s)${out.truncated ? ` (+${out.truncated} truncated)` : ''}` +
          fallbackNoteSuffix(input.framework, out.framework) +
          (out.collectErrors.length ? `\ncollect errors:\n${out.collectErrors.map(e => `  ${e}`).join('\n')}` : '') +
          (lines.length ? `\n${lines.join('\n')}${out.tests.length > lines.length ? `\n(+${out.tests.length - lines.length} more)` : ''}` : ''),
        outcome: 'no-change',
      }
    }
    case 'run': {
      // the python lane's changed-file focus = the changed test
      // files exactly (bounded, honest when none).
      if (input.changed) {
        const { gitStatus } = await import('../../services/gitGraph/observe.js')
        const s = gitStatus(getCwd())
        if ('state' in s) {
          return { result: `changed-file selection unavailable: ${s.note}`, outcome: 'failed' }
        }
        const testFiles = s.files.map(f => f.path).filter(p => /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(p))
        if (testFiles.length === 0) {
          return {
            result: 'changed-file selection: no changed test_*.py/_test.py files — run the full suite or pass path/node',
            outcome: 'no-change',
          }
        }
        const out = await runPythonTests({
          selection: testFiles,
          selectionLabel: `changed (${testFiles.length} file(s))`,
          ...(input.framework === 'pytest' || input.framework === 'unittest' ? { framework: input.framework } : {}),
          ...(signal ? { signal } : {}),
        })
        if (out.state === 'unavailable') {
          return { result: `test run unavailable: ${out.reason}\nremedy: ${out.remedy}`, outcome: 'failed' }
        }
        return {
          result: summarize(out.record) + fallbackNoteSuffix(input.framework, out.record.framework),
          outcome: out.record.failures.length === 0 && !out.record.verdictNote ? 'succeeded' : 'failed',
          record: out.record,
        }
      }
      const selection = input.node ? [input.node] : input.path ? [expandPath(input.path)] : []
      const label = input.node ? `nodes:${input.node}` : input.path ? `file:${input.path}` : 'all'
      const out = await runPythonTests({
        selection,
        selectionLabel: label,
        ...(input.framework === 'pytest' || input.framework === 'unittest' ? { framework: input.framework } : {}),
        ...(signal ? { signal } : {}),
      })
      if (out.state === 'unavailable') {
        return { result: `test run unavailable: ${out.reason}\nremedy: ${out.remedy}`, outcome: 'failed' }
      }
      return {
        result: summarize(out.record) + fallbackNoteSuffix(input.framework, out.record.framework),
        outcome: out.record.failures.length === 0 && !out.record.verdictNote ? 'succeeded' : 'failed',
        record: out.record,
      }
    }
    case 'rerunFailed': {
      const out = await rerunFailedTests({ ...(signal ? { signal } : {}) })
      if ('note' in out) return { result: out.note, outcome: 'no-change' }
      if (out.state === 'unavailable') {
        return { result: `rerun unavailable: ${out.reason}\nremedy: ${out.remedy}`, outcome: 'failed' }
      }
      return {
        result: summarize(out.record),
        outcome: out.record.failures.length === 0 && !out.record.verdictNote ? 'succeeded' : 'failed',
        record: out.record,
      }
    }
    case 'debug': {
      if (!input.node) return { result: 'debug needs node (the test id to debug)', outcome: 'failed' }
      // debug routes BY LANE like run: node-test rides the js arm below;
      // runners whose debug home is a future lane refuse NAMING the lane
      // (the honest degrade — run/rerunFailed already cover them); python
      // falls through to its unchanged arm.
      const debugLane = resolveTestLane(getCwd(), input.framework)
      if (debugLane.lane === 'ambiguous') {
        return { result: `this project declares multiple test runners: ${debugLane.options.join(', ')} — pass framework: to pick one`, outcome: 'no-change' }
      }
      if (debugLane.lane === 'runner-missing') {
        return { result: `no ${debugLane.runner} test profile in this project's manifests`, outcome: 'failed' }
      }
      if (debugLane.lane === 'runner' && debugLane.profile.runner !== 'node-test') {
        return {
          result: `debug is not grown for ${debugLane.profile.runner} yet — the debug lanes are python (pytest/unittest) and node-test (js-debug); run/rerunFailed cover ${debugLane.profile.runner}`,
          outcome: 'failed',
        }
      }
      if (debugLane.lane === 'runner') {
        // node-test: the js shim — no scratch program; node runs the test
        // file directly with the anchored name filter as a runtime flag,
        // and the stop lands in the js-debug CHILD session.
        const jsShim = buildNodeTestDebugShim(input.node, {})
        if ('state' in jsShim) {
          return { result: `debug unavailable: ${jsShim.reason}\nremedy: ${jsShim.remedy}`, outcome: 'failed' }
        }
        const jsOwner = ownerFromToolUseContext(context)
        const jsSessionId = input.session ?? 'test'
        const jsBreakpoints = new Map<string, number[]>()
        if (input.file && input.lines?.length) {
          jsBreakpoints.set(expandPath(input.file), input.lines)
        }
        let jsSession
        try {
          jsSession = await createDapSession({
            owner: jsOwner,
            id: jsSessionId,
            adapterKey: 'js',
            program: jsShim.program,
            runtimeArgs: jsShim.runtimeArgs,
            cwd: jsShim.cwd,
            breakpoints: jsBreakpoints.size ? jsBreakpoints : undefined,
            stopOnEntry: jsBreakpoints.size === 0,
          })
        } catch (err) {
          // The resolver ladder's availability truth (js-debug absent or
          // dormant) and launch failures answer typed — never a thrown
          // tool error.
          return { result: `debug unavailable: ${err instanceof Error ? err.message : String(err)}`, outcome: 'failed' }
        }
        const jsStop = await jsSession.waitForStopOutcome(20_000)
        const jsState =
          jsStop.state === 'stopped'
            ? `stopped in '${jsStop.session.label}' — reason ${jsStop.info.reason}${jsStop.info.threadId !== undefined ? `, threadId ${jsStop.info.threadId}` : ''}`
            : jsStop.state === 'terminated'
              ? `debuggee terminated before any stop (${jsSession.exitDetail || 'clean exit'}) — the test may have run to completion`
              : 'still running (no stop within 20s) — inspect with the Debug tool'
        return {
          result:
            `debugging ${input.node} (node-test) in Debug session '${jsSessionId}': ${jsState}\n` +
            `continue with the Debug tool (op:"stack"/"scopes"/"variables"/"continue"; finish with op:"disconnect", session "${jsSessionId}")`,
          outcome: 'succeeded',
        }
      }
      const shim = buildDebugTestShim(input.node, {
        ...(input.framework === 'pytest' || input.framework === 'unittest' ? { framework: input.framework } : {}),
      })
      if ('state' in shim) {
        return { result: `debug unavailable: ${shim.reason}\nremedy: ${shim.remedy}`, outcome: 'failed' }
      }
      const owner = ownerFromToolUseContext(context)
      const sessionId = input.session ?? 'test'
      const breakpoints = new Map<string, number[]>()
      if (input.file && input.lines?.length) {
        breakpoints.set(expandPath(input.file), input.lines)
      }
      const session = await createDapSession({
        owner,
        id: sessionId,
        adapterKey: 'python',
        program: shim.program,
        cwd: shim.cwd,
        breakpoints: breakpoints.size ? breakpoints : undefined,
        stopOnEntry: breakpoints.size === 0,
      })
      const stop = await session.waitForStopOutcome(20_000)
      const state =
        stop.state === 'stopped'
          ? `stopped — reason ${stop.info.reason}${stop.info.threadId !== undefined ? `, threadId ${stop.info.threadId}` : ''}`
          : stop.state === 'terminated'
            ? `debuggee terminated before any stop (${session.exitDetail || 'clean exit'}) — the test may have run to completion`
            : 'still running (no stop within 20s) — inspect with the Debug tool'
      return {
        result:
          `debugging ${input.node} (${shim.framework}) in Debug session '${sessionId}': ${state}\n` +
          `continue with the Debug tool (op:"stack"/"scopes"/"variables"/"continue"; finish with op:"disconnect", session "${sessionId}")`,
        outcome: 'succeeded',
      }
    }
    case 'report': {
      const record = input.runId ? getRun(input.runId) : latestRun()
      if (!record) {
        const runs = listRuns()
        return {
          result: runs.length
            ? `no such run. recent: ${runs.map(r => r.id).slice(0, 8).join(', ')}`
            : 'no recorded test runs yet — op:"run" first',
          outcome: 'no-change',
        }
      }
      return { result: summarize(record), outcome: 'no-change', record }
    }
  }
}

export const TestTool = buildTool({
  name: 'Test',
  searchHint:
    'structured test runs: discover, run, rerun failed, run the relevant tests for your changes (changed-file focus), debug one test (pytest/unittest · node-test/vitest/jest · cargo · go; durable mercury://test records)',
  maxResultSizeChars: 60_000,
  async description() {
    return 'Run project tests as structured transactions: discover, run, rerun failures, debug one test'
  },
  async prompt() {
    return `Run project tests as STRUCTURED transactions (Python: pytest/unittest — the framework is auto-resolved from the project and the shared interpreter; results come from framework-level records, never parsed prose).

Operations:
1. op:"discover" — list test node ids (pytest: file::test · unittest: module.Class.test) or the manifest-declared runner profiles (rp-…). Collect errors are reported, never hidden.
2. op:"run" — the whole suite, one file (path), one node (node), the CHANGED-file focus (changed:true — the runner's own related-test machinery: vitest related · jest --findRelatedTests · changed test files for node-test/pytest · changed packages for go; cargo declines honestly), or an exact profile (profile:"rp-…" — the explicit runner override). The permission ask shows the EXACT resolved argv before anything executes; long runs stream a bounded live status line. Returns the ran argv + counts + typed failure locations (file:line + test name) + available LSP diagnostics + a durable record (mercury://test/run/<id>; mercury://test/latest and /failures always point at the newest truth). Full output spills to an artifact ref.
3. op:"rerunFailed" — re-run EXACTLY the failures recorded by the latest run.
4. op:"debug" — debug ONE test (node required) under the real debugger for its lane (python: debugpy · node-test: js-debug, node spelled file::name or a bare name from the latest run; other runners refuse naming the lane): pass file+lines for breakpoints inside the test/code under test; the call reports the first stop and leaves Debug session "test" open — continue with the Debug tool (stack/scopes/variables/continue, then disconnect).
5. op:"report" — the latest (or runId) durable record.

A run whose exit code disagrees with its structured records says so (verdictNote) — trust the records. Prefer run→fix→rerunFailed loops over re-running the whole suite.`
  },
  userFacingName,
  shouldDefer: true,
  get inputSchema(): SchemaType {
    return inputSchema()
  },
  isConcurrencySafe() {
    return false // one test run at a time — runs mutate the durable latest record
  },
  isReadOnly(input: Input) {
    return input?.op === 'report'
  },
  async checkPermissions(input: Input) {
    // Everything except report EXECUTES project code (discovery imports test
    // modules) — Bash-class ask, like Debug launch.
    if (input.op === 'report') {
      return { behavior: 'allow' as const, updatedInput: input }
    }
    // the exact resolved runner + argv shows BEFORE execution.
    let resolved = ''
    if (input.op === 'run') {
      try {
        const { profiles } = discoverRunnerProfiles()
        const profile = input.profile
          ? profiles.find(p => p.id === input.profile)
          : (() => {
              const lane = resolveTestLane(getCwd(), input.framework)
              return lane.lane === 'runner' ? lane.profile : undefined
            })()
        if (profile) {
          if (input.changed) {
            // The changed set resolves AT EXECUTION (running git status +
            // per-file digests on the ask path would be both slow and a
            // consent-fidelity overclaim — the tree can move between ask
            // and grant). The ask names the runner and the focus mode.
            resolved = ` — will run: ${profile.command.join(' ')} + changed-file focus (targets resolve against the tree at execution)`
          } else {
            const extra = input.node
              ? profile.selection === 'node-pattern'
                ? ` --test-name-pattern ${input.node}`
                : ` ${input.node}`
              : input.path
                ? ` ${input.path}`
                : ''
            resolved = ` — will run: ${profile.command.join(' ')}${extra}`
          }
        } else if (!input.profile) {
          resolved = ' (python lane: the shared project interpreter)'
        }
      } catch {
        /* the ask still shows — resolution detail is additive */
      }
    }
    return {
      behavior: 'ask' as const,
      message: `Test ${input.op}${input.node ? `: ${input.node}` : input.path ? `: ${input.path}` : input.changed ? ': changed files' : ''}${resolved || ' (runs project test code)'}`,
    }
  },
  toAutoClassifierInput(input: Input) {
    return `test ${input.op}: ${input.node ?? input.path ?? 'all'}`
  },
  async validateInput(input: Input) {
    if (input.op === 'debug' && !input.node) {
      return { result: false as const, message: 'debug requires node (the test id)', errorCode: 1 }
    }
    return { result: true as const }
  },
  async call(input: Input, context: ToolUseContext, _canUseTool, _parentMessage, onProgress) {
    const startedAt = Date.now()
    let op: { result: string; outcome: ToolEffectOutcome; record?: TestRunRecord }
    try {
      op = await runOp(input, context, onProgress)
    } catch (err) {
      op = { result: `${input.op} failed: ${(err as Error).message}`, outcome: 'failed' }
    }
    const output: Output = {
      op: input.op,
      result: op.result,
      outcome: op.outcome,
      ...(op.record ? { record: op.record } : {}),
    }
    return {
      data: output,
      effect: {
        outcome: op.outcome,
        operation: `test.${input.op}`,
        changedPaths: [],
        evidence: op.result.split('\n')[0]?.slice(0, 160) ?? '',
        startedAt,
        completedAt: Date.now(),
        ...(op.record
          ? {
              details: {
                testRun: {
                  id: op.record.id,
                  framework: op.record.framework,
                  counts: op.record.counts,
                  failures: op.record.failures.slice(0, 20),
                },
              },
            }
          : {}),
      },
    }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseId: string) {
    return {
      tool_use_id: toolUseId,
      type: 'tool_result' as const,
      content: output.result,
    }
  },
  renderToolUseMessage,
  renderToolUseErrorMessage,
  renderToolUseProgressMessage,
  renderToolResultMessage,
  // HZ7 projection: the renderer paints `result` (run summaries, failures)
  // — search indexes the same.
  extractSearchText({ result }) {
    return result
  },
})

/** Catalog gate for tools.ts — default-on, flag-killable (MERCURY_TESTS=0). */
export { pythonTestsEnabled as isTestToolCatalogEnabled } from '../../services/ide/pythonTests.js'
