// ============================================================================
//  Debug tool — the agent-facing surface over the DAP client (IDE-hands
//  phase 2; services/dap/dapClient.ts holds the protocol engine + the
//  OWNER-ADDRESSED session registry). Catalog-gated by
//  isDapToolCatalogEnabled() in tools.ts (MERCURY_DAP); launch is the
//  permissioned op (it executes a program — Bash-class), inspection ops ride
//  the permitted session.
//
//  TYPED SINCE (Sol 5.6): every operation returns a ToolEffect —
//  a thrown/failed op maps to a model-visible tool ERROR (never prose that
//  reads as success), evaluate/step outcomes state whether the debuggee is
//  stopped/running/terminated, breakpoints report what the adapter VERIFIED,
//  and sessions are keyed by conversation owner + alias (two conversations'
//  'main' never collide). Proof: scripts/dap/prove-dap.ts +
//  scripts/dap/prove-dap-owner-lifecycle.ts (mock adapter, deterministic).
// ============================================================================

import { existsSync } from 'node:fs'
import { whichSync } from '../../utils/which.js'
import * as path from 'node:path'
import { z } from 'zod/v4'
import { buildTool, type ToolEffectOutcome, type ToolUseContext } from '../../Tool.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { expandPath } from '../../utils/path.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import { mercuryGodotEnabled } from '../../services/lsp/godotLane.js'
import {
  findUnityProjectRoot,
  mercuryUnityEnabled,
} from '../../services/ide/unityProject.js'
import {
  adapterKeyForExtension,
  createDapSession,
  getDapSession,
  knownAdapterKeys,
  listDapSessions,
  probeGdbDap,
  removeDapSession,
  type DapBreakpointSpec,
  type DapSession,
} from '../../services/dap/dapClient.js'
import type { OwnerKey } from '../../services/run/ownerKey.js'
import { DEBUG_TOOL_NAME, getDebugToolDescription } from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'

const OPS = [
  'launch',
  'breakpoints',
  'threads',
  'stack',
  'scopes',
  'variables',
  'evaluate',
  'continue',
  'next',
  'stepIn',
  'stepOut',
  'pause',
  'output',
  'status',
  'disconnect',
  // high-frequency inspection additions, each
  // capability-gated against the adapter's initialize response.
  'loadedSources',
  'modules',
  'exceptionBreakpoints',
  'source',
  'completions',
  'setVariable',
  // The native-debugging expansion. attach is permissioned
  // like launch; the rest are capability-gated with precise refusals.
  'attach',
  'functionBreakpoints',
  'disassemble',
  'readMemory',
  'restart',
  // The escape hatch: any DAP request verbatim (permission-gated —
  // an arbitrary request can mutate the debuggee).
  'customRequest',
] as const

const inputSchema = lazySchema(() =>
  z.strictObject({
    op: z.enum(OPS).describe('The debug operation to perform'),
    session: z
      .string()
      .optional()
      .describe('Named session (default "main"); a re-launch on the same name replaces it'),
    adapter: z
      .string()
      .optional()
      .describe('Adapter key for launch (python | lldb | MERCURY_DAP_ADAPTERS key); inferred from the program extension when omitted'),
    program: z.string().optional().describe('Program path for launch'),
    args: z.array(z.string()).optional().describe('Program arguments for launch'),
    stopOnEntry: semanticBoolean(z.boolean().optional()).describe('Stop at the first instruction (launch)'),
    file: z.string().optional().describe('Source file for breakpoints'),
    lines: z.array(semanticNumber(z.number().int().positive())).optional().describe('Breakpoint lines (replaces the set for the file)'),
    breakpoints: z
      .array(
        z.strictObject({
          line: semanticNumber(z.number().int().positive()),
          condition: z.string().optional().describe('Stop only when this expression is true (capability-gated)'),
          hitCondition: z.string().optional().describe('Stop after N hits, e.g. "3" (capability-gated)'),
          logMessage: z.string().optional().describe('Log instead of stopping — a logpoint (capability-gated)'),
        }),
      )
      .optional()
      .describe('Rich breakpoints for file (replaces the set; use INSTEAD of lines when conditions/hit counts/logpoints are needed)'),
    pid: semanticNumber(z.number().int().positive().optional()).describe('attach: the running process id (or give port/program instead)'),
    port: semanticNumber(z.number().int().positive().max(65_535).optional()).describe('attach: the debuggee\'s listening debug port (adapter auto-picks python for bare ports)'),
    host: z.string().optional().describe('attach: the debug host (default 127.0.0.1)'),
    method: z.string().optional().describe('customRequest: the DAP request command to send verbatim'),
    body: z.string().optional().describe('customRequest: the request arguments as JSON text'),
    functions: z.array(z.string()).optional().describe('functionBreakpoints: function names to break on (replaces the function-breakpoint set)'),
    memoryReference: z.string().optional().describe('disassemble/readMemory: a memory reference (e.g. a stack frame\'s [ip …])'),
    count: semanticNumber(z.number().int().positive().optional()).describe('readMemory: byte count (bounded to 4096)'),
    offset: semanticNumber(z.number().int().optional()).describe('disassemble/readMemory: byte offset from the memory reference'),
    instructionCount: semanticNumber(z.number().int().positive().optional()).describe('disassemble: instructions to decode (bounded to 64, default 16)'),
    granularity: z
      .enum(['statement', 'instruction'])
      .optional()
      .describe('next/stepIn: step granularity — "instruction" steps one machine instruction (capability-gated)'),
    threadId: semanticNumber(z.number().int().optional()).describe('Thread for stack/continue/step/pause (defaults to the stopped thread)'),
    frameId: semanticNumber(z.number().int().optional()).describe('Frame for scopes/evaluate (from stack)'),
    variablesReference: semanticNumber(z.number().int().optional()).describe('Reference from scopes/variables to expand (variables/setVariable)'),
    expression: z.string().optional().describe('Expression for evaluate (runs in the debuggee)'),
    filters: z
      .array(z.string())
      .optional()
      .describe('exceptionBreakpoints: filter ids to arm (omit to LIST the adapter\'s available filters)'),
    sourceReference: semanticNumber(z.number().int().optional()).describe('source: the sourceReference from a stack frame or loadedSources (>0)'),
    name: z.string().optional().describe('setVariable: the variable name inside variablesReference'),
    value: z.string().optional().describe('setVariable: the new value expression'),
    text: z.string().optional().describe('completions: the partial expression to complete (frameId optional)'),
  }),
)

