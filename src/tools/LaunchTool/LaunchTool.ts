import { resolve } from 'node:path'
import { z } from 'zod/v4'
import { buildTool, findToolByName, type ToolCallProgress, type ToolEffectOutcome, type ToolUseContext } from '../../Tool.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import type { OwnerKey } from '../../services/run/ownerKey.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getCwd } from '../../utils/cwd.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import { getDenyRuleForTool } from '../../utils/permissions/decision/rules.js'
import { createDapSession, getDapSession, isDapToolCatalogEnabled } from '../../services/dap/dapClient.js'
import {
  buildTarget,
  configureConventional,
  configurePreset,
  type CppBuildRun,
} from '../../services/ide/cppProject.js'
import {
  discoverLaunchProfiles,
  getLaunchProfile,
  launchProfilesEnabled,
  type LaunchProfile,
} from '../../services/ide/launchProfiles.js'
import { pythonTestsEnabled } from '../../services/ide/pythonTests.js'
import { DebugTool, runDebugLaunch, type Input as DebugInput, type OpResult as DebugResult } from '../DebugTool/DebugTool.js'
import { TestTool, runTestOperation, type Input as TestInput } from '../TestTool/TestTool.js'
import { renderToolUseProgressMessage } from '../TestTool/UI.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'

const OPS = ['list', 'inspect', 'debug', 'run', 'test', 'build', 'last'] as const

const inputSchema = lazySchema(() =>
  z.strictObject({
    op: z.enum(OPS).describe('The launch-profile operation'),
    profile: z.string().optional().describe('The profile id (lp-…) from op:"list" — required for inspect/debug/run/test/build'),
    session: z.string().optional().describe('Debug session for debug (default "main") or for a still-running run (default "launch")'),
    file: z.string().optional().describe('debug: source file for breakpoints'),
    lines: z
      .array(semanticNumber(z.number().int().positive()))
      .optional()
      .describe('debug: breakpoint lines in file'),
  }),
)

type SchemaType = ReturnType<typeof inputSchema>
export type Input = z.infer<SchemaType>
export type Output = {
  op: Input['op']
  result: string
  outcome: ToolEffectOutcome
  route?: { tool: 'Debug' | 'Test'; input: Record<string, unknown> }
}

type OwnerTool = 'Debug' | 'Test'
type Route =
  | { tool: 'Debug'; input: DebugInput; owners: OwnerTool[]; cwd?: string }
  | { tool: 'Test'; input: TestInput; owners: OwnerTool[] }
type OpResult = Pick<Output, 'result' | 'outcome' | 'route'> & { details?: Record<string, unknown> }
type Resolution = { refuse: OpResult } | { own: 'run' | 'build' } | { route: Route }

const lastActions = new Map<OwnerKey, { at: number; summary: string }>()

function profileOps(p: LaunchProfile): string {
  return p.debug ? 'op:"debug" or op:"run"' : p.test || (p.runnerRef && p.kind === 'test')
    ? 'op:"test"' : p.build || (p.runnerRef && p.kind === 'build') ? 'op:"build"' : `op:"${p.kind}"`
}

