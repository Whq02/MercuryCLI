import { DapCancelledError, throwIfDapAborted } from '../../integrations/debugger/dapCancellation.js'
import { type DapTerminalRunner, createDapTerminalRunner } from '../../integrations/debugger/dapTerminal.js'
import { whichSync } from '../../platform/processes/which.js'
import { provisionDebugAdapter } from '../../integrations/debugger/adapterInstallConsent.js'
import { type CanUseToolFn, type ToolUseContext, buildTool } from '../kit/tool.js'
import { startedCommandVerdict } from '../shell/bashPermissions.js'
import { startedCommandText } from '../../platform/shell/bash/ast.js'
import { runtimeProcessRefusal } from '../../permissions/rules/runtimeProtection.js'
import { debuggerShellCommand } from '../../permissions/rules/flowLaw.js'
import { evalCodePermission } from '../../permissions/rules/shellProtectedPaths.js'
import { ownerFromToolUseContext } from '../../engine/run-owner/resolveOwner.js'
import { getCwd } from '../../platform/files/cwd.js'
import { expandPath } from '../../platform/files/path.js'
import { mercuryGodotEnabled } from '../../integrations/lsp/godotLane.js'
import { findUnityProjectRoot, mercuryUnityEnabled } from '../../integrations/unity-protocol/unityProject.js'
import {
  type DapBreakpointSpec,
  type DapFunctionBreakpointSpec,
  type DapSession,
  adapterKeyForExtension,
  createDapSession,
  gdbProbeFromMemo,
  getDapSession,
  listDapSessions,
  probeGdbDap,
  resolveAdapter,
} from '../../integrations/debugger/dapClient.js'
import { DEBUG_TOOL_NAME, DEBUG_WIRE_DESCRIPTION, getDebugToolDescription } from './prompt.js'
import { renderToolResultMessage, renderToolUseErrorMessage, renderToolUseMessage, userFacingName } from './rows.js'
import * as path from 'node:path'
import { existsSync } from 'node:fs'
import type { AssistantMessage } from '../../engine/message-shapes/message.js'
import type { PermissionResult } from '../../permissions/rules/permissionResult.js'
import type { OwnerKey } from '../../engine/run-owner/ownerKey.js'
import { type Input, type InputWith, type OpResult, type Output, type SchemaType, inputSchema } from './ops/schema.js'
import { formatStackTop, reportStop, resolveThreadId } from './ops/shared.js'
import {
  breakpointsOp,
  dataBreakpointsOp,
  exceptionBreakpointsOp,
  functionBreakpointsOp,
  instructionBreakpointsOp,
} from './ops/breakpoints.js'
import {
  completionsOp,
  evaluateOp,
  loadedSourcesOp,
  modulesOp,
  outputOp,
  scopesOp,
  sourceOp,
  statusOp,
  threadsOp,
  variablesOp,
} from './ops/inspect.js'
import { disassembleOp, readMemoryOp, setVariableOp, writeMemoryOp } from './ops/memory.js'
import { customRequestOp, disconnectOp, stepOp } from './ops/control.js'
export type { Input, OpResult, Output } from './ops/schema.js'

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

function lldbDapOnPath(): boolean {
  return whichSync('lldb-dap') !== null
}