type SchemaType = ReturnType<typeof inputSchema>
export type Input = z.infer<SchemaType>
export type Output = {
  op: Input['op']
  result: string
  /** The typed operation outcome (mirrors the ToolEffect for the renderer). */
  outcome: ToolEffectOutcome
  /** Debuggee state after the op, when it is knowable. */
  debuggee?: 'stopped' | 'running' | 'terminated'
}

/** One op's typed result — runOp never lies through prose. */
type OpResult = {
  result: string
  outcome: ToolEffectOutcome
  debuggee?: 'stopped' | 'running' | 'terminated'
  details?: Record<string, unknown>
}

const INSPECT_OPS = new Set<Input['op']>([
  'threads',
  'stack',
  'scopes',
  'variables',
  'output',
  'status',
  'loadedSources',
  'modules',
  'source',
  'completions',
  'disassemble',
  'readMemory',
])

/** The shared executable-lookup owner (PATHEXT on Windows): the bare-name
 *  PATH walk never saw lldb-dap.exe, and this tool's own probe disagreed
 *  with doctor's for the same binary on the same PATH (TASK-014 w4-f16-04). */
function lldbDapOnPath(): boolean {
  return whichSync('lldb-dap') !== null
}

function inferAdapter(program: string): string {
  if (program.endsWith('.py')) return 'python'
  const ext = path.extname(program).toLowerCase()
  // A Unity project's .cs prefers the unity attach row — armed AND
  // root-marker gated, checked BEFORE the declared-extension ladder so a
  // netcoredbg install cannot shadow the editor attach inside a Unity
  // project. A bare .cs elsewhere keeps the ladder (dotnet first); the
  // unity-project-directory shape routes like the godot one below.
  if (mercuryUnityEnabled()) {
    const isProjectDir =
      existsSync(path.join(program, 'Assets')) &&
      existsSync(path.join(program, 'ProjectSettings'))
    if (
      isProjectDir ||
      (ext === '.cs' &&
        findUnityProjectRoot(path.dirname(path.resolve(program))) !== undefined)
    ) {
      return 'unity'
    }
  }
  // Config-file/builtin rows declare their extensions — the auto-pick scan
  // covers dlv/js/netcoredbg/rdbg and every operator-declared adapter.
  if (ext) {
    const declared = adapterKeyForExtension(ext)
    if (declared) return declared
  }
  // Godot-shaped programs route to the editor adapter only while the lane is
  // armed — otherwise resolveAdapter('godot') would refuse with a confusing
  // "unknown adapter" for what is really an un-armed lane.
  if (
    mercuryGodotEnabled() &&
    (program.endsWith('project.godot') ||
      program.endsWith('.tscn') ||
      program.endsWith('.gd') ||
      existsSync(path.join(program, 'project.godot')))
  ) {
    return 'godot'
  }
  // Native default is lldb; when lldb-dap is NOT on PATH but a DAP-capable
  // gdb (14+) is, infer the probed fallback (the common Linux shape).
  if (!lldbDapOnPath() && probeGdbDap().viable) return 'gdb'
  return 'lldb'
}

function requireSession(
  owner: OwnerKey,
  id: string,
): { session: DapSession } | { error: string } {
  const session = getDapSession(owner, id)
  if (!session) {
    const live = listDapSessions(owner).map(s => s.id)
    return {
      error:
        `no debug session '${id}'` +
        (live.length ? ` (live: ${live.join(', ')})` : '') +
        ` — start one with op:"launch".`,
    }
  }
  return { session }
}

/** Resolve the alias to its tree root AND the member that owns the debuggee
 *  conversation (multi-session adapters stop in their children). Ambiguity —
 *  several live children, none stopped — is a TYPED refusal naming the tree,
 *  never a silent guess (R1). */
function requireTarget(
  owner: OwnerKey,
  id: string,
): { root: DapSession; target: DapSession } | { error: string } {
  const r = requireSession(owner, id)
  if ('error' in r) return r
  const picked = r.session.debugTarget()
  if ('ambiguousDetail' in picked) {
    return { error: `session '${id}': ${picked.ambiguousDetail}` }
  }
  return { root: r.session, target: picked.session }
}

async function resolveThreadId(session: DapSession, explicit?: number): Promise<number> {
  if (explicit !== undefined) return explicit
  if (session.lastStopped?.threadId !== undefined) return session.lastStopped.threadId
  const body = await session.request('threads')
  const threads = Array.isArray(body.threads)
    ? (body.threads as Array<{ id?: number }>)
    : []
  const first = threads[0]?.id
  if (first === undefined) throw new Error('no threads reported by the adapter')
  return first
}

async function formatStackTop(session: DapSession, threadId: number, depth = 3): Promise<string> {
  const body = await session.request('stackTrace', { threadId, startFrame: 0, levels: depth })
  const frames = Array.isArray(body.stackFrames)
    ? (body.stackFrames as Array<{
        id?: number
        name?: string
        line?: number
        source?: { path?: string; name?: string }
        instructionPointerReference?: string
      }>)
    : []
  if (frames.length === 0) return '(no frames)'
  return frames
    .map(
      (f, i) =>
        `#${i} ${f.name ?? '?'} (${f.source?.path ?? f.source?.name ?? '?'}:${f.line ?? '?'})` +
        (f.id !== undefined ? ` [frameId ${f.id}]` : '') +
        // The memory reference disassemble/readMemory consume — surfaced on
        // the frame line so the model never has to guess an address.
        (f.instructionPointerReference ? ` [ip ${f.instructionPointerReference}]` : ''),
    )
    .join('\n')
}