function resolveRequest(p: LaunchProfile, input: Input): Resolution {
  const engineRefusal = operatorRunRefusal(p)
  if (engineRefusal) return { refuse: engineRefusal }
  const breakpoints = input.file && input.lines?.length ? { file: input.file, lines: input.lines } : undefined
  switch (input.op) {
    case 'debug': {
      const session = input.session ?? 'main'
      if (p.debug) {
        return { route: {
          tool: 'Debug',
          input: {
            op: 'launch', program: p.debug.program, adapter: p.debug.adapter,
            ...(p.debug.args?.length ? { args: p.debug.args } : {}),
            ...(breakpoints ?? { stopOnEntry: true }),
            ...(session !== 'main' ? { session } : {}),
          },
          owners: ['Debug'],
          ...(p.debug.cwd !== undefined ? { cwd: p.debug.cwd } : {}),
        } }
      }
      if (p.source === 'python-tests' && p.test?.selectionLabel === 'rerun-failed' && p.test.selection.length) {
        return { route: {
          tool: 'Test',
          input: { op: 'debug', node: p.test.selection[0], framework: p.test.framework, ...breakpoints, session },
          owners: ['Test', 'Debug'],
        } }
      }
      if (p.kind === 'test') {
        return { refuse: {
          result: `profile ${p.id} runs a whole test suite — debug one test with Test {"op":"debug","node":"<test id>"} (Test {"op":"discover"} lists the ids), or run the suite with op:"test"`,
          outcome: 'no-change',
        } }
      }
      return { refuse: { result: `profile ${p.id} is a ${p.kind} profile — it has no debug/run payload (use op:"${p.kind}")`, outcome: 'no-change' } }
    }
    case 'run':
      return p.debug ? { own: 'run' } : { refuse: {
        result: `profile ${p.id} is a ${p.kind} profile — it has no debug/run payload (use op:"${p.kind}")`, outcome: 'no-change',
      } }
    case 'test':
      if (p.runnerRef && p.kind === 'test') {
        return { route: { tool: 'Test', input: { op: 'run', profile: p.runnerRef.profileId }, owners: ['Test'] } }
      }
      if (p.test) {
        return { route: {
          tool: 'Test',
          input: p.test.selectionLabel === 'rerun-failed' ? { op: 'rerunFailed' } : { op: 'run', framework: p.test.framework },
          owners: ['Test'],
        } }
      }
      return { refuse: { result: `profile ${p.id} is a ${p.kind} profile — it has no test payload (use ${profileOps(p)})`, outcome: 'no-change' } }
    default:
      return p.build || (p.runnerRef && p.kind === 'build') ? { own: 'build' } : { refuse: {
        result: `profile ${p.id} is a ${p.kind} profile — it has no build payload (use ${profileOps(p)})`, outcome: 'no-change',
      } }
  }
}

function ownersOf(request: Resolution): OwnerTool[] {
  return 'route' in request ? request.route.owners : 'own' in request && request.own === 'run' ? ['Debug'] : []
}

function ownerBlocked(name: OwnerTool, context: ToolUseContext): boolean {
  const permissions = context?.getAppState?.()?.toolPermissionContext
  return permissions !== undefined && getDenyRuleForTool(permissions, { name }) !== null
}

function ownerAvailable(name: OwnerTool, context: ToolUseContext): boolean {
  const tools = context?.options?.tools
  return tools !== undefined ? findToolByName(tools, name) !== undefined : name === 'Debug' ? isDapToolCatalogEnabled() : pythonTestsEnabled()
}

function ownerRefusal(op: Input['op'], name: OwnerTool, blocked: boolean): string {
  return `Launch ${op} runs through the ${name} tool, which ${blocked ? 'a deny rule blocks' : 'is not available'} in this session — nothing ran. If the task needs ${name}, say so to the user.`
}

