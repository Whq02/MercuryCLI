
import { existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod/v4'
import { buildTool, type ToolEffectOutcome, type ToolUseContext } from '../../Tool.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { expandPath } from '../../utils/path.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import { createDapSession, type DapBreakpointSpec } from '../../services/dap/dapClient.js'
import {
  buildDebugTestShim,
  discoverPythonTests,
  getRun,
  latestRun,
  listRuns,
  noMatchRerunNote,
  pytestFallbackNote,
  rerunFailedTests,
  runPythonTests,
  type TestRunRecord,
} from '../../services/ide/pythonTests.js'
import {
  buildNodeTestDebugShim,
  changedRunnerSelection,
  discoverRunnerProfiles,
  discoverSubPackages,
  findRunnerRoot,
  rerunRunnerFailures,
  resolveTestLane,
  runRunnerProfile,
  subPackageTestRunners,
  type SubPackage,
  type TestLane,
} from '../../services/ide/projectRunners.js'
import { findPythonProjectRoot } from '../../services/ide/pythonProject.js'
import { buildCargoTestDebugPlan, buildGoTestDebugPlan, buildNodeRunnerDebugShim } from '../../services/ide/testDebugPlans.js'
import type { ToolCallProgress } from '../../Tool.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
  userFacingName,
} from './UI.js'

const OPS = ['discover', 'run', 'rerunFailed', 'debug', 'report'] as const

function debuggerMissingLine(debuggerMissing: string, remedy: string): string {
  return `no ${debuggerMissing} on this machine — ${remedy}; the test ran without a stop`
}

const DEBUGGER_WORDS: Record<string, string> = {
  python: 'Python debugger (debugpy)',
  js: 'js-debug adapter',
  go: 'Go debugger (dlv)',
  lldb: 'native debugger (lldb-dap or gdb 14+)',
  gdb: 'native debugger (lldb-dap or gdb 14+)',
}

function adapterUnavailable(err: unknown): { debuggerMissing: string; remedy: string } | null {
  const message = err instanceof Error ? err.message : String(err)
  const match = /^adapter '([^']+)' is unavailable: ([\s\S]*)$/.exec(message)
  if (match === null) return null
  const key = match[1] as string
  const words = match[2] as string
  const dash = words.lastIndexOf(' — ')
  const remedy = (dash === -1 ? words : words.slice(dash + 3)).trim()
  const debuggerMissing = DEBUGGER_WORDS[key] ?? `${key} debug adapter`
  const spelled = key === 'python' && /pip install debugpy/.test(remedy) && !/py -m pip/.test(remedy) ? `${remedy} (or py -m pip install debugpy)` : remedy
  return { debuggerMissing, remedy: spelled }
}

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
      .describe('run: limit to one test file/directory (a selection of one path). A file or folder outside the session project names another project: discover, run, rerunFailed, debug and report then read the project that path lies in (its nearest manifest or Python root) and say which they read'),
    node: z
      .string()
      .optional()
      .describe('run: one test node id (pytest: file::test_name · unittest: module.Class.test). debug: required — the test to debug (node-test, vitest, jest: file::name, or a bare name the latest run\'s case rows place · go: TestName, TestName/subtest or dir::TestName · cargo: module::path::test_name)'),
    changed: z
      .boolean()
      .optional()
      .describe("run: focus on the working tree's changed files via the runner's own related-test machinery (vitest related · jest --findRelatedTests · changed test files for node-test/pytest · changed packages for go; cargo declines honestly)"),
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

function fallbackNoteSuffix(explicit: string | undefined, resolved: string, from: string, record?: TestRunRecord, uncollected?: readonly string[]): string {
  if (explicit !== undefined || resolved !== 'unittest' || record?.verdict === 'zero-run' || record?.verdict === 'uncollected') return ''
  try {
    const note = pytestFallbackNote(from, uncollected)
    return note ? `\n${note}` : ''
  } catch {
    return ''
  }
}

