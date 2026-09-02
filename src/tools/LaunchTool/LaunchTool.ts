
import { z } from 'zod/v4'
import { buildTool, type ToolEffectOutcome, type ToolUseContext } from '../../Tool.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import type { OwnerKey } from '../../services/run/ownerKey.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { expandPath } from '../../utils/path.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import { createDapSession } from '../../services/dap/dapClient.js'
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
import { runPythonTests } from '../../services/ide/pythonTests.js'
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
    session: z.string().optional().describe('debug/run: the Debug-tool session name to create (default "launch")'),
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
}

const lastActions = new Map<OwnerKey, { at: number; summary: string }>()

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
            : '(no payload)'
  const note = p.unityHeadless?.note ?? p.blenderHeadless?.note
  return [
    `${p.id} [${p.kind}/${p.language}] ${p.label}`,
    `  ${payload}`,
    `  from: ${p.provenance}`,
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

async function runOp(input: Input, context: ToolUseContext): Promise<{ result: string; outcome: ToolEffectOutcome }> {
  const owner = ownerFromToolUseContext(context)
  const note = (summary: string): void => {
    lastActions.set(owner, { at: Date.now(), summary })
  }
  switch (input.op) {
    case 'list': {
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
    case 'inspect': {
      if (!input.profile) return { result: 'inspect needs profile (an lp-… id from op:"list")', outcome: 'failed' }
      const p = await getLaunchProfile(input.profile)
      if (!p) return { result: `no profile '${input.profile}' in the current discovery — re-run op:"list" (ids are content-stable; a changed source changes the id)`, outcome: 'failed' }
      return { result: describeProfile(p), outcome: 'no-change' }
    }
    case 'debug':
    case 'run': {
      if (!input.profile) return { result: `${input.op} needs profile`, outcome: 'failed' }
      const p = await getLaunchProfile(input.profile)
      if (!p) return { result: `no profile '${input.profile}' — re-run op:"list"`, outcome: 'failed' }
      const engineRefusal = operatorRunRefusal(p)
      if (engineRefusal) return engineRefusal
      if (!p.debug) {
        return {
          result: `profile ${p.id} is a ${p.kind} profile — it has no debug/run payload (use op:"${p.kind}")`,
          outcome: 'no-change',
        }
      }
      const sessionId = input.session ?? 'launch'
      const breakpoints = new Map<string, number[]>()
      if (input.op === 'debug' && input.file && input.lines?.length) {
        breakpoints.set(expandPath(input.file), input.lines)
      }
      const session = await createDapSession({
        owner,
        id: sessionId,
        adapterKey: p.debug.adapter,
        program: p.debug.program,
        args: p.debug.args,
        cwd: p.debug.cwd ?? process.cwd(),
        breakpoints: breakpoints.size ? breakpoints : undefined,
        stopOnEntry: input.op === 'debug' && breakpoints.size === 0,
        noDebug: input.op === 'run',
      })
      if (input.op === 'run') {
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
          result: `${p.label} is RUNNING (session '${sessionId}') — observe with the Debug tool (op:"output"/"status"; finish with op:"disconnect")`,
          outcome: 'succeeded',
        }
      }
      const stop = await session.waitForStopOutcome(20_000)
      const state =
        stop.state === 'stopped'
          ? `stopped — reason ${stop.info.reason}`
          : stop.state === 'terminated'
            ? `terminated before a stop (${session.exitDetail || 'clean exit'})`
            : 'still running (no stop in 20s)'
      note(`debug ${p.id} (${p.label}) — ${state}`)
      return {
        result: `debugging ${p.label} in session '${sessionId}': ${state}\ncontinue with the Debug tool (stack/scopes/variables/continue; disconnect when done)`,
        outcome: 'succeeded',
      }
    }
    case 'test': {
      if (!input.profile) return { result: 'test needs profile', outcome: 'failed' }
      const p = await getLaunchProfile(input.profile)
      if (!p) return { result: `no profile '${input.profile}' — re-run op:"list"`, outcome: 'failed' }
      if (p.runnerRef && p.kind === 'test') {
        const { runRunnerProfile } = await import('../../services/ide/projectRunners.js')
        const out = await runRunnerProfile(p.runnerRef.profileId, { signal: context.abortController.signal })
        if (out.state === 'unavailable') {
          return { result: `test run unavailable: ${out.reason}\nremedy: ${out.remedy}`, outcome: 'failed' }
        }
        if (out.state === 'stale-profile') {
          return { result: `stale runner profile: ${out.reason}\ncurrent: ${out.profiles.map(rp => `${rp.id} ${rp.title}`).join(' · ') || '(none)'}`, outcome: 'failed' }
        }
        const rc = out.record.counts
        note(`test ${p.id} — ${rc.passed} passed · ${rc.failed} failed (${out.record.id})`)
        return {
          result: `${p.label}: ${rc.passed} passed · ${rc.failed} failed · ${rc.skipped} skipped · ${rc.errored} errored — record mercury://test/run/${out.record.id}${out.record.verdictNote ? `\nNOTE: ${out.record.verdictNote}` : ''}`,
          outcome: rc.failed === 0 && rc.errored === 0 && out.record.exitCode === 0 ? 'succeeded' : 'failed',
        }
      }
      const engineTestRefusal = operatorRunRefusal(p)
      if (engineTestRefusal) return engineTestRefusal
      if (!p.test) return { result: `profile ${p.id} is a ${p.kind} profile — no test payload`, outcome: 'no-change' }
      const out = await runPythonTests({
        framework: p.test.framework,
        selection: p.test.selection,
        selectionLabel: p.test.selectionLabel,
      })
      if (out.state === 'unavailable') {
        return { result: `test run unavailable: ${out.reason}\nremedy: ${out.remedy}`, outcome: 'failed' }
      }
      const c = out.record.counts
      note(`test ${p.id} — ${c.passed} passed · ${c.failed} failed (${out.record.id})`)
      return {
        result: `${p.label}: ${c.passed} passed · ${c.failed} failed · ${c.skipped} skipped · ${c.errored} errored — record mercury://test/run/${out.record.id}`,
        outcome: out.record.failures.length === 0 && !out.record.verdictNote ? 'succeeded' : 'failed',
      }
    }
    case 'build': {
      if (!input.profile) return { result: 'build needs profile', outcome: 'failed' }
      const p = await getLaunchProfile(input.profile)
      if (!p) return { result: `no profile '${input.profile}' — re-run op:"list"`, outcome: 'failed' }
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
      const engineBuildRefusal = operatorRunRefusal(p)
      if (engineBuildRefusal) return engineBuildRefusal
      if (!p.build) return { result: `profile ${p.id} is a ${p.kind} profile — no build payload`, outcome: 'no-change' }
      const steps: CppBuildRun[] = []
      const configure = p.build.preset ? await configurePreset(p.build.preset) : await configureConventional()
      steps.push(configure)
      if (configure.exitCode === 0) {
        steps.push(await buildTarget(p.build.preset ? { preset: p.build.preset } : {}))
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
    case 'last': {
      const last = lastActions.get(owner)
      return {
        result: last ? `${new Date(last.at).toISOString()} — ${last.summary}` : 'no launch-profile action this session',
        outcome: 'no-change',
      }
    }
  }
}

export const LaunchTool = buildTool({
  name: 'Launch',
  searchHint:
    'unified launch profiles: list/inspect/debug/run/test/build from .vscode launch.json, python tests, CMake presets, Godot scenes',
  maxResultSizeChars: 60_000,
  async description() {
    return 'Discover and execute unified launch profiles (debug/run/test/build) across Python, C/C++ and Godot'
  },
  async prompt() {
    return `Unified launch profiles: ONE discovery over .vscode/launch.json (the safe subset — unrepresentable configs are listed with reasons), detected Python test frameworks, CMake presets and Godot scenes. Execution delegates to the machinery that owns each action (DAP sessions for debug/run — run is the same session with noDebug; the Test transactions; the CMake build primitives).

1. op:"list" — every profile with its content-stable id (lp-…; a changed source changes the id — never a stale fire).
2. op:"inspect" (profile) — the full payload + provenance + dropped fields.
3. op:"debug" (profile, optional file+lines breakpoints) — opens Debug session "launch"; continue with the Debug tool.
4. op:"run" (profile) — the same adapter path without debugging; quick programs report their output, long-running ones hand you the live session.
5. op:"test" (profile) — through the Test transactions (durable mercury://test records).
6. op:"build" (profile) — configure (+build) through the CMake primitives; typed step results with artifact refs.
7. op:"last" — this session's last launch-profile action.

Conceptual asks this closes: "debug the failing Python test" (the rerun-failed profile), "build the current CMake target" (the preset profile), "run the Godot scene" — no hand-built adapter arguments.`
  },
  userFacingName,
  shouldDefer: true,
  get inputSchema(): SchemaType {
    return inputSchema()
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly(input: Input) {
    return input?.op === 'list' || input?.op === 'inspect' || input?.op === 'last'
  },
  async checkPermissions(input: Input) {
    if (input.op === 'list' || input.op === 'inspect' || input.op === 'last') {
      return { behavior: 'allow' as const, updatedInput: input }
    }
    return {
      behavior: 'ask' as const,
      message: `Launch ${input.op}: profile ${input.profile ?? '?'} (executes project code/builds)`,
    }
  },
  toAutoClassifierInput(input: Input) {
    return `launch ${input.op}: ${input.profile ?? ''}`
  },
  async validateInput(input: Input) {
    if ((input.op === 'inspect' || input.op === 'debug' || input.op === 'run' || input.op === 'test' || input.op === 'build') && !input.profile) {
      return { result: false as const, message: `${input.op} requires profile (an lp-… id)`, errorCode: 1 }
    }
    return { result: true as const }
  },
  async call(input: Input, context: ToolUseContext) {
    const startedAt = Date.now()
    let op: { result: string; outcome: ToolEffectOutcome }
    try {
      op = await runOp(input, context)
    } catch (err) {
      op = { result: `${input.op} failed: ${(err as Error).message}`, outcome: 'failed' }
    }
    const output: Output = { op: input.op, result: op.result, outcome: op.outcome }
    return {
      data: output,
      effect: {
        outcome: op.outcome,
        operation: `launch.${input.op}`,
        changedPaths: [],
        evidence: op.result.split('\n')[0]?.slice(0, 160) ?? '',
        startedAt,
        completedAt: Date.now(),
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
  renderToolResultMessage,
  extractSearchText({ result }) {
    return result
  },
})

export { launchProfilesEnabled as isLaunchToolCatalogEnabled }