function describeProfile(p: LaunchProfile): string {
  const payload =
    p.debug
      ? `debug/run → ${p.debug.adapter}: ${p.debug.program}${p.debug.args?.length ? ` ${p.debug.args.join(' ')}` : ''}`
      : p.test
        ? `test → ${p.test.framework} (${p.test.selectionLabel})`
        : p.build
          ? `build → ${p.build.preset ? `preset ${p.build.preset}` : 'conventional configure'}`
          : (p.unityHeadless ?? p.blenderHeadless)
            ? `operator-run → ${(p.unityHeadless ?? p.blenderHeadless)?.commandLine}`
            : p.runnerRef
              ? `${p.kind} → ${p.runnerRef.runner} runner profile ${p.runnerRef.profileId}`
              : '(no payload)'
  const routes: string[] = []
  for (const op of ['test', 'debug'] as const) {
    const request = resolveRequest(p, { op, profile: p.id })
    if ('route' in request) {
      const r = request.route
      const cwd = r.tool === 'Debug' && r.cwd !== undefined && resolve(r.cwd) !== resolve(getCwd())
        ? ` · cwd ${r.cwd} from the profile` : ''
      routes.push(`  ${op} runs as: ${r.tool} ${JSON.stringify(r.input)}${cwd}`)
    }
  }
  const note = p.unityHeadless?.note ?? p.blenderHeadless?.note
  return [
    `${p.id} [${p.kind}/${p.language}] ${p.label}`,
    `  ${payload}`,
    `  from: ${p.provenance}`,
    ...routes,
    ...(note ? [`  note: ${note}`] : []),
    ...(p.droppedFields?.length ? [`  dropped (unrepresentable): ${p.droppedFields.join(', ')}`] : []),
  ].join('\n')
}

export function operatorRunRefusal(p: LaunchProfile): { result: string; outcome: ToolEffectOutcome } | null {
  const payload = p.unityHeadless ?? p.blenderHeadless
  if (!payload) return null
  const engine = p.unityHeadless ? 'unity' : 'blender'
  return {
    result:
      `${engine} headless profiles are operator-run in this build — run it yourself:\n` +
      `  ${payload.commandLine}\n` +
      `${payload.note}` +
      (p.unityHeadless && p.kind === 'test'
        ? `\n(after the run, the results XML lands at the path in the command — the Test surfaces read it from there)`
        : ''),
    outcome: 'no-change',
  }
}

export const unityHeadlessRefusal = operatorRunRefusal

async function routeLine(p: LaunchProfile, route: Route, context: ToolUseContext, replaced: boolean): Promise<string> {
  let line = `Launch ${p.id} ran as: ${route.tool} ${JSON.stringify(route.input)}`
  const session = route.input.session ?? 'main'
  if (route.tool === 'Debug' && route.cwd !== undefined && resolve(route.cwd) !== resolve(getCwd())) {
    line += `; cwd ${route.cwd} from the profile`
  }
  if (replaced) line += `; it replaced the live session '${session}'`
  if (route.tool === 'Debug' && session !== 'main') line += `; pass session:${JSON.stringify(session)} on every Debug call`
  if (route.tool === 'Test' && route.input.op === 'debug' && (p.test?.selection.length ?? 0) > 1) {
    line += `; ${p.test!.selection.length - 1} more failing test(s) — Test ${JSON.stringify({ op: 'debug', node: p.test!.selection[1] })} debugs another`
  }
  const tools = context?.options?.tools
  if (tools && context.messages) {
    const next = route.tool === 'Debug' || route.input.op === 'debug' ? 'Debug' : 'Test'
    const tool = findToolByName(tools, next)
    if (tool) {
      const { buildSchemaNotSentHint } = await import('../../services/tools/toolExecution.js')
      if (buildSchemaNotSentHint(tool, context.messages, tools, context.options.engineModel) !== null) {
        line += `; load ${next} first: ToolSearch "select:${next}"`
      }
    }
  }
  return line
}