type Anchor = { from: string; root: string; selection: string | undefined; outside: boolean }

function isUnder(target: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function projectRootOf(dir: string): string {
  return findRunnerRoot(dir) ?? findPythonProjectRoot(dir).root
}

function anchorOf(input: Pick<Input, 'path'>): Anchor {
  const here = resolve(getCwd())
  if (input.path === undefined) return { from: here, root: projectRootOf(here), selection: undefined, outside: false }
  const target = expandPath(input.path)
  const sessionRoot = projectRootOf(here)
  if (isUnder(target, here) || isUnder(target, sessionRoot)) return { from: here, root: sessionRoot, selection: target, outside: false }
  const dir = isDirectory(target) ? target : dirname(target)
  const root = projectRootOf(dir)
  return { from: dir, root, selection: resolve(target) === resolve(root) ? undefined : target, outside: true }
}

function projectNoun(anchor: Anchor): string {
  return anchor.outside ? anchor.root : 'this project'
}

function ranIn(record: TestRunRecord): string {
  const here = resolve(getCwd())
  const there = resolve(record.cwd)
  if (there === here) return ''
  const rel = relative(here, there)
  return rel.startsWith('..') || isAbsolute(rel) ? ` (in ${there})` : ` (in ${rel.split(sep).join('/')}/)`
}

function summarize(record: TestRunRecord): string {
  const c = record.counts
  const counts = `${c.passed} passed · ${c.failed} failed · ${c.skipped} skipped · ${c.errored} errored (${record.durationMs}ms, exit ${record.exitCode ?? 'null'})`
  const noMatch = record.verdict === 'no-match' || record.verdict === 'zero-run'
  const head =
    record.verdict === 'zero-run'
      ? record.verdictNote ?? `test files found, the ${record.framework} lane ran 0`
      : noMatch
        ? `${record.framework} ${record.verdictNote ?? `no test matched ${record.selection}`}`
        : `${record.framework} ${record.selection} — ${counts}`
  const failures = record.cases
    .filter(x => x.outcome === 'failed' || x.outcome === 'errored')
    .slice(0, 10)
    .map(x => `  ${x.id}${x.file ? ` (${x.file}${x.line ? `:${x.line}` : ''})` : ''}\n    ${(x.message ?? '').split('\n').slice(-2).join(' · ').slice(0, 200)}`)
  return [
    `ran: ${record.command.join(' ')}${ranIn(record)}`,
    head,
    ...(noMatch ? [`counts: ${counts}`] : []),
    ...(failures.length ? ['failures:', ...failures] : []),
    ...(record.verdictNote && !noMatch ? [`NOTE: ${record.verdictNote}`] : []),
    ...(record.diagnosticsNote ? [`diagnostics: ${record.diagnosticsNote}`] : []),
    `record: mercury://test/run/${record.id}${record.outputArtifactRef ? ` · full output: ${record.outputArtifactRef}` : ''}`,
  ].join('\n')
}

function outcomeOf(record: TestRunRecord, ran: () => ToolEffectOutcome): ToolEffectOutcome {
  if (record.verdict === 'zero-run') return 'failed'
  return record.verdict === 'no-match' ? 'no-change' : ran()
}

function subPackageList(packages: readonly SubPackage[]): string {
  return packages
    .map(s => {
      const runners = subPackageTestRunners(s)
      return `${s.dir}/ (${s.manifests.join(', ')}${runners.length ? `: ${runners.join(', ')}` : ', no test runner declared'})`
    })
    .join(', ')
}

function subPackageWords(lane: Extract<TestLane, { lane: 'sub-packages' }>, anchor: Anchor): string {
  return lane.runner !== undefined
    ? `${lane.runner} is declared in more than one package below ${anchor.outside ? anchor.root : 'this root'} — ${subPackageList(lane.packages)} — run from the package`
    : `${projectNoun(anchor)} declares its manifests one level down — ${subPackageList(lane.packages)} — pass framework: to pick one, or run from the package`
}

function runnerMissingWords(lane: Extract<TestLane, { lane: 'runner-missing' }>, anchor: Anchor): string {
  const { profiles } = discoverRunnerProfiles(anchor.from)
  const here = profiles.length ? ` — discovered: ${profiles.map(p => `${p.runner}/${p.kind}`).join(', ')}` : ''
  const below = lane.below !== undefined ? ` — one level down: ${subPackageList(lane.below)}` : ''
  return `no ${lane.runner} test profile in ${projectNoun(anchor)}'s manifests${here}${below}`
}

function ambiguousWords(lane: Extract<TestLane, { lane: 'ambiguous' }>, anchor: Anchor): string {
  return `${projectNoun(anchor)} declares multiple test runners: ${lane.options.join(', ')} — pass framework: to pick one`
}

function latestRunHere(from: string): TestRunRecord | null {
  const own = latestRun(from)
  if (own !== null || findRunnerRoot(from) !== null) return own
  let newest: TestRunRecord | null = null
  for (const sub of discoverSubPackages(from)) {
    const record = latestRun(resolve(from, sub.dir))
    if (record !== null && (newest === null || record.startedAt > newest.startedAt)) newest = record
  }
  return newest
}

function runHere(id: string, from: string): TestRunRecord | null {
  const own = getRun(id, from)
  if (own !== null || findRunnerRoot(from) !== null) return own
  for (const sub of discoverSubPackages(from)) {
    const record = getRun(id, resolve(from, sub.dir))
    if (record !== null) return record
  }
  return null
}

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

async function runRunnerOp(
  input: Input,
  anchor: Anchor,
  profile: import('../../services/ide/projectRunners.js').RunnerProfile,
  signal: AbortSignal | undefined,
  onProgress?: ToolCallProgress,
): Promise<{ result: string; outcome: ToolEffectOutcome; record?: TestRunRecord }> {
  if (input.op === 'discover') {
    const rel = relative(resolve(anchor.from), resolve(profile.root))
    const below = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? `${rel.split(sep).join('/')}/` : null
    const where = anchor.outside ? resolve(profile.root) : below
    const { profiles } = discoverRunnerProfiles(below === null ? anchor.from : profile.root)
    const lines = profiles.map(p =>
      `${p.id} [${p.runner}/${p.kind}] ${p.title}` +
      (p.availability.state === 'ok' ? '' : ` — UNAVAILABLE: ${p.availability.reason} (remedy: ${p.availability.remedy})`) +
      (where === null ? '' : ` — in ${where}`),
    )
    return {
      result: lines.length
        ? `runner profiles (${where === null ? 'manifest-driven' : below !== null && !anchor.outside ? `one level down, in ${where}` : `in ${where}`}):\n${lines.join('\n')}`
        : `no runner profiles discovered from ${projectNoun(anchor)}'s manifests`,
      outcome: 'no-change',
    }
  }
  const onOutput = runnerProgress(profile.runner, onProgress)
  if (input.changed) {
    const sel = changedRunnerSelection(profile)
    if (sel.state === 'unavailable') {
      return { result: `changed-file selection unavailable: ${sel.reason}\nremedy: ${sel.remedy}`, outcome: 'failed' }
    }
    const out = await runRunnerProfile(profile, {
      from: anchor.from,
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
      outcome: outcomeOf(out.record, () => (out.record.counts.failed === 0 && out.record.counts.errored === 0 && out.record.exitCode === 0 ? 'succeeded' : 'failed')),
      record: out.record,
    }
  }
  const selection = input.node ?? anchor.selection
  const label = input.node ? `nodes:${input.node}` : anchor.selection !== undefined ? `file:${input.path}` : 'all'
  const out = await runRunnerProfile(profile, {
    from: anchor.from,
    ...(selection !== undefined ? { selection, selectionKind: input.node ? ('node' as const) : ('path' as const), selectionLabel: label } : {}),
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
    outcome: outcomeOf(out.record, () => (out.record.counts.failed === 0 && out.record.counts.errored === 0 && out.record.exitCode === 0 ? 'succeeded' : 'failed')),
    record: out.record,
  }
}

async function runOp(
  input: Input,
  context: ToolUseContext,
  onProgress?: ToolCallProgress,
): Promise<{ result: string; outcome: ToolEffectOutcome; record?: TestRunRecord }> {
  const signal = context.abortController?.signal
  const anchor = anchorOf(input)
  if (input.profile && input.op === 'run') {
    const { profiles } = discoverRunnerProfiles(anchor.from)
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
    return runRunnerOp(input, anchor, found, signal, onProgress)
  }
  const lane = resolveTestLane(anchor.from, input.framework)
  if (lane.lane === 'ambiguous' && (input.op === 'discover' || input.op === 'run')) {
    return { result: ambiguousWords(lane, anchor), outcome: 'no-change' }
  }
  if (lane.lane === 'sub-packages' && (input.op === 'discover' || input.op === 'run')) {
    return { result: subPackageWords(lane, anchor), outcome: 'no-change' }
  }
  if (lane.lane === 'runner-missing' && (input.op === 'discover' || input.op === 'run')) {
    return { result: runnerMissingWords(lane, anchor), outcome: 'failed' }
  }
  if (lane.lane === 'runner' && (input.op === 'discover' || input.op === 'run')) {
    return runRunnerOp(input, anchor, lane.profile, signal, onProgress)
  }
  let pythonRecordBelow: string | undefined
  if (input.op === 'rerunFailed') {
    const latest = latestRunHere(anchor.from)
    if (latest && (latest.framework === 'pytest' || latest.framework === 'unittest') && resolve(latest.cwd) !== resolve(anchor.from)) {
      pythonRecordBelow = latest.cwd
    }
    if (latest && latest.framework !== 'pytest' && latest.framework !== 'unittest') {
      if (latest.verdict === 'no-match') return { result: noMatchRerunNote(latest), outcome: 'no-change' }
      const out = await rerunRunnerFailures(latest, { ...(signal ? { signal } : {}) })
      if (out.state === 'unavailable') {
        return { result: `rerun unavailable: ${out.reason}\nremedy: ${out.remedy}`, outcome: 'failed' }
      }
      if (out.state === 'stale-profile') {
        return { result: `rerun unavailable: ${out.reason}`, outcome: 'failed' }
      }
      return {
        result: summarize(out.record),
        outcome: outcomeOf(out.record, () => (out.record.counts.failed === 0 && out.record.exitCode === 0 ? 'succeeded' : 'failed')),
        record: out.record,
      }
    }
  }
  switch (input.op) {
    case 'discover': {
      const out = await discoverPythonTests({
        from: anchor.from,
        ...(input.framework === 'pytest' || input.framework === 'unittest' ? { framework: input.framework } : {}),
        ...(signal ? { signal } : {}),
      })
      if ('state' in out) {
        return { result: `test discovery unavailable: ${out.reason}\nremedy: ${out.remedy}`, outcome: 'failed' }
      }
      const lines = out.tests.slice(0, 100)
      return {
        result:
          `${out.framework}: ${out.tests.length} test(s)${out.truncated ? ` (+${out.truncated} truncated)` : ''}${anchor.outside ? ` — in ${findPythonProjectRoot(anchor.from).root}` : ''}` +
          fallbackNoteSuffix(input.framework, out.framework, anchor.from, undefined, out.uncollected ?? []) +
          (out.collectErrors.length ? `\ncollect errors:\n${out.collectErrors.map(e => `  ${e}`).join('\n')}` : '') +
          (lines.length ? `\n${lines.join('\n')}${out.tests.length > lines.length ? `\n(+${out.tests.length - lines.length} more)` : ''}` : ''),
        outcome: 'no-change',
      }
    }
    case 'run': {
      if (input.changed) {
        const { gitStatus } = await import('../../services/gitGraph/observe.js')
        const s = gitStatus(anchor.from)
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
          from: anchor.from,
          selection: testFiles,
          selectionLabel: `changed (${testFiles.length} file(s))`,
          ...(input.framework === 'pytest' || input.framework === 'unittest' ? { framework: input.framework } : {}),
          ...(signal ? { signal } : {}),
        })
        if (out.state === 'unavailable') {
          return { result: `test run unavailable: ${out.reason}\nremedy: ${out.remedy}`, outcome: 'failed' }
        }
        return {
          result: summarize(out.record) + fallbackNoteSuffix(input.framework, out.record.framework, anchor.from, out.record),
          outcome: outcomeOf(out.record, () => (out.record.failures.length === 0 && !out.record.verdictNote ? 'succeeded' : 'failed')),
          record: out.record,
        }
      }
      const selection = input.node ? [input.node] : anchor.selection !== undefined ? [anchor.selection] : []
      const label = input.node ? `nodes:${input.node}` : anchor.selection !== undefined ? `file:${input.path}` : 'all'
      const out = await runPythonTests({
        from: anchor.from,
        selection,
        selectionLabel: label,
        ...(input.framework === 'pytest' || input.framework === 'unittest' ? { framework: input.framework } : {}),
        ...(signal ? { signal } : {}),
      })
      if (out.state === 'unavailable') {
        return { result: `test run unavailable: ${out.reason}\nremedy: ${out.remedy}`, outcome: 'failed' }
      }
      return {
        result: summarize(out.record) + fallbackNoteSuffix(input.framework, out.record.framework, anchor.from, out.record),
        outcome: outcomeOf(out.record, () => (out.record.failures.length === 0 && !out.record.verdictNote ? 'succeeded' : 'failed')),
        record: out.record,
      }
    }
    case 'rerunFailed': {
      const out = await rerunFailedTests({ from: pythonRecordBelow ?? anchor.from, ...(signal ? { signal } : {}) })
      if ('note' in out) return { result: out.note, outcome: 'no-change' }
      if (out.state === 'unavailable') {
        return { result: `rerun unavailable: ${out.reason}\nremedy: ${out.remedy}`, outcome: 'failed' }
      }
      return {
        result: summarize(out.record),
        outcome: outcomeOf(out.record, () => (out.record.failures.length === 0 && !out.record.verdictNote ? 'succeeded' : 'failed')),
        record: out.record,
      }
    }
    case 'debug': {
      if (!input.node) return { result: 'debug needs node (the test id to debug)', outcome: 'failed' }
      const debugLane = resolveTestLane(anchor.from, input.framework)
      if (debugLane.lane === 'ambiguous') {
        return { result: ambiguousWords(debugLane, anchor), outcome: 'no-change' }
      }
      if (debugLane.lane === 'sub-packages') {
        return { result: subPackageWords(debugLane, anchor), outcome: 'no-change' }
      }
      if (debugLane.lane === 'runner-missing') {
        return { result: runnerMissingWords(debugLane, anchor), outcome: 'failed' }
      }
      const ranWithoutStop = async (debuggerMissing: string, remedy: string): Promise<{ result: string; outcome: ToolEffectOutcome; record?: TestRunRecord }> => {
        const ran = await runOp({ ...input, op: 'run' }, context, onProgress)
        return { result: `${debuggerMissingLine(debuggerMissing, remedy)}\n${ran.result}`, outcome: ran.outcome, ...(ran.record ? { record: ran.record } : {}) }
      }
      const launchRunnerDebug = async (plan: {
        runner: string
        adapterKey: string
        program: string
        args: string[]
        cwd: string
        stop: { file: string; line: number; column?: number } | null
        note: string
        launchExtras?: Record<string, unknown>
      }): Promise<{ result: string; outcome: ToolEffectOutcome }> => {
        const owner = ownerFromToolUseContext(context)
        const sessionId = input.session ?? 'test'
        const breakpoints = new Map<string, Array<number | DapBreakpointSpec>>()
        if (input.file && input.lines?.length) breakpoints.set(expandPath(input.file), input.lines)
        else if (plan.stop) breakpoints.set(plan.stop.file, [plan.stop])
        let session
        try {
          session = await createDapSession({
            owner,
            id: sessionId,
            adapterKey: plan.adapterKey,
            program: plan.program,
            args: plan.args,
            cwd: plan.cwd,
            breakpoints: breakpoints.size ? breakpoints : undefined,
            stopOnEntry: breakpoints.size === 0,
            ...(plan.launchExtras ? { launchExtras: plan.launchExtras } : {}),
          })
        } catch (err) {
          const missing = adapterUnavailable(err)
          if (missing !== null) return ranWithoutStop(missing.debuggerMissing, missing.remedy)
          return { result: `debug unavailable: ${err instanceof Error ? err.message : String(err)}`, outcome: 'failed' }
        }
        const stop = await session.waitForStopOutcome(20_000)
        const state =
          stop.state === 'stopped'
            ? `stopped in '${stop.session.label}' — reason ${stop.info.reason}${stop.info.threadId !== undefined ? `, threadId ${stop.info.threadId}` : ''}`
            : stop.state === 'terminated'
              ? `debuggee terminated before any stop (${session.debuggeeEndDetail()}) — the test may have run to completion`
              : 'still running (no stop within 20s) — inspect with the Debug tool'
        return {
          result:
            `debugging ${input.node} (${plan.runner}) in Debug session '${sessionId}': ${state}${stop.state === 'stopped' ? `\n${plan.note}` : ''}\n` +
            `continue with the Debug tool (op:"stack"/"scopes"/"variables"/"continue"; finish with op:"disconnect", session "${sessionId}")`,
          outcome: stop.state === 'terminated' ? 'failed' : 'succeeded',
        }
      }
      if (debugLane.lane === 'runner' && (debugLane.profile.runner === 'vitest' || debugLane.profile.runner === 'jest')) {
        const runner = debugLane.profile.runner
        const shim = buildNodeRunnerDebugShim(runner, input.node, { from: anchor.from })
        if ('state' in shim) {
          return { result: `debug unavailable: ${shim.reason}\nremedy: ${shim.remedy}`, outcome: 'failed' }
        }
        return launchRunnerDebug({ runner, adapterKey: 'js', program: shim.program, args: shim.args, cwd: shim.cwd, stop: shim.stop, note: shim.note })
      }
      if (debugLane.lane === 'runner' && debugLane.profile.runner === 'go') {
        const plan = buildGoTestDebugPlan(input.node, { from: anchor.from })
        if ('state' in plan) {
          if (plan.debuggerMissing !== undefined) return ranWithoutStop(plan.debuggerMissing, plan.remedy)
          return { result: `debug unavailable: ${plan.reason}\nremedy: ${plan.remedy}`, outcome: 'failed' }
        }
        return launchRunnerDebug({ runner: 'go', adapterKey: 'go', program: plan.program, args: plan.args, cwd: plan.cwd, stop: plan.stop, note: plan.note, launchExtras: plan.launchExtras })
      }
      if (debugLane.lane === 'runner' && debugLane.profile.runner === 'cargo') {
        const plan = await buildCargoTestDebugPlan(input.node, { from: anchor.from, ...(signal ? { signal } : {}) })
        if ('state' in plan) {
          if (plan.debuggerMissing !== undefined) return ranWithoutStop(plan.debuggerMissing, plan.remedy)
          return { result: `debug unavailable: ${plan.reason}\nremedy: ${plan.remedy}`, outcome: 'failed' }
        }
        return launchRunnerDebug({ runner: 'cargo', adapterKey: plan.adapterKey, program: plan.program, args: plan.args, cwd: plan.cwd, stop: plan.stop, note: plan.note })
      }
      if (debugLane.lane === 'runner') {
        const jsShim = buildNodeTestDebugShim(input.node, { from: anchor.from })
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
          const missing = adapterUnavailable(err)
          if (missing !== null) return ranWithoutStop(missing.debuggerMissing, missing.remedy)
          return { result: `debug unavailable: ${err instanceof Error ? err.message : String(err)}`, outcome: 'failed' }
        }
        const jsStop = await jsSession.waitForStopOutcome(20_000)
        const jsState =
          jsStop.state === 'stopped'
            ? `stopped in '${jsStop.session.label}' — reason ${jsStop.info.reason}${jsStop.info.threadId !== undefined ? `, threadId ${jsStop.info.threadId}` : ''}`
            : jsStop.state === 'terminated'
              ? `debuggee terminated before any stop (${jsSession.debuggeeEndDetail()}) — the test may have run to completion`
              : 'still running (no stop within 20s) — inspect with the Debug tool'
        return {
          result:
            `debugging ${input.node} (node-test) in Debug session '${jsSessionId}': ${jsState}\n` +
            `continue with the Debug tool (op:"stack"/"scopes"/"variables"/"continue"; finish with op:"disconnect", session "${jsSessionId}")`,
          outcome: 'succeeded',
        }
      }
      const shim = buildDebugTestShim(input.node, {
        from: anchor.from,
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
      let session
      try {
        session = await createDapSession({
          owner,
          id: sessionId,
          adapterKey: 'python',
          program: shim.program,
          cwd: shim.cwd,
          breakpoints: breakpoints.size ? breakpoints : undefined,
          stopOnEntry: breakpoints.size === 0,
        })
      } catch (err) {
        const missing = adapterUnavailable(err)
        if (missing !== null) return ranWithoutStop(missing.debuggerMissing, missing.remedy)
        return { result: `debug unavailable: ${err instanceof Error ? err.message : String(err)}`, outcome: 'failed' }
      }
      const stop = await session.waitForStopOutcome(20_000)
      const state =
        stop.state === 'stopped'
          ? `stopped — reason ${stop.info.reason}${stop.info.threadId !== undefined ? `, threadId ${stop.info.threadId}` : ''}`
          : stop.state === 'terminated'
            ? `debuggee terminated before any stop (${session.debuggeeEndDetail()}) — the test may have run to completion`
            : 'still running (no stop within 20s) — inspect with the Debug tool'
      return {
        result:
          `debugging ${input.node} (${shim.framework}) in Debug session '${sessionId}': ${state}\n` +
          `continue with the Debug tool (op:"stack"/"scopes"/"variables"/"continue"; finish with op:"disconnect", session "${sessionId}")`,
        outcome: 'succeeded',
      }
    }
    case 'report': {
      const record = input.runId ? runHere(input.runId, anchor.from) : latestRunHere(anchor.from)
      if (!record) {
        const runs = listRuns(anchor.from)
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

export { runOp as runTestOperation }

export function isPathShapedNode(node: string, cwd: string = getCwd()): boolean {
  if (node.includes('::')) return false
  if (/^(?:[A-Za-z]:)?[\\/]/.test(node) || /^\.\.?[\\/]/.test(node) || /\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|cs)$/.test(node)) return true
  return /[\\/]/.test(node) && existsSync(resolve(cwd, node))
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
    return `Use this over running tests in Bash for structured results, precise failure reruns and durable test records.

Run project tests as structured transactions (Python: pytest/unittest — the framework is auto-resolved from the project and the shared interpreter; results come from framework-level records, never parsed prose).

Operations:
1. op:"discover" — list test node ids (pytest: file::test · unittest: module.Class.test) or the manifest-declared runner profiles (rp-…). Collect errors are reported, never hidden.
2. op:"run" — the whole suite, one file (path), one node (node), the changed-file focus (changed:true — the runner's own related-test machinery: vitest related · jest --findRelatedTests · changed test files for node-test/pytest · changed packages for go; cargo declines honestly), or an exact profile (profile:"rp-…" — the explicit runner override). The permission ask shows the exact resolved argv before anything executes; long runs stream a bounded live status line. Returns the ran argv + counts + typed failure locations (file:line + test name) + available LSP diagnostics + a durable record (mercury://test/run/<id>; mercury://test/latest and /failures always point at the newest truth). Full output spills to an artifact ref.
3. op:"rerunFailed" — re-run exactly the failures recorded by the latest run.
4. op:"debug" — debug one test (node required) under its own debugger, stopping on the test's first line: python under debugpy · node-test, vitest and jest under js-debug (node spelled file::name, or a bare name from the latest run) · go under delve (TestName, TestName/subtest or dir::TestName) · cargo under lldb-dap or gdb (module::path::test_name); a debugger that is not installed answers unavailable with its install line. Pass file+lines for breakpoints of your own; the call reports the first stop and leaves Debug session "test" open — continue with the Debug tool (stack/scopes/variables/continue, then disconnect).
5. op:"report" — the latest (or runId) durable record.

A run whose exit code disagrees with its structured records says so (verdictNote) — trust the records. A selection that matched no test comes back as "no test matched <selection> — <the runner's own words>" with zero counts: not a failure, and not a pass — pick another selector (a node id from discover, or the file as path). Prefer run→fix→rerunFailed loops over re-running the whole suite.`
  },
  userFacingName,
  shouldDefer: true,
  straightQuoteInputs: ['path', 'file'],
  get inputSchema(): SchemaType {
    return inputSchema()
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly(input: Input) {
    return input?.op === 'report'
  },
  async checkPermissions(input: Input) {
    if (input.op === 'report') {
      return { behavior: 'allow' as const, updatedInput: input }
    }
    let resolved = ''
    if (input.op === 'run') {
      try {
        const anchor = anchorOf(input)
        const { profiles } = discoverRunnerProfiles(anchor.from)
        const lane = input.profile ? undefined : resolveTestLane(anchor.from, input.framework)
        const profile = input.profile ? profiles.find(p => p.id === input.profile) : lane?.lane === 'runner' ? lane.profile : undefined
        const where = anchor.outside ? ` (in ${profile ? resolve(profile.root) : anchor.root})` : ''
        if (lane !== undefined && lane.lane !== 'runner' && lane.lane !== 'python') {
          resolved = ` (no single test runner at ${anchor.outside ? anchor.root : 'this root'} — the call names the options and runs nothing)`
        } else if (profile) {
          if (input.changed) {
            resolved = ` — will run: ${profile.command.join(' ')} + changed-file focus (targets resolve against the tree at execution)${where}`
          } else {
            const extra = input.node
              ? profile.selection === 'node-pattern'
                ? ` --test-name-pattern ${input.node}`
                : ` ${input.node}`
              : anchor.selection !== undefined
                ? ` ${input.path}`
                : ''
            resolved = ` — will run: ${profile.command.join(' ')}${extra}${where}`
          }
        } else if (!input.profile) {
          resolved = ` (python lane: the shared project interpreter${where})`
        }
      } catch {
      }
    }
    return {
      behavior: 'ask' as const,
      message: `Test ${input.op}${input.node ? `: ${input.node}` : input.path ? `: ${input.path}` : input.changed ? ': changed files' : ''}${resolved || ' (runs project test code)'}`,
    }
  },
  async validateInput(input: Input) {
    if (input.op === 'debug' && !input.node) {
      return { result: false as const, message: 'debug requires node (the test id)', errorCode: 1 }
    }
    if (input.op === 'run' && input.node !== undefined && isPathShapedNode(input.node)) {
      return { result: false as const, message: `node is a test id from discover (file::name, or a bare test name), not a path — '${input.node}' names a file or folder: drop node to run the whole profile, or pass it as path`, errorCode: 1 }
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
        outcome: op.record && op.record.exitCode !== null && op.record.counts.failed > 0 && op.record.counts.errored === 0 && !op.record.verdictNote ? 'succeeded' : op.outcome,
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
  extractSearchText({ result }) {
    return result
  },
})