function inferAdapter(program: string, cwd = getCwd()): string {
  if (program.endsWith('.py')) return 'python'
  const ext = path.extname(program).toLowerCase()
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
  const declared = adapterKeyForExtension(ext, expandPath(program, cwd))
  if (declared) return declared
  if (
    mercuryGodotEnabled() &&
    (program.endsWith('project.godot') ||
      program.endsWith('.tscn') ||
      program.endsWith('.gd') ||
      existsSync(path.join(program, 'project.godot')))
  ) {
    return 'godot'
  }
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

function gateCapability(
  session: DapSession,
  capability: string,
  op: string,
): OpResult | null {
  const caps = session.capabilities
  if (!caps) return null
  const value = caps[capability]
  const supported = value === true || (Array.isArray(value) && value.length > 0)
  if (supported) return null
  return {
    result: `adapter '${session.adapterKey}' does not support ${op} (capability ${capability} not advertised)`,
    outcome: 'no-change',
  }
}

function requestedBreakpoints(input: Input): DapBreakpointSpec[] | undefined {
  if (input.breakpoints?.length) return input.breakpoints
  if (input.lines?.length) return input.lines.map(line => ({ line }))
  if (input.breakpoints !== undefined || input.lines !== undefined) return []
  return undefined
}

function gateCapabilityTree(root: DapSession, capability: string, op: string): OpResult | null {
  for (const s of root.treeSessions()) {
    const caps = s.capabilities
    if (!caps) return null
    const value = caps[capability]
    if (value === true || (Array.isArray(value) && value.length > 0)) return null
  }
  return {
    result: `adapter '${root.adapterKey}' does not support ${op} (capability ${capability} not advertised by any session in the tree)`,
    outcome: 'no-change',
  }
}

function gateRichBreakpoints(
  session: DapSession,
  specs: Array<Pick<DapBreakpointSpec, 'condition' | 'hitCondition' | 'logMessage'>>,
): OpResult | null {
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

function decodeBase64Strict(data: string): Buffer | null {
  const compact = data.replace(/\s+/g, '')
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null
  return Buffer.from(compact, 'base64')
}

export async function runDebugLaunch(input: Input, owner: OwnerKey, opts: { cwd?: string; env?: Record<string, string>; module?: string; signal?: AbortSignal; terminalRunner?: DapTerminalRunner } = {}): Promise<OpResult> {
  const sessionId = input.session ?? 'main'
  const attach = input.op === 'attach'
  const program = input.program
  if (!attach && !program) return { result: 'launch needs program', outcome: 'failed' }
  if (attach && !program && input.pid === undefined && input.port === undefined) {
    return { result: 'attach needs pid, port, or program', outcome: 'failed' }
  }
  const adapterKey =
    input.adapter ??
    (program
      ? inferAdapter(program, opts.cwd)
      : attach && input.port !== undefined
        ? 'python'
        : 'lldb')
  const breakpoints = new Map<string, Array<number | DapBreakpointSpec>>()
  const requested = requestedBreakpoints(input)
  if (input.file && requested && requested.length > 0) {
    breakpoints.set(expandPath(input.file), requested)
  }
  const displayProgram =
    program ?? (input.pid !== undefined ? `pid ${input.pid}` : `${input.host ?? '127.0.0.1'}:${input.port}`)
  throwIfDapAborted(opts.signal)
  const session = await createDapSession({
    owner,
    signal: opts.signal,
    terminalRunner: opts.terminalRunner,
    id: sessionId,
    adapterKey,
    program: program
      ? opts.module !== undefined
        ? program
        : expandPath(program)
      : input.pid !== undefined
        ? `pid:${input.pid}`
        : `port:${input.port}`,
    args: input.args,
    cwd: opts.cwd ?? getCwd(),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.module !== undefined ? { module: opts.module } : {}),
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
                        :
                          `UNVERIFIED${b.message ? ` (${b.message})` : ''}`
                    }`,
                )
                .join(', ')}`,
          )
          .join('; ')
      : ''
  const verb = attach ? 'attached to' : 'launched'
  if (input.stopOnEntry || breakpoints.size || attach) {
    const stop = await session.withOperation(opts.signal, () => reportStop(session, 'first stop', 0, input.timeoutMs, opts.signal))
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

async function runOp(input: Input, owner: OwnerKey, signal?: AbortSignal, terminalRunner?: DapTerminalRunner): Promise<OpResult> {
  throwIfDapAborted(signal)
  const sessionId = input.session ?? 'main'
  switch (input.op) {
    case 'launch':
    case 'attach':
      return runDebugLaunch(input, owner, { signal, terminalRunner })
    case 'breakpoints': {
      const r = requireSession(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      const requested = requestedBreakpoints(input)
      if (!input.file || !requested) {
        return { result: 'breakpoints needs file + lines (or the rich breakpoints array); an empty array clears the file\'s breakpoints', outcome: 'failed' }
      }
      const gated = gateRichBreakpoints(r.session, requested)
      if (gated) return gated
      return breakpointsOp(r, input as InputWith<'file'>, requested)
    }
    case 'functionBreakpoints': {
      const r = requireSession(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      const gated = gateCapabilityTree(r.session, 'supportsFunctionBreakpoints', 'functionBreakpoints')
      if (gated) return gated
      if (!input.functions) {
        return { result: 'functionBreakpoints needs functions (empty array clears the set)', outcome: 'failed' }
      }
      const specs: DapFunctionBreakpointSpec[] = input.functions.map(f => (typeof f === 'string' ? { name: f } : f))
      const richGate = gateRichBreakpoints(r.session, specs)
      if (richGate) return richGate
      return functionBreakpointsOp(r, specs)
    }
    case 'threads': {
      const r = requireTarget(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      return threadsOp(r)
    }
    case 'stack': {
      const r = requireTarget(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      const threadId = await resolveThreadId(r.target, input.threadId)
      return { result: await formatStackTop(r.target, threadId, input.depth ?? 20), outcome: 'no-change' }
    }
    case 'scopes': {
      const r = requireTarget(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      if (input.frameId === undefined) {
        return { result: 'scopes needs frameId (from op:"stack")', outcome: 'failed' }
      }
      return scopesOp(r, input)
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
      return variablesOp(r, input)
    }
    case 'evaluate': {
      const r = requireTarget(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      if (!input.expression) return { result: 'evaluate needs expression', outcome: 'failed' }
      const context = input.context ?? 'repl'
      let frameId = input.frameId
      if (frameId === undefined) {
        if (!r.target.lastStopped) {
          const state = r.root.treeTerminated() ? ('terminated' as const) : ('running' as const)
          return {
            result:
              `evaluate needs a stopped frame: the debuggee is ${state} and no frameId was given — ` +
              (state === 'running' ? 'op:"pause" first, or give frameId from op:"stack"' : 'op:"launch" again'),
            outcome: 'failed',
            debuggee: state,
          }
        }
        const current = await r.target.stoppedFrameId()
        if (current === null) {
          return {
            result: `evaluate: the stopped thread reports no frame to evaluate in — give frameId from op:"stack"`,
            outcome: 'failed',
            debuggee: 'stopped',
          }
        }
        frameId = current
      }
      return evaluateOp(r, input, context, frameId)
    }
    case 'continue':
    case 'next':
    case 'stepIn':
    case 'stepOut': {
      const r = requireTarget(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      const wantsInstruction =
        input.granularity === 'instruction' && (input.op === 'next' || input.op === 'stepIn')
      if (wantsInstruction) {
        const gated = gateCapability(r.target, 'supportsSteppingGranularity', `${input.op} (granularity instruction)`)
        if (gated) return gated
      }
      return stepOp(r, input, wantsInstruction, signal)
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
      return await reportStop(r.session, 'restart', sinceStamp, input.timeoutMs, signal)
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
      return disassembleOp(r, input, count)
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
      return readMemoryOp(r, input, count)
    }
    case 'dataBreakpoints': {
      const r = requireTarget(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      const gated = gateCapability(r.target, 'supportsDataBreakpoints', 'dataBreakpoints')
      if (gated) return gated
      if (!input.dataBreakpoints) {
        return { result: 'dataBreakpoints needs dataBreakpoints (empty array clears the set)', outcome: 'failed' }
      }
      const richGate = gateRichBreakpoints(r.target, input.dataBreakpoints)
      if (richGate) return richGate
      if (input.dataBreakpoints.length === 0) {
        await r.target.setDataBreakpoints([])
        return { result: 'data breakpoints cleared', outcome: 'succeeded' }
      }
      return dataBreakpointsOp(r, input as InputWith<'dataBreakpoints'>)
    }
    case 'instructionBreakpoints': {
      const r = requireTarget(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      const gated = gateCapability(r.target, 'supportsInstructionBreakpoints', 'instructionBreakpoints')
      if (gated) return gated
      if (!input.instructionBreakpoints) {
        return { result: 'instructionBreakpoints needs instructionBreakpoints (empty array clears the set)', outcome: 'failed' }
      }
      const richGate = gateRichBreakpoints(r.target, input.instructionBreakpoints)
      if (richGate) return richGate
      if (input.instructionBreakpoints.length === 0) {
        await r.target.setInstructionBreakpoints([])
        return { result: 'instruction breakpoints cleared', outcome: 'succeeded' }
      }
      return instructionBreakpointsOp(r, input as InputWith<'instructionBreakpoints'>)
    }
    case 'writeMemory': {
      const r = requireTarget(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      const gated = gateCapability(r.target, 'supportsWriteMemoryRequest', 'writeMemory')
      if (gated) return gated
      if (!input.memoryReference || input.data === undefined) {
        return {
          result: 'writeMemory needs memoryReference (a variable\'s [memory …] or a frame\'s [ip …]) + data (base64)',
          outcome: 'failed',
        }
      }
      const bytes = decodeBase64Strict(input.data)
      if (bytes === null) {
        return { result: 'writeMemory data must be base64 (e.g. "KgAAAA==" for the bytes 2a 00 00 00)', outcome: 'failed' }
      }
      if (bytes.length === 0) return { result: 'writeMemory needs at least one byte of data', outcome: 'failed' }
      return writeMemoryOp(r, input as InputWith<'memoryReference'>, bytes)
    }
    case 'pause': {
      const r = requireTarget(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      const threadId = await resolveThreadId(r.target, input.threadId)
      const sinceStamp = r.root.treeNewestStopStamp()
      await r.target.request('pause', { threadId })
      return await reportStop(r.root, 'pause', sinceStamp, input.timeoutMs, signal)
    }
    case 'output': {
      const r = requireSession(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      return outputOp(r)
    }
    case 'status': {
      return statusOp(owner)
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
      return customRequestOp(r, input as InputWith<'method'>, args)
    }
    case 'disconnect': {
      const detached = getDapSession(owner, sessionId)?.startMode === 'attach'
      const session = getDapSession(owner, sessionId)
      return disconnectOp(owner, sessionId, signal, detached, session)
    }
    case 'loadedSources': {
      const r = requireTarget(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      const gated = gateCapability(r.target, 'supportsLoadedSourcesRequest', 'loadedSources')
      if (gated) return gated
      return loadedSourcesOp(r)
    }
    case 'modules': {
      const r = requireTarget(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      const gated = gateCapability(r.target, 'supportsModulesRequest', 'modules')
      if (gated) return gated
      return modulesOp(r)
    }
    case 'exceptionBreakpoints': {
      const r = requireTarget(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      return exceptionBreakpointsOp(r, input)
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
      return sourceOp(r, input)
    }
    case 'completions': {
      const r = requireTarget(owner, sessionId)
      if ('error' in r) return { result: r.error, outcome: 'failed' }
      const gated = gateCapability(r.target, 'supportsCompletionsRequest', 'completions')
      if (gated) return gated
      if (!input.text) return { result: 'completions needs text', outcome: 'failed' }
      return completionsOp(r, input as InputWith<'text'>)
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
      return setVariableOp(r, input)
    }
  }
}

const DEBUGGEE_TEXT_FIELDS: ReadonlySet<string> = new Set(['expression', 'value', 'condition', 'hitCondition', 'logMessage'])

function customRequestArguments(body: string | undefined): unknown {
  if (body === undefined) return {}
  try {
    return JSON.parse(body)
  } catch {
    return { expression: body }
  }
}

function textsTheDebuggeeRuns(input: unknown): string[] {
  const texts: string[] = []
  const visit = (value: unknown, field: string | null): void => {
    if (typeof value === 'string') {
      if (field !== null && DEBUGGEE_TEXT_FIELDS.has(field)) texts.push(value)
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item, field)
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, item] of Object.entries(value)) visit(item, key)
    }
  }
  visit(input, null)
  return texts
}

export const DebugTool = buildTool({
  name: DEBUG_TOOL_NAME,
  keepEmptyInputs: ['lines', 'breakpoints', 'functions', 'dataBreakpoints', 'instructionBreakpoints'],
  straightQuoteInputs: ['program', 'file', 'expression', 'name', 'value', 'text', 'functions'],
  searchHint: 'drive a real debugger over DAP: launch or attach, breakpoints, stepping, stacks, variables, memory',
  get searchKeywords() {
    return [
      'debugger', 'DAP', 'launch', 'attach', 'breakpoints', 'conditional', 'hit-count', 'logpoints', 'function breakpoints', 'data breakpoints', 'instruction breakpoints',
      'stepping', 'stack traces', 'scopes', 'variables', 'evaluate', 'disassemble', 'readMemory', 'writeMemory', 'restart', 'python', 'debugpy', 'native', 'lldb',
      ...(gdbProbeFromMemo().viable ? ['gdb'] : []),
      ...(mercuryGodotEnabled() ? ['godot', 'godot editor'] : []),
    ]
  },
  maxResultSizeChars: 100_000,
  async description() {
    return 'Drive a real debugger over DAP: breakpoints, stepping, stacks, scopes, variables, evaluate'
  },
  wireDescription() {
    return DEBUG_WIRE_DESCRIPTION
  },
  async prompt() {
    return getDebugToolDescription()
  },
  userFacingName,
  shouldDefer: true,
  shellCommandOf: (input: unknown) => {
    const call = input as Partial<Input> | null
    return call?.op === 'launch' ? startedCommandText(call.program, call.args) : undefined
  },
  get inputSchema(): SchemaType {
    return inputSchema()
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly(input: Input) {
    return INSPECT_OPS.has(input.op)
  },
  async checkPermissions(input: Input, context: ToolUseContext) {
    const approvalNeeded = (message: string) => ({ behavior: 'passthrough' as const, message, decisionReason: { type: 'other' as const, reason: message } })
    if (input.op === 'launch') {
      const own = approvalNeeded(`Debug launch: ${input.program ?? '?'}${input.args?.length ? ` ${input.args.join(' ')}` : ''} (adapter ${input.adapter ?? inferAdapter(input.program ?? '')})`)
      const started = startedCommandText(input.program, input.args)
      return started === undefined ? own : startedCommandVerdict([{ command: started }], context, own)
    }
    if (input.op === 'attach') {
      const ownProcess = input.pid === undefined ? null : await runtimeProcessRefusal([['kill', String(input.pid)]])
      const named = path.basename(input.program ?? '')
      const ownImage = ownProcess !== null || named === '' ? null : await runtimeProcessRefusal([['killall', named]])
      if (ownProcess !== null || ownImage !== null) {
        const message = `Debug attach to ${ownProcess !== null ? `pid ${input.pid}` : input.program} is refused: it is Mercury’s own process or daemon.`
        return { behavior: 'deny' as const, message, decisionReason: { type: 'other' as const, reason: message } }
      }
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
      return approvalNeeded(`Debug attach: ${target} (adapter ${adapter})`)
    }
    const own = input.op === 'customRequest' ? approvalNeeded(`Debug custom request: ${input.method ?? '?'}${input.body ? ` ${input.body.slice(0, 120)}` : ''}`) : null
    let held: PermissionResult | null = null
    for (const text of textsTheDebuggeeRuns(input.op === 'customRequest' ? customRequestArguments(input.body) : input)) {
      const floor = await evalCodePermission(text, getCwd())
      if (floor !== null) return floor
      const command = debuggerShellCommand(text)
      if (command === undefined) {
        const console = /^\s*`?\s*!\s*(?=\S)([\s\S]+)$/.exec(text)?.[1]
        const refused = console === undefined ? null : await startedCommandVerdict([{ command: console }], context, approvalNeeded(text), false)
        if (refused?.behavior === 'deny') return refused
        continue
      }
      const verdict = await startedCommandVerdict([{ command }], context, approvalNeeded(`Debug ${input.op} runs a shell command: ${command.slice(0, 120)}`))
      if (verdict.behavior === 'deny') return verdict
      held ??= verdict
    }
    return held ?? own ?? { behavior: 'allow' as const, updatedInput: input }
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
    if (input.op === 'breakpoints' && (!input.file || (input.lines === undefined && input.breakpoints === undefined))) {
      return { result: false as const, message: 'breakpoints requires file + lines (or the rich breakpoints array); an empty array clears the file\'s breakpoints', errorCode: 1 }
    }
    if (input.op === 'functionBreakpoints' && !input.functions) {
      return { result: false as const, message: 'functionBreakpoints requires functions (empty array clears)', errorCode: 1 }
    }
    if ((input.op === 'disassemble' || input.op === 'readMemory') && !input.memoryReference) {
      return { result: false as const, message: `${input.op} requires memoryReference (a stack frame's [ip …])`, errorCode: 1 }
    }
    if (input.op === 'dataBreakpoints' && !input.dataBreakpoints) {
      return { result: false as const, message: 'dataBreakpoints requires dataBreakpoints (empty array clears)', errorCode: 1 }
    }
    if (input.op === 'instructionBreakpoints' && !input.instructionBreakpoints) {
      return { result: false as const, message: 'instructionBreakpoints requires instructionBreakpoints (empty array clears)', errorCode: 1 }
    }
    if (input.op === 'writeMemory' && (!input.memoryReference || input.data === undefined)) {
      return { result: false as const, message: 'writeMemory requires memoryReference + data (base64)', errorCode: 1 }
    }
    if (input.op === 'evaluate' && !input.expression) {
      return { result: false as const, message: 'evaluate requires expression', errorCode: 1 }
    }
    if (input.op === 'variables' && input.variablesReference === undefined) {
      return { result: false as const, message: 'variables requires variablesReference', errorCode: 1 }
    }
    return { result: true as const }
  },
  async call(input: Input, context: ToolUseContext, canUseTool?: CanUseToolFn, assistantMessage?: AssistantMessage) {
    const owner = ownerFromToolUseContext(context)
    const startedAt = Date.now()
    let op: OpResult
    const signal = context.abortController?.signal
    const terminalRunner = createDapTerminalRunner(context, canUseTool, assistantMessage)
    try {
      if (input.op === 'launch') {
        const adapter = input.adapter ?? inferAdapter(input.program ?? '')
        if (!resolveAdapter(adapter)) await provisionDebugAdapter(adapter, DebugTool, input, context, canUseTool, assistantMessage)
      }
      const session = getDapSession(owner, input.session ?? 'main')
      session?.setTerminalRunner(terminalRunner)
      const run = () => runOp(input, owner, signal, terminalRunner)
      op = session ? await session.withOperation(signal, run) : await run()
      throwIfDapAborted(signal)
    } catch (err) {
      op = signal?.aborted || err instanceof DapCancelledError
        ? { result: `${input.op} cancelled; a started debuggee may still be running — op:"status" to inspect, op:"disconnect" to end it`, outcome: 'failed', details: { cancelled: true } }
        : { result: `${input.op} failed: ${(err as Error).message}`, outcome: 'failed' }
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
  extractSearchText({ result }) {
    return result ?? ''
  },
})