async function runRoute(p: LaunchProfile, route: Route, context: ToolUseContext, onProgress?: ToolCallProgress): Promise<OpResult> {
  const owner = ownerFromToolUseContext(context)
  const session = route.input.session ?? 'main'
  const debugging = route.tool === 'Debug' || route.input.op === 'debug'
  const replaced = debugging && getDapSession(owner, session) !== undefined
  let op: DebugResult & { record?: Awaited<ReturnType<typeof runTestOperation>>['record'] }
  try {
    op = route.tool === 'Debug'
      ? await runDebugLaunch(route.input, owner, { cwd: route.cwd })
      : await runTestOperation(route.input, context, onProgress)
  } catch (err) {
    op = { result: `${route.input.op} failed: ${(err as Error).message}`, outcome: 'failed' }
  }
  const summary = route.tool === 'Debug'
    ? `debug ${p.id} (${p.label}) → Debug session '${session}' — ${op.debuggee ?? 'failed'}`
    : route.input.op === 'debug'
      ? `debug ${p.id} (${p.label}) → Test debug of ${route.input.node} in session '${session}' — ${op.outcome}`
      : op.record
        ? `test ${p.id} — ${op.record.counts.passed} passed · ${op.record.counts.failed} failed (${op.record.id})`
        : `test ${p.id} — ${op.outcome}`
  lastActions.set(owner, { at: Date.now(), summary })
  const routed = { tool: route.tool, input: route.input }
  return {
    result: `${op.result}\n${await routeLine(p, route, context, replaced)}`,
    outcome: op.outcome,
    route: routed,
    details: {
      route: routed,
      ...(op.details ?? {}),
      ...(op.debuggee ? { debuggee: op.debuggee } : {}),
      ...(op.record ? { testRun: { id: op.record.id, framework: op.record.framework, counts: op.record.counts, failures: op.record.failures.slice(0, 20) } } : {}),
    },
  }
}