/** Event-driven stop report: names the debuggee state HONESTLY — a timeout
 *  is 'still running' (indeterminate for mutating waits), never a lie.
 *  TREE-AWARE: the wait routes to the stopped MEMBER (multi-session
 *  adapters stop in their children — the report names it), verified counts
 *  read the tree-merged truth, and `sinceStamp` (captured before
 *  continue/step/pause) keeps an older sibling stop from answering a step.
 *  The details carry the STRUCTURED stop card
 *  (reason · thread · top frame · verified breakpoints) — the compact truth
 *  the transcript card and doctor read without re-parsing prose. */
async function reportStop(root: DapSession, label: string, sinceStamp = 0): Promise<OpResult> {
  const outcome = await root.waitForStopOutcome(10_000, undefined, sinceStamp)
  if (outcome.state === 'terminated') {
    // The debuggee's final stdout can trail the terminated event (the
    // debugpy launcher-channel race) — drain briefly so the report carries
    // what the program actually printed. The ring is tree-shared.
    await root.drainOutput()
    const tail = root.output.slice(-8).join('\n')
    return {
      result: `${label}: debuggee terminated (${root.exitDetail || 'clean exit'})${tail ? `\noutput:\n${tail}` : ''}`,
      outcome: 'succeeded',
      debuggee: 'terminated',
    }
  }
  if (outcome.state === 'timeout' || outcome.state === 'aborted') {
    return {
      result: `${label}: still running after 10s — op:"pause" to interrupt, op:"output" to inspect`,
      outcome: 'succeeded',
      debuggee: 'running',
    }
  }
  const stopped = outcome.info
  const at = outcome.session
  const threadId = stopped.threadId
  const top =
    threadId !== undefined
      ? await formatStackTop(at, threadId).catch(e => `(stack unavailable: ${(e as Error).message})`)
      : '(no thread)'
  const topLine = top.split('\n')[0] ?? ''
  const frameMatch = topLine.match(/^#0 (.+) \((.+):(\d+)\)/)
  const verifiedBreakpoints = [...root.treeVerifiedBreakpoints().values()]
    .flat()
    .filter(b => b.verified).length
  return {
    result:
      `${label}: stopped${at !== root ? ` in '${at.label}'` : ''} — reason ${stopped.reason}` +
      (stopped.description ? ` (${stopped.description})` : '') +
      (threadId !== undefined ? `, threadId ${threadId}` : '') +
      `\n${top}`,
    outcome: 'succeeded',
    debuggee: 'stopped',
    details: {
      stopCard: {
        reason: stopped.reason,
        ...(stopped.description ? { description: stopped.description } : {}),
        ...(threadId !== undefined ? { threadId } : {}),
        ...(at !== root ? { session: at.label } : {}),
        ...(frameMatch
          ? {
              topFrame: {
                name: frameMatch[1],
                path: frameMatch[2],
                line: Number(frameMatch[3]),
              },
            }
          : {}),
        verifiedBreakpoints,
      },
    },
  }
}

/**
 * Capability gate for the optional-request additions:
 * null = supported (or unknown — the request is attempted and adapter errors
 * surface typed); an OpResult = the precise unsupported answer.
 */
function gateCapability(
  session: DapSession,
  capability: string,
  op: string,
): OpResult | null {
  const caps = session.capabilities
  if (!caps) return null // pre-capability session — attempt; errors are typed
  const value = caps[capability]
  const supported = value === true || (Array.isArray(value) && value.length > 0)
  if (supported) return null
  return {
    result: `adapter '${session.adapterKey}' does not support ${op} (capability ${capability} not advertised)`,
    outcome: 'no-change',
  }
}

/** The requested breakpoint set for a file: rich specs win over plain lines. */
function requestedBreakpoints(input: Input): DapBreakpointSpec[] | undefined {
  if (input.breakpoints?.length) return input.breakpoints
  if (input.lines?.length) return input.lines.map(line => ({ line }))
  return undefined
}

/** Tree-wide capability gate for breakpoint features: supported when ANY
 *  tree member advertises it (in the multi-session shape the CHILD is the
 *  verifier and the honest authority; a member with unknown caps allows the
 *  attempt). Single-session trees degenerate to gateCapability exactly. */
function gateCapabilityTree(root: DapSession, capability: string, op: string): OpResult | null {
  for (const s of root.treeSessions()) {
    const caps = s.capabilities
    if (!caps) return null // pre-capability member — attempt; errors are typed
    const value = caps[capability]
    if (value === true || (Array.isArray(value) && value.length > 0)) return null
  }
  return {
    result: `adapter '${root.adapterKey}' does not support ${op} (capability ${capability} not advertised by any session in the tree)`,
    outcome: 'no-change',
  }
}

/** Gate the RICH breakpoint fields against the tree's capabilities —
 *  precise per-feature refusals (a plain-line set never gates). */
function gateRichBreakpoints(session: DapSession, specs: DapBreakpointSpec[]): OpResult | null {
  if (specs.some(s => s.condition !== undefined)) {
    const gated = gateCapabilityTree(session, 'supportsConditionalBreakpoints', 'conditional breakpoints')
    if (gated) return gated
  }
  if (specs.some(s => s.hitCondition !== undefined)) {
    const gated = gateCapabilityTree(session, 'supportsHitConditionalBreakpoints', 'hit-count breakpoints')
    if (gated) return gated
  }
  if (specs.some(s => s.logMessage !== undefined)) {
    const gated = gateCapabilityTree(session, 'supportsLogPoints', 'logpoints')
    if (gated) return gated
  }
  return null
}

/** Launch-time rich breakpoints ride the dance BEFORE capabilities can gate
 *  them — surface any unadvertised feature as a loud note, never silently. */
function richBreakpointCaveats(session: DapSession, specs: DapBreakpointSpec[]): string {
  const caveats: string[] = []
  const caps = session.capabilities
  if (!caps) return ''
  if (specs.some(s => s.condition !== undefined) && caps.supportsConditionalBreakpoints !== true) {
    caveats.push('supportsConditionalBreakpoints not advertised — conditions may be ignored')
  }
  if (specs.some(s => s.hitCondition !== undefined) && caps.supportsHitConditionalBreakpoints !== true) {
    caveats.push('supportsHitConditionalBreakpoints not advertised — hit counts may be ignored')
  }
  if (specs.some(s => s.logMessage !== undefined) && caps.supportsLogPoints !== true) {
    caveats.push('supportsLogPoints not advertised — logpoints may be ignored')
  }
  return caveats.length ? ` CAVEAT: ${caveats.join('; ')}.` : ''
}

const READ_MEMORY_MAX_BYTES = 4096
const READ_MEMORY_DEFAULT_BYTES = 256
const DISASSEMBLE_MAX_INSTRUCTIONS = 64
const DISASSEMBLE_DEFAULT_INSTRUCTIONS = 16

async function runOp(input: Input, owner: OwnerKey): Promise<OpResult> {
  const sessionId = input.session ?? 'main'
  switch (input.op) {
    case 'launch':
    case 'attach': {
      const attach = input.op === 'attach'
      const program = input.program
      if (!attach && !program) return { result: 'launch needs program', outcome: 'failed' }
      if (attach && !program && input.pid === undefined && input.port === undefined) {
        return { result: 'attach needs pid, port, or program', outcome: 'failed' }
      }
      // Adapter auto-pick: explicit key > program extension > (attach-by-
      // port prefers the Python adapter — the debugpy socket is the common
      // bare-port debuggee) > native default.
      const adapterKey =
        input.adapter ??
        (program
          ? inferAdapter(program)
          : attach && input.port !== undefined
            ? 'python'
            : 'lldb')
      const breakpoints = new Map<string, Array<number | DapBreakpointSpec>>()
      const requested = requestedBreakpoints(input)
      if (input.file && requested) {
        breakpoints.set(expandPath(input.file), requested)
      }
      const displayProgram =
        program ?? (input.pid !== undefined ? `pid ${input.pid}` : `${input.host ?? '127.0.0.1'}:${input.port}`)
      const session = await createDapSession({
        owner,
        id: sessionId,
        adapterKey,
        program: program
          ? expandPath(program)
          : input.pid !== undefined
            ? `pid:${input.pid}`
            : `port:${input.port}`,
        args: input.args,
        cwd: getCwd(),
        stopOnEntry: input.stopOnEntry,
        breakpoints: breakpoints.size ? breakpoints : undefined,
        ...(attach
          ? {
              mode: 'attach' as const,
              pid: input.pid,
              port: input.port,
              ...(input.host !== undefined ? { host: input.host } : {}),
            }
          : {}),
      })
      const caveat = requested ? richBreakpointCaveats(session, requested) : ''
      // The breakpoint note reads the TREE-MERGED truth — and for the
      // stopping arm it is built AFTER the stop wait, because the verifying
      // child of a multi-session adapter attaches moments after launch (a
      // pre-stop read would honestly-but-uselessly say UNVERIFIED).
      const bpDetailNow = (): string =>
        breakpoints.size > 0
          ? [...session.treeVerifiedBreakpoints().entries()]
              .map(
                ([f, bps]) =>
                  `${f}: ${bps
                    .map(
                      b =>
                        `line ${b.line} ${
                          b.verified
                            ? `verified${b.verifier && b.verifier !== session.label ? ` by ${b.verifier}` : ''}`
                            : // The adapter's own words beside the mark: js-debug
                              // answers "breakpoint.provisionalBreakpoint" and then
                              // proves the binding by STOPPING there (live-driven).
                              `UNVERIFIED${b.message ? ` (${b.message})` : ''}`
                        }`,
                    )
                    .join(', ')}`,
              )
              .join('; ')
          : ''
      const verb = attach ? 'attached to' : 'launched'
      if (input.stopOnEntry || breakpoints.size || attach) {
        const stop = await reportStop(session, 'first stop')
        const bpDetail = bpDetailNow()
        const bpNote = bpDetail ? `breakpoints — ${bpDetail};${caveat} ` : caveat ? `${caveat} ` : ''
        return {
          result: `${verb} ${displayProgram} via ${adapterKey} (session '${sessionId}'). ${bpNote}${stop.result}`,
          outcome: 'succeeded',
          debuggee: stop.debuggee,
          ...(stop.details ? { details: stop.details } : {}),
        }
      }
      const bpDetail = bpDetailNow()
      const bpNote = bpDetail ? `breakpoints — ${bpDetail};${caveat} ` : caveat ? `${caveat} ` : ''
      return {
        result: `${verb} ${displayProgram} via ${adapterKey} (session '${sessionId}'). ${bpNote}running — op:"output"/"pause"/"status" to observe.`,
        outcome: 'succeeded',
        debuggee: 'running',
      }
    }
    case 'breakpoints': {
      const r = requireSession(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      const requested = requestedBreakpoints(input)
      if (!input.file || !requested) {
        return { result: 'breakpoints needs file + lines (or the rich breakpoints array)', outcome: 'failed' }
      }
      const gated = gateRichBreakpoints(r.session, requested)
      if (gated) return gated
      // Tree-wide: every member gets the set (the child of a multi-session
      // adapter is the verifier), later children inherit it, and the report
      // is the merged truth naming the verifier.
      const verified = await r.session.setBreakpointsTree(expandPath(input.file), requested)
      const detail = verified
        .map(
          b =>
            `line ${b.line}: ${
              b.verified
                ? `verified${b.verifier && b.verifier !== r.session.label ? ` by ${b.verifier}` : ''}`
                : 'UNVERIFIED'
            }${b.message ? ` (${b.message})` : ''}`,
        )
        .join(', ')
      return {
        result: `breakpoints on ${input.file}: ${detail || '(none reported)'}`,
        outcome: 'succeeded',
        details: { breakpoints: verified },
      }
    }
    case 'functionBreakpoints': {
      const r = requireTarget(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      const gated = gateCapability(r.target, 'supportsFunctionBreakpoints', 'functionBreakpoints')
      if (gated) return gated
      if (!input.functions) {
        return { result: 'functionBreakpoints needs functions (empty array clears the set)', outcome: 'failed' }
      }
      const body = await r.target.request('setFunctionBreakpoints', {
        breakpoints: input.functions.map(name => ({ name })),
      })
      const reported = Array.isArray(body.breakpoints)
        ? (body.breakpoints as Array<{ verified?: boolean; message?: string }>)
        : []
      const detail = input.functions
        .map(
          (name, i) =>
            `${name}: ${reported[i]?.verified === true ? 'verified' : 'UNVERIFIED'}${reported[i]?.message ? ` (${reported[i]?.message})` : ''}`,
        )
        .join(', ')
      return {
        result: input.functions.length
          ? `function breakpoints: ${detail}`
          : 'function breakpoints cleared',
        outcome: 'succeeded',
      }
    }
    case 'threads': {
      const r = requireTarget(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      const body = await r.target.request('threads')
      const threads = Array.isArray(body.threads)
        ? (body.threads as Array<{ id?: number; name?: string }>)
        : []
      return {
        result: threads.length
          ? threads.map(t => `thread ${t.id}: ${t.name ?? '?'}`).join('\n')
          : '(no threads)',
        outcome: 'no-change',
      }
    }
    case 'stack': {
      const r = requireTarget(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      const threadId = await resolveThreadId(r.target, input.threadId)
      return { result: await formatStackTop(r.target, threadId, 20), outcome: 'no-change' }
    }
    case 'scopes': {
      const r = requireTarget(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      if (input.frameId === undefined) {
        return { result: 'scopes needs frameId (from op:"stack")', outcome: 'failed' }
      }
      const body = await r.target.request('scopes', { frameId: input.frameId })
      const scopes = Array.isArray(body.scopes)
        ? (body.scopes as Array<{ name?: string; variablesReference?: number }>)
        : []
      return {
        result: scopes.length
          ? scopes
              .map(s => `${s.name ?? '?'} [variablesReference ${s.variablesReference ?? '?'}]`)
              .join('\n')
          : '(no scopes)',
        outcome: 'no-change',
      }
    }
    case 'variables': {
      const r = requireTarget(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      if (input.variablesReference === undefined) {
        return {
          result: 'variables needs variablesReference (from op:"scopes" or a structured variable)',
          outcome: 'failed',
        }
      }
      const body = await r.target.request('variables', {
        variablesReference: input.variablesReference,
      })
      const vars = Array.isArray(body.variables)
        ? (body.variables as Array<{
            name?: string
            value?: string
            type?: string
            variablesReference?: number
          }>)
        : []
      return {
        result: vars.length
          ? vars
              .map(
                v =>
                  `${v.name ?? '?'} = ${v.value ?? '?'}` +
                  (v.type ? ` (${v.type})` : '') +
                  (v.variablesReference ? ` [ref ${v.variablesReference}]` : ''),
              )
              .join('\n')
          : '(no variables)',
        outcome: 'no-change',
      }
    }
    case 'evaluate': {
      const r = requireTarget(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      if (!input.expression) return { result: 'evaluate needs expression', outcome: 'failed' }
      const body = await r.target.request('evaluate', {
        expression: input.expression,
        frameId: input.frameId,
        context: 'repl',
      })
      const debuggee = r.root.treeTerminated()
        ? ('terminated' as const)
        : r.root.treeStopped()
          ? ('stopped' as const)
          : ('running' as const)
      return {
        result: `${input.expression} = ${String(body.result ?? '?')}${body.type ? ` (${String(body.type)})` : ''} [debuggee ${debuggee}]`,
        outcome: 'succeeded',
        debuggee,
      }
    }
    case 'continue':
    case 'next':
    case 'stepIn':
    case 'stepOut': {
      const r = requireTarget(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      // Instruction-granularity stepping (next/stepIn only) is capability-
      // gated; the default statement granularity never gates.
      const wantsInstruction =
        input.granularity === 'instruction' && (input.op === 'next' || input.op === 'stepIn')
      if (wantsInstruction) {
        const gated = gateCapability(r.target, 'supportsSteppingGranularity', `${input.op} (granularity instruction)`)
        if (gated) return gated
      }
      const threadId = await resolveThreadId(r.target, input.threadId)
      // Capture BEFORE clearing: only a stop NEWER than the pre-step world
      // answers this step (an older sibling stop must not).
      const sinceStamp = r.root.treeNewestStopStamp()
      r.target.lastStopped = null
      await r.target.request(input.op, {
        threadId,
        ...(wantsInstruction ? { granularity: 'instruction' } : {}),
      })
      return await reportStop(r.root, wantsInstruction ? `${input.op} (instruction)` : input.op, sinceStamp)
    }
    case 'restart': {
      const r = requireSession(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      const caps = r.session.capabilities
      if (caps && caps.supportsRestartRequest !== true) {
        return {
          result: `adapter '${r.session.adapterKey}' does not support restart (capability supportsRestartRequest not advertised) — op:"disconnect" then a fresh op:"launch" is the manual path`,
          outcome: 'no-change',
        }
      }
      const sinceStamp = r.session.treeNewestStopStamp()
      r.session.lastStopped = null
      await r.session.request('restart', {})
      return await reportStop(r.session, 'restart', sinceStamp)
    }
    case 'disassemble': {
      const r = requireTarget(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      const gated = gateCapability(r.target, 'supportsDisassembleRequest', 'disassemble')
      if (gated) return gated
      if (!input.memoryReference) {
        return {
          result: 'disassemble needs memoryReference (a stack frame\'s [ip …] from op:"stack")',
          outcome: 'failed',
        }
      }
      const count = Math.min(input.instructionCount ?? DISASSEMBLE_DEFAULT_INSTRUCTIONS, DISASSEMBLE_MAX_INSTRUCTIONS)
      const body = await r.target.request('disassemble', {
        memoryReference: input.memoryReference,
        offset: input.offset ?? 0,
        instructionOffset: 0,
        instructionCount: count,
        resolveSymbols: true,
      })
      const instructions = Array.isArray(body.instructions)
        ? (body.instructions as Array<{
            address?: string
            instruction?: string
            instructionBytes?: string
            symbol?: string
            location?: { path?: string }
            line?: number
          }>)
        : []
      return {
        result: instructions.length
          ? instructions
              .map(
                i =>
                  `${i.address ?? '?'}: ${i.instruction ?? '?'}` +
                  (i.symbol ? ` <${i.symbol}>` : '') +
                  (i.location?.path && i.line !== undefined ? `  ; ${i.location.path}:${i.line}` : ''),
              )
              .join('\n')
          : '(no instructions returned)',
        outcome: 'no-change',
      }
    }
    case 'readMemory': {
      const r = requireTarget(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      const gated = gateCapability(r.target, 'supportsReadMemoryRequest', 'readMemory')
      if (gated) return gated
      if (!input.memoryReference) {
        return {
          result: 'readMemory needs memoryReference (a stack frame\'s [ip …] from op:"stack")',
          outcome: 'failed',
        }
      }
      const count = Math.min(input.count ?? READ_MEMORY_DEFAULT_BYTES, READ_MEMORY_MAX_BYTES)
      const body = await r.target.request('readMemory', {
        memoryReference: input.memoryReference,
        offset: input.offset ?? 0,
        count,
      })
      const data = typeof body.data === 'string' ? Buffer.from(body.data, 'base64') : Buffer.alloc(0)
      const address = String(body.address ?? input.memoryReference)
      const unreadable = typeof body.unreadableBytes === 'number' ? body.unreadableBytes : 0
      if (data.length === 0) {
        return {
          result: `readMemory at ${address}: 0 bytes readable${unreadable ? ` (${unreadable} unreadable)` : ''}`,
          outcome: 'no-change',
        }
      }
      const rows: string[] = []
      for (let i = 0; i < data.length; i += 16) {
        const slice = data.subarray(i, i + 16)
        const hex = [...slice].map(b => b.toString(16).padStart(2, '0')).join(' ')
        const ascii = [...slice].map(b => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('')
        rows.push(`+0x${i.toString(16).padStart(4, '0')}  ${hex.padEnd(47)}  ${ascii}`)
      }
      return {
        result:
          `memory at ${address} (${data.length} bytes${unreadable ? `, ${unreadable} unreadable` : ''}):\n` +
          rows.join('\n'),
        outcome: 'no-change',
      }
    }
    case 'pause': {
      const r = requireTarget(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      const threadId = await resolveThreadId(r.target, input.threadId)
      const sinceStamp = r.root.treeNewestStopStamp()
      await r.target.request('pause', { threadId })
      return await reportStop(r.root, 'pause', sinceStamp)
    }
    case 'output': {
      const r = requireSession(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      const drained = r.session.output.splice(0, r.session.output.length)
      return {
        result: drained.length ? drained.join('\n') : '(no buffered output)',
        outcome: 'no-change',
      }
    }
    case 'status': {
      const all = listDapSessions(owner)
      if (all.length === 0) {
        return {
          result: `no debug sessions. adapters: ${knownAdapterKeys().join(', ')}`,
          outcome: 'no-change',
        }
      }
      const stateOf = (s: DapSession): string =>
        s.terminated
          ? `terminated (${s.exitDetail || 'exit'})`
          : s.lastStopped
            ? `stopped (${s.lastStopped.reason}, threadId ${s.lastStopped.threadId ?? '?'})`
            : 'running'
      return {
        result: all
          .map(({ id, session }) => {
            // The tree, whole: the root line, one line per child (depth
            // shown past 1), and the MERGED breakpoint truth naming the
            // verifier via the unverified '?' marks it clears.
            const lines = [
              `session '${id}': ${session.program} via ${session.adapterKey} — ${stateOf(session)}`,
            ]
            for (const s of session.treeSessions().slice(1)) {
              lines.push(`  child '${s.label}'${s.depth > 1 ? ` (depth ${s.depth})` : ''}: ${stateOf(s)}`)
            }
            const bps = [...session.treeVerifiedBreakpoints().entries()]
              .map(
                ([f, list]) =>
                  `${f}:${list.map(b => `${b.line}${b.verified ? '' : '?'}`).join(',')}`,
              )
              .join(' · ')
            if (bps) lines.push(`  breakpoints: ${bps}`)
            return lines.join('\n')
          })
          .join('\n'),
        outcome: 'no-change',
      }
    }
    case 'customRequest': {
      const r = requireSession(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      if (!input.method) return { result: 'customRequest needs method (the DAP command)', outcome: 'failed' }
      let args: Record<string, unknown> = {}
      if (input.body !== undefined && input.body !== '') {
        try {
          const parsed = JSON.parse(input.body) as unknown
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { result: 'customRequest body must be a JSON object', outcome: 'failed' }
          }
          args = parsed as Record<string, unknown>
        } catch (e) {
          return { result: `customRequest body is not valid JSON: ${(e as Error).message}`, outcome: 'failed' }
        }
      }
      const body = await r.session.request(input.method, args)
      const text = JSON.stringify(body, null, 2) ?? 'null'
      const clipped = text.length > 20_000
      return {
        result:
          `${input.method}:\n` +
          (clipped ? `${text.slice(0, 20_000)}\n… (${text.length - 20_000} more chars)` : text),
        outcome: 'succeeded',
        details: { method: input.method },
      }
    }
    case 'disconnect': {
      // Read the start mode BEFORE the removal: an attached target is left
      // running by the detach, and the receipt says so (never "terminated").
      const detached = getDapSession(owner, sessionId)?.startMode === 'attach'
      const removed = await removeDapSession(owner, sessionId)
      if (!removed) return { result: `no session '${sessionId}' to disconnect`, outcome: 'no-change' }
      return detached
        ? {
            result: `session '${sessionId}' disconnected (detached — the target keeps running; adapter reaped)`,
            outcome: 'succeeded',
            debuggee: 'running',
          }
        : {
            result: `session '${sessionId}' disconnected (debuggee terminated, adapter reaped)`,
            outcome: 'succeeded',
            debuggee: 'terminated',
          }
    }
    case 'loadedSources': {
      const r = requireTarget(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      const gated = gateCapability(r.target, 'supportsLoadedSourcesRequest', 'loadedSources')
      if (gated) return gated
      const body = await r.target.request('loadedSources')
      const sources = Array.isArray(body.sources)
        ? (body.sources as Array<{ name?: string; path?: string; sourceReference?: number }>)
        : []
      const shown = sources.slice(0, 100)
      return {
        result: shown.length
          ? shown
              .map(
                s =>
                  `${s.path ?? s.name ?? '?'}${s.sourceReference ? ` [sourceReference ${s.sourceReference}]` : ''}`,
              )
              .join('\n') +
            (sources.length > shown.length ? `\n(+${sources.length - shown.length} more)` : '')
          : '(no loaded sources reported)',
        outcome: 'no-change',
      }
    }
    case 'modules': {
      const r = requireTarget(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      const gated = gateCapability(r.target, 'supportsModulesRequest', 'modules')
      if (gated) return gated
      const body = await r.target.request('modules', { startModule: 0, moduleCount: 100 })
      const modules = Array.isArray(body.modules)
        ? (body.modules as Array<{ name?: string; path?: string; id?: unknown }>)
        : []
      return {
        result: modules.length
          ? modules.map(m => `${m.name ?? '?'}${m.path ? ` (${m.path})` : ''}`).join('\n')
          : '(no modules reported)',
        outcome: 'no-change',
      }
    }
    case 'exceptionBreakpoints': {
      const r = requireTarget(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      const available = Array.isArray(r.target.capabilities?.exceptionBreakpointFilters)
        ? (r.target.capabilities!.exceptionBreakpointFilters as Array<{
            filter?: string
            label?: string
            default?: boolean
          }>)
        : []
      if (!input.filters) {
        return {
          result: available.length
            ? 'available exception filters:\n' +
              available
                .map(f => `${f.filter}: ${f.label ?? ''}${f.default ? ' (default)' : ''}`)
                .join('\n') +
              '\n\nRe-run with filters: ["<id>", …] to arm (empty array disarms all).'
            : `adapter '${r.target.adapterKey}' advertises no exception filters`,
          outcome: 'no-change',
        }
      }
      const known = new Set(available.map(f => f.filter))
      const unknown = input.filters.filter(f => !known.has(f))
      if (unknown.length > 0 && available.length > 0) {
        return {
          result: `unknown exception filter(s): ${unknown.join(', ')} — available: ${[...known].join(', ')}`,
          outcome: 'failed',
        }
      }
      await r.target.request('setExceptionBreakpoints', { filters: input.filters })
      return {
        result: input.filters.length
          ? `exception breakpoints armed: ${input.filters.join(', ')}`
          : 'exception breakpoints disarmed',
        outcome: 'succeeded',
      }
    }
    case 'source': {
      const r = requireTarget(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      if (!input.sourceReference || input.sourceReference <= 0) {
        return {
          result: 'source needs sourceReference > 0 (from stack frames or loadedSources; path-backed sources — just Read the file)',
          outcome: 'failed',
        }
      }
      const body = await r.target.request('source', {
        sourceReference: input.sourceReference,
        source: { sourceReference: input.sourceReference },
      })
      const content = String(body.content ?? '')
      return {
        result: content
          ? content.length > 20_000
            ? content.slice(0, 20_000) + `\n… (${content.length - 20_000} more chars truncated)`
            : content
          : '(empty source)',
        outcome: 'no-change',
      }
    }
    case 'completions': {
      const r = requireTarget(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      const gated = gateCapability(r.target, 'supportsCompletionsRequest', 'completions')
      if (gated) return gated
      if (!input.text) return { result: 'completions needs text', outcome: 'failed' }
      const body = await r.target.request('completions', {
        text: input.text,
        column: input.text.length + 1,
        ...(input.frameId !== undefined ? { frameId: input.frameId } : {}),
      })
      const targets = Array.isArray(body.targets)
        ? (body.targets as Array<{ label?: string; text?: string; type?: string }>)
        : []
      const shown = targets.slice(0, 50)
      return {
        result: shown.length
          ? shown.map(t => `${t.text ?? t.label ?? '?'}${t.type ? ` (${t.type})` : ''}`).join('\n') +
            (targets.length > shown.length ? `\n(+${targets.length - shown.length} more)` : '')
          : '(no completions)',
        outcome: 'no-change',
      }
    }
    case 'setVariable': {
      const r = requireTarget(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      const gated = gateCapability(r.target, 'supportsSetVariable', 'setVariable')
      if (gated) return gated
      if (input.variablesReference === undefined || !input.name || input.value === undefined) {
        return {
          result: 'setVariable needs variablesReference (from scopes) + name + value',
          outcome: 'failed',
        }
      }
      const body = await r.target.request('setVariable', {
        variablesReference: input.variablesReference,
        name: input.name,
        value: input.value,
      })
      return {
        result: `${input.name} = ${String(body.value ?? input.value)}${body.type ? ` (${String(body.type)})` : ''} [debuggee state mutated]`,
        outcome: 'succeeded',
        debuggee: r.target.lastStopped ? 'stopped' : 'running',
      }
    }
  }
}

export const DebugTool = buildTool({
  name: DEBUG_TOOL_NAME,
  // ToolSearch discovery metadata — names the godot adapter only while the
  // lane is armed (mirrors LSPTool's dynamic searchHint).
  get searchHint() {
    return (
      'real debugger via DAP: launch/attach, breakpoints (conditional/hit-count/logpoints), function breakpoints, stepping (incl. instruction), stack traces, scopes, variables, evaluate, disassemble, readMemory, restart (python debugpy, native lldb' +
      (probeGdbDap().viable ? '/gdb' : '') +
      (mercuryGodotEnabled() ? ', godot editor' : '') +
      ')'
    )
  },
  maxResultSizeChars: 100_000,
  async description() {
    return 'Drive a real debugger over DAP: breakpoints, stepping, stacks, scopes, variables, evaluate'
  },
  async prompt() {
    return getDebugToolDescription()
  },
  userFacingName,
  shouldDefer: true,
  get inputSchema(): SchemaType {
    return inputSchema()
  },
  isConcurrencySafe() {
    return false // one debugger, ordered ops
  },
  isReadOnly(input: Input) {
    return INSPECT_OPS.has(input.op)
  },
  async checkPermissions(input: Input) {
    // Launch executes a program and attach takes control of a running one —
    // both Bash-class, always a human/rule decision; everything else rides
    // the permitted session (evaluate runs IN the already-permitted debuggee,
    // restart re-runs the already-permitted program).
    if (input.op === 'launch') {
      return {
        behavior: 'ask' as const,
        message: `Debug launch: ${input.program ?? '?'}${input.args?.length ? ` ${input.args.join(' ')}` : ''} (adapter ${input.adapter ?? inferAdapter(input.program ?? '')})`,
      }
    }
    if (input.op === 'attach') {
      const target =
        input.program ??
        (input.pid !== undefined
          ? `pid ${input.pid}`
          : input.port !== undefined
            ? `${input.host ?? '127.0.0.1'}:${input.port}`
            : '?')
      const adapter =
        input.adapter ??
        (input.program ? inferAdapter(input.program) : input.port !== undefined ? 'python' : 'lldb')
      return {
        behavior: 'ask' as const,
        message: `Debug attach: ${target} (adapter ${adapter})`,
      }
    }
    if (input.op === 'customRequest') {
      // An arbitrary DAP request can mutate the debuggee — always a
      // human/rule decision, like launch/attach.
      return {
        behavior: 'ask' as const,
        message: `Debug custom request: ${input.method ?? '?'}${input.body ? ` ${input.body.slice(0, 120)}` : ''}`,
      }
    }
    return { behavior: 'allow' as const, updatedInput: input }
  },
  toAutoClassifierInput(input: Input) {
    if (input.op === 'launch') {
      return `debug launch: ${input.adapter ?? inferAdapter(input.program ?? '')} ${input.program ?? ''} ${(input.args ?? []).join(' ')}`
    }
    if (input.op === 'attach') {
      return `debug attach: ${input.adapter ?? (input.program ? inferAdapter(input.program) : 'lldb')} ${input.program ?? ''} ${input.pid !== undefined ? `pid ${input.pid}` : ''}`
    }
    if (input.op === 'evaluate') return `debug evaluate: ${input.expression ?? ''}`
    return ''
  },
  async validateInput(input: Input) {
    if (input.op === 'launch' && !input.program) {
      return { result: false as const, message: 'launch requires program', errorCode: 1 }
    }
    if (input.op === 'attach' && !input.program && input.pid === undefined && input.port === undefined) {
      return { result: false as const, message: 'attach requires pid, port, or program', errorCode: 1 }
    }
    if (input.op === 'customRequest' && !input.method) {
      return { result: false as const, message: 'customRequest requires method', errorCode: 1 }
    }
    if (input.op === 'breakpoints' && (!input.file || (!input.lines?.length && !input.breakpoints?.length))) {
      return { result: false as const, message: 'breakpoints requires file + lines (or the rich breakpoints array)', errorCode: 1 }
    }
    if (input.op === 'functionBreakpoints' && !input.functions) {
      return { result: false as const, message: 'functionBreakpoints requires functions (empty array clears)', errorCode: 1 }
    }
    if ((input.op === 'disassemble' || input.op === 'readMemory') && !input.memoryReference) {
      return { result: false as const, message: `${input.op} requires memoryReference (a stack frame's [ip …])`, errorCode: 1 }
    }
    if (input.op === 'evaluate' && !input.expression) {
      return { result: false as const, message: 'evaluate requires expression', errorCode: 1 }
    }
    if (input.op === 'variables' && input.variablesReference === undefined) {
      return { result: false as const, message: 'variables requires variablesReference', errorCode: 1 }
    }
    return { result: true as const }
  },
  async call(input: Input, context: ToolUseContext) {
    const owner = ownerFromToolUseContext(context)
    const startedAt = Date.now()
    let op: OpResult
    try {
      op = await runOp(input, owner)
    } catch (err) {
      // A thrown protocol/adapter failure IS a failure — typed, never prose
      // that reads as success (the chokepoint maps it to a tool error).
      op = { result: `${input.op} failed: ${(err as Error).message}`, outcome: 'failed' }
    }
    const output: Output = {
      op: input.op,
      result: op.result,
      outcome: op.outcome,
      ...(op.debuggee ? { debuggee: op.debuggee } : {}),
    }
    return {
      data: output,
      effect: {
        outcome: op.outcome,
        operation: `debug.${input.op}`,
        changedPaths: [],
        evidence: op.result.split('\n')[0]?.slice(0, 160) ?? '',
        startedAt,
        completedAt: Date.now(),
        ...(op.details || op.debuggee
          ? { details: { ...(op.details ?? {}), ...(op.debuggee ? { debuggee: op.debuggee } : {}) } }
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
  renderToolResultMessage,
  // HZ7 projection: the renderer paints `result` — search indexes the same.
  extractSearchText({ result }) {
    return result ?? ''
  },
})