async function runOp(input: Input, context: ToolUseContext, onProgress?: ToolCallProgress): Promise<OpResult> {
  const owner = ownerFromToolUseContext(context)
  const note = (summary: string): void => {
    lastActions.set(owner, { at: Date.now(), summary })
  }
  if (input.op === 'list') {
    const d = await discoverLaunchProfiles()
    const lines = d.profiles.map(p => `${p.id} [${p.kind}/${p.language}] ${p.label}`)
    return {
      result:
        (lines.length ? lines.join('\n') : 'no launch profiles discovered in this project') +
        (d.skipped.length
          ? `\nskipped launch.json configs:\n${d.skipped.map(s => `  ${s.name}: ${s.reason}`).join('\n')}`
          : '') +
        (d.sourceErrors.length
          ? `\nsource notes:\n${d.sourceErrors.map(e => `  ${e.source}: ${e.error}`).join('\n')}`
          : ''),
      outcome: 'no-change',
    }
  }
  if (input.op === 'last') {
    const last = lastActions.get(owner)
    return {
      result: last ? `${new Date(last.at).toISOString()} — ${last.summary}` : 'no launch-profile action this session',
      outcome: 'no-change',
    }
  }
  if (!input.profile) return { result: input.op === 'inspect' ? 'inspect needs profile (an lp-… id from op:"list")' : `${input.op} needs profile`, outcome: 'failed' }
  const p = await getLaunchProfile(input.profile)
  if (!p) return { result: `no profile '${input.profile}' in the current discovery — re-run op:"list" (ids are content-stable; a changed source changes the id)`, outcome: 'failed' }
  if (input.op === 'inspect') return { result: describeProfile(p), outcome: 'no-change' }
  const request = resolveRequest(p, input)
  const owners = ownersOf(request)
  const blocked = owners.find(name => ownerBlocked(name, context))
  if (blocked) return { result: ownerRefusal(input.op, blocked, true), outcome: 'failed' }
  if ('refuse' in request) return request.refuse
  const absent = owners.find(name => !ownerAvailable(name, context))
  if (absent) return { result: ownerRefusal(input.op, absent, false), outcome: 'failed' }
  if ('route' in request) return runRoute(p, request.route, context, onProgress)
  if (request.own === 'run') {
    const sessionId = input.session ?? 'launch'
    const session = await createDapSession({
      owner,
      id: sessionId,
      adapterKey: p.debug!.adapter,
      program: p.debug!.program,
      args: p.debug!.args,
      cwd: p.debug!.cwd ?? process.cwd(),
      breakpoints: undefined,
      stopOnEntry: false,
      noDebug: true,
    })
    const outcome = await session.waitForStopOutcome(15_000)
    if (outcome.state === 'terminated') {
      await session.drainOutput()
      const tail = session.output.slice(-12).join('\n')
      note(`run ${p.id} (${p.label}) — terminated: ${session.exitDetail || 'clean exit'}`)
      const { removeDapSession } = await import('../../services/dap/dapClient.js')
      await removeDapSession(owner, sessionId)
      return {
        result: `ran ${p.label} — ${session.exitDetail || 'clean exit'}${tail ? `\noutput:\n${tail}` : ''}`,
        outcome: 'succeeded',
      }
    }
    note(`run ${p.id} (${p.label}) — still running (session '${sessionId}')`)
    return {
      result: `${p.label} is RUNNING in Debug session '${sessionId}' — read its output with Debug ${JSON.stringify({ op: 'output', session: sessionId })}; stop it with Debug ${JSON.stringify({ op: 'disconnect', session: sessionId })}`,
      outcome: 'succeeded',
    }
  }
  if (p.runnerRef && p.kind === 'build') {
    const { runRunnerProfile } = await import('../../services/ide/projectRunners.js')
    const out = await runRunnerProfile(p.runnerRef.profileId, { signal: context.abortController.signal })
    if (out.state === 'unavailable') {
      return { result: `build unavailable: ${out.reason}\nremedy: ${out.remedy}`, outcome: 'failed' }
    }
    if (out.state === 'stale-profile') {
      return { result: `stale runner profile: ${out.reason}`, outcome: 'failed' }
    }
    const ok = out.record.exitCode === 0 && !out.record.verdictNote?.includes('did not exit cleanly')
    const tail = out.record.outputTail.slice(-8).join('\n')
    note(`build ${p.id} — ${ok ? 'green' : 'FAILED'}`)
    return {
      result: `${p.label}: exit ${out.record.exitCode ?? 'null'} (${out.record.durationMs}ms) — record mercury://test/run/${out.record.id}${tail ? `\n${tail}` : ''}`,
      outcome: ok ? 'succeeded' : 'failed',
    }
  }
  const steps: CppBuildRun[] = []
  const configure = p.build!.preset ? await configurePreset(p.build!.preset) : await configureConventional()
  steps.push(configure)
  if (configure.exitCode === 0) {
    steps.push(await buildTarget(p.build!.preset ? { preset: p.build!.preset } : {}))
  }
  const summary = steps
    .map(s => `${s.op} exit ${s.exitCode ?? 'null'} (${s.durationMs}ms)${s.artifactRef ? ` · ${s.artifactRef}` : ''}`)
    .join('\n')
  const ok = steps.every(s => s.exitCode === 0)
  const tail = steps.at(-1)?.outputTail.slice(-8).join('\n') ?? ''
  note(`build ${p.id} — ${ok ? 'green' : 'FAILED'}`)
  return {
    result: `${p.label}:\n${summary}${tail ? `\n${tail}` : ''}`,
    outcome: ok ? 'succeeded' : 'failed',
  }
}

export const LaunchTool = buildTool({
  name: 'Launch',
  searchHint:
    'launch.json, Python test, CMake, Godot, script profiles: debug via Debug, test via Test, run, build — lp- ids, list/inspect, package.json Cargo.toml go.mod scripts, Unity/Blender recipes',
  maxResultSizeChars: 60_000,
  async description() {
    return 'Discover launch profiles and run them — debug through Debug, tests through Test'
  },
  async prompt() {
    return `One list of the project's launch profiles: .vscode/launch.json configs, the detected Python tests (and a rerun of the last failures), CMake presets, Godot scenes, package.json/Cargo.toml/go.mod test and build scripts, Unity/Blender headless recipes (printed, never run). Ids (lp-…) are content-stable: a changed source gives a new id, so re-list.

1. op:"list" — every profile, and skipped launch.json configs with why.
2. op:"inspect" (profile) — payload, origin, dropped fields, and the Debug or Test call it runs as.
3. op:"debug" (profile; file + lines for breakpoints) — runs as a Debug launch in Debug's default session "main" (or session), replacing a live session of that name; the rerun profile runs as Test op:"debug" on its first failure.
4. op:"run" (profile) — the same without a debugger; a program still running after 15 s stays in Debug session "launch" (or session).
5. op:"test" (profile) — runs as Test op:"run" (op:"rerunFailed" for the rerun profile).
6. op:"build" (profile) — CMake configure + build, or the runner's build/check script.
7. op:"last" — this session's last Launch action.

debug and test return that tool's own result plus the call they ran as. debug and run need the Debug tool in this session, test the Test tool; without it they refuse.`
  },
  userFacingName,
  shouldDefer: true,
  straightQuoteInputs: ['file'],
  get inputSchema(): SchemaType {
    return inputSchema()
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly(input: Input) {
    return input?.op === 'list' || input?.op === 'inspect' || input?.op === 'last'
  },
  async checkPermissions(input: Input, context: ToolUseContext) {
    if (input.op === 'list' || input.op === 'inspect' || input.op === 'last') {
      return { behavior: 'allow' as const, updatedInput: input }
    }
    const ask = { behavior: 'ask' as const, message: `Launch ${input.op}: profile ${input.profile ?? '?'} (executes project code/builds)` }
    const p = input.profile ? await getLaunchProfile(input.profile) : null
    if (!p) return ask
    const request = resolveRequest(p, input)
    const owners = ownersOf(request)
    const blocked = owners.find(name => ownerBlocked(name, context))
    if (blocked) {
      const message = ownerRefusal(input.op, blocked, true)
      return { behavior: 'deny' as const, message, decisionReason: { type: 'other' as const, reason: message } }
    }
    if ('refuse' in request || owners.some(name => !ownerAvailable(name, context))) {
      return { behavior: 'allow' as const, updatedInput: input }
    }
    if ('route' in request) {
      const route = request.route
      const ownerAsk = route.tool === 'Debug'
        ? await DebugTool.checkPermissions(route.input, context)
        : await TestTool.checkPermissions(route.input, context)
      if (ownerAsk.behavior === 'allow') return { behavior: 'allow' as const, updatedInput: input }
      return { ...ownerAsk, message: `Launch ${input.op} ${p.id} (${p.label}) → ${ownerAsk.message}` }
    }
    return ask
  },
  async validateInput(input: Input) {
    if ((input.op === 'inspect' || input.op === 'debug' || input.op === 'run' || input.op === 'test' || input.op === 'build') && !input.profile) {
      return { result: false as const, message: `${input.op} requires profile (an lp-… id from op:"list")`, errorCode: 1 }
    }
    if (input.op === 'debug' && (input.file !== undefined || input.lines !== undefined) && (!input.file || !input.lines?.length)) {
      return { result: false as const, message: 'debug breakpoints need file and lines together — pass both, or neither to stop at the program\'s first line', errorCode: 1 }
    }
    return { result: true as const }
  },
  async call(input: Input, context: ToolUseContext, _canUseTool, _parentMessage, onProgress) {
    const startedAt = Date.now()
    let op: OpResult
    try {
      op = await runOp(input, context, onProgress)
    } catch (err) {
      op = { result: `${input.op} failed: ${(err as Error).message}`, outcome: 'failed' }
    }
    const output: Output = { op: input.op, result: op.result, outcome: op.outcome, ...(op.route ? { route: op.route } : {}) }
    return {
      data: output,
      effect: {
        outcome: op.outcome,
        operation: `launch.${input.op}`,
        changedPaths: [],
        evidence: op.result.split('\n')[0]?.slice(0, 160) ?? '',
        startedAt,
        completedAt: Date.now(),
        ...(op.details ? { details: op.details } : {}),
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

export { launchProfilesEnabled as isLaunchToolCatalogEnabled }
