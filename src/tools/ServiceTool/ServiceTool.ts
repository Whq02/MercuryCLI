// ============================================================================
//  Service tool — named observable project processes.
//  start · list · describe · wait · logs · input · stop · restart over the
//  projectServices manager: durable project-scoped records, per-condition
//  readiness truth, ordered log cursors, restart with bounded backoff,
//  explicit-stop suppression, and reconciliation that never claims a live
//  process from a record. Use Bash for finite commands; Service for
//  processes meant to stay up (web servers, watch builds, local APIs).
// ============================================================================

import { z } from 'zod/v4'
import { buildTool, type ToolUseContext } from '../../Tool.js'
import {
  describeCondition,
  servicesEnabled,
  type ReadinessCondition,
  type ServiceRecord,
} from '../../services/projectServices/contracts.js'
import {
  evaluateReadiness,
  readLogs,
  reconcileAll,
  reconcileRecord,
  restartService,
  sendInput,
  startService,
  stopService,
  waitForReady,
} from '../../services/projectServices/serviceManager.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
} from './UI.js'

export const SERVICE_TOOL_NAME = 'Service' as const

const OPS = ['start', 'list', 'describe', 'wait', 'logs', 'input', 'stop', 'restart'] as const

const readinessSchema = () =>
  z.union([
    z.strictObject({ kind: z.literal('log'), regex: z.string() }),
    z.strictObject({ kind: z.literal('tcp'), host: z.string().optional(), port: z.number().int().min(1).max(65535) }),
    z.strictObject({
      kind: z.literal('http'),
      url: z.string(),
      method: z.string().optional(),
      status: z.number().int().optional(),
      bodyRegex: z.string().optional(),
    }),
    z.strictObject({ kind: z.literal('file'), path: z.string(), contentRegex: z.string().optional() }),
    z.strictObject({ kind: z.literal('stable'), ms: z.number().int().min(100).max(60_000) }),
  ])

const inputSchema = lazySchema(() =>
  z.strictObject({
    op: z.enum(OPS).describe('The service operation'),
    name: z.string().optional().describe('Project-scoped service name (all ops except list)'),
    command: z.string().optional().describe('start: the executable (argv[0] — no shell parsing)'),
    args: z.array(z.string()).optional().describe('start: argument array'),
    cwd: z.string().optional().describe('start: working directory (default: session cwd)'),
    env: z.record(z.string(), z.string()).optional().describe('start: environment additions'),
    readiness: z.array(readinessSchema()).max(8).optional().describe('start: readiness conditions (log regex · tcp · http · file · stable window)'),
    readinessMode: z.enum(['all', 'any']).optional().describe('start: how conditions combine (default all)'),
    restart: z.enum(['never', 'on-failure']).optional().describe('start: auto-restart policy (default never; bounded backoff, explicit stop always suppresses)'),
    lifecycle: z.enum(['session', 'project']).optional().describe('start: session = dies with this Mercury session (default); project = detached, survives it'),
    timeoutMs: semanticNumber(z.number().int().min(100).max(300_000).optional()).describe('wait: readiness deadline (default 30000)'),
    cursor: semanticNumber(z.number().int().min(0).optional()).describe('logs: byte cursor from a previous read (omit for the tail)'),
    limitLines: semanticNumber(z.number().int().min(1).max(1000).optional()).describe('logs: max lines (default 100)'),
    filterRegex: z.string().optional().describe('logs: keep only matching lines'),
    text: z.string().optional().describe('input: the line to write to the service stdin'),
  }),
)
type SchemaType = ReturnType<typeof inputSchema>
export type Input = z.infer<SchemaType>
export type Output = {
  op: Input['op']
  result: string
  state?: string
  name?: string
}

function describeRecord(r: ServiceRecord): string {
  const lines = [
    `${r.spec.name} — ${r.state}${r.pid ? ` (pid ${r.pid})` : ''}`,
    `  command: ${r.spec.command} ${r.spec.args.join(' ')}`,
    `  cwd: ${r.spec.cwd}`,
    `  lifecycle: ${r.spec.lifecycle} · restart: ${r.spec.restart} · restarts so far: ${r.restartCount}`,
    ...(r.startedAt ? [`  started: ${new Date(r.startedAt).toISOString()}`] : []),
    ...(r.stoppedAt ? [`  stopped: ${new Date(r.stoppedAt).toISOString()}${r.lastExitCode !== null ? ` (exit ${r.lastExitCode})` : ''}`] : []),
    `  log: ${r.logFile}`,
    `  ref: mercury://service/${r.spec.name}`,
  ]
  if (r.spec.readiness.length > 0) {
    lines.push(`  readiness (${r.spec.readinessMode}):`)
    for (const c of r.spec.readiness) lines.push(`    · ${describeCondition(c)}`)
  }
  return lines.join('\n')
}

async function runOp(input: Input, sessionId: string): Promise<Output> {
  const cwd = getCwd()
  const need = (field: string): never => {
    throw new Error(`${input.op} needs ${field}`)
  }
  switch (input.op) {
    case 'start': {
      if (!input.name) need('name')
      if (!input.command) need('command')
      const result = await startService({
        sessionId,
        spec: {
          name: input.name!,
          command: input.command!,
          args: input.args ?? [],
          cwd: input.cwd ?? cwd,
          ...(input.env ? { env: input.env } : {}),
          readiness: (input.readiness ?? []) as ReadinessCondition[],
          readinessMode: input.readinessMode ?? 'all',
          restart: input.restart ?? 'never',
          lifecycle: input.lifecycle ?? 'session',
        },
      })
      if ('error' in result) return { op: 'start', result: result.error, state: 'failed', name: input.name }
      const hint =
        result.record.spec.readiness.length > 0
          ? `\nop:"wait" blocks until readiness; op:"logs" follows output.`
          : `\nop:"logs" follows output; no readiness conditions were declared.`
      return {
        op: 'start',
        result: describeRecord(result.record) + hint,
        state: result.record.state,
        name: input.name,
      }
    }
    case 'list': {
      const records = reconcileAll(input.cwd ?? cwd)
      if (records.length === 0) {
        return { op: 'list', result: 'no services in this project (start one with op:"start")' }
      }
      return {
        op: 'list',
        result: records
          .map(r => `${r.spec.name} — ${r.state}${r.pid ? ` (pid ${r.pid})` : ''}${r.restartCount ? ` · ${r.restartCount} restart(s)` : ''} · mercury://service/${r.spec.name}`)
          .join('\n'),
      }
    }
    case 'describe': {
      if (!input.name) need('name')
      const record = reconcileRecord(input.cwd ?? cwd, input.name!)
      if (!record) return { op: 'describe', result: `no service '${input.name}' in this project`, state: 'absent' }
      const { ready, statuses } = await evaluateReadiness(input.cwd ?? cwd, record)
      const readinessLines =
        statuses.length > 0
          ? '\nreadiness now:' + statuses.map(s => `\n  ${s.met ? '✓' : '·'} ${s.detail}`).join('')
          : ''
      return {
        op: 'describe',
        result: describeRecord(record) + readinessLines + (ready && record.state === 'starting' ? '\n(conditions met — op:"wait" promotes to ready)' : ''),
        state: record.state,
        name: input.name,
      }
    }
    case 'wait': {
      if (!input.name) need('name')
      const outcome = await waitForReady(input.cwd ?? cwd, input.name!, input.timeoutMs ?? 30_000)
      if (!outcome.record) return { op: 'wait', result: `no service '${input.name}' in this project`, state: 'absent' }
      if (outcome.ready) {
        return { op: 'wait', result: `service '${input.name}' is READY\n${describeRecord(outcome.record)}`, state: outcome.record.state, name: input.name }
      }
      const unmet = outcome.statuses.filter(s => !s.met)
      return {
        op: 'wait',
        result:
          `service '${input.name}' did NOT become ready (state ${outcome.record.state}) — unmet condition(s):\n` +
          unmet.map(s => `  · ${s.detail}`).join('\n') +
          (outcome.record.state === 'failed' ? `\nThe process exited (${outcome.record.lastExitCode ?? '?'}) — op:"logs" shows why.` : ''),
        state: outcome.record.state,
        name: input.name,
      }
    }
    case 'logs': {
      if (!input.name) need('name')
      const logs = await readLogs(input.cwd ?? cwd, input.name!, {
        cursor: input.cursor,
        limitLines: input.limitLines,
        filterRegex: input.filterRegex,
        tail: input.cursor === undefined,
      })
      if ('error' in logs) return { op: 'logs', result: logs.error, name: input.name }
      return {
        op: 'logs',
        result:
          (logs.lines.length > 0 ? logs.lines.join('\n') : '(no log lines in this window)') +
          `\n[cursor: ${logs.nextCursor}${logs.eof ? ' — end of log' : ' — more available: pass cursor'} · ${logs.totalBytes} bytes total]`,
        name: input.name,
      }
    }
    case 'input': {
      if (!input.name) need('name')
      if (input.text === undefined) need('text')
      const sent = sendInput(input.cwd ?? cwd, input.name!, input.text!, sessionId)
      return 'error' in sent
        ? { op: 'input', result: sent.error, name: input.name }
        : { op: 'input', result: `wrote ${input.text!.length} chars to '${input.name}' stdin`, name: input.name }
    }
    case 'stop': {
      if (!input.name) need('name')
      const result = await stopService(input.cwd ?? cwd, input.name!)
      if ('error' in result) return { op: 'stop', result: result.error, name: input.name }
      // A stop that REFUSED to strike says so: an unverifiable or reused pid
      // is never force-killed, and the operator must not read that as a
      // clean stop (FN-015 rank 6).
      const note = result.note ?? result.record.stopNote
      return {
        op: 'stop',
        result: note
          ? `${note}\n(auto-restart suppressed)`
          : `service '${input.name}' stopped (explicit — auto-restart suppressed)${result.record.lastExitCode !== null ? ` · exit ${result.record.lastExitCode}` : ''}`,
        state: result.record.state,
        name: input.name,
      }
    }
    case 'restart': {
      if (!input.name) need('name')
      const result = await restartService(input.cwd ?? cwd, input.name!, sessionId)
      if ('error' in result) return { op: 'restart', result: result.error, name: input.name }
      return {
        op: 'restart',
        result: `service '${input.name}' restarted (restart #${result.record.restartCount})\n${describeRecord(result.record)}`,
        state: result.record.state,
        name: input.name,
      }
    }
  }
}

const MUTATING_OPS = new Set<Input['op']>(['start', 'stop', 'restart', 'input'])

export const ServiceTool = buildTool({
  name: SERVICE_TOOL_NAME,
  searchHint:
    'named project services: start/observe/wait/logs/stop long-lived processes (web servers, watch builds, local APIs)',
  maxResultSizeChars: 100_000,
  strict: true,
  isEnabled() {
    return servicesEnabled()
  },
  async description() {
    return 'Run and observe named long-lived project processes with readiness + cursored logs'
  },
  async prompt() {
    return `Named long-lived project processes as state machines: queued → starting → ready/running → stopping → stopped/failed. Use Service for processes meant to STAY UP (web servers, watch builds, local APIs, file watchers); use Bash for finite commands.

Operations:
· start — name + command + args (argv array, no shell parsing) + optional readiness conditions ({kind:"log",regex} · {kind:"tcp",port} · {kind:"http",url,status?,bodyRegex?} · {kind:"file",path,contentRegex?} · {kind:"stable",ms}), readinessMode all|any, restart never|on-failure (bounded backoff; an explicit stop ALWAYS suppresses restart), lifecycle session (dies with this session, default) | project (detached — survives it, stoppable from any session on this project).
· wait — block until ready or the deadline; a timeout names EXACTLY the unmet conditions.
· logs — ordered byte cursors: first call tails, pass the returned cursor for strictly-newer lines; filterRegex bounds noise. stdout+stderr share one ordered log.
· describe / list — reconciled truth (a dead pid is never reported live).
· input — write a line to the service stdin (only the spawning session holds it).
· stop / restart — explicit lifecycle; restart reuses the retained spec.

Services are addressable as mercury://service/<name> (Inspect). Never auto-started: package.json scripts are suggestions for YOU to start deliberately.`
  },
  userFacingName() {
    return 'Service'
  },
  getToolUseSummary(input?: Partial<Input>) {
    if (!input?.op) return null
    return `${input.op}${input.name ? ` ${input.name}` : ''}`
  },
  isReadOnly(input: Input) {
    return !MUTATING_OPS.has(input.op)
  },
  isConcurrencySafe(input: Input) {
    return !MUTATING_OPS.has(input.op)
  },
  async checkPermissions(input: Input) {
    if (input.op === 'start' || input.op === 'restart') {
      return {
        behavior: 'ask' as const,
        message: `Service ${input.op}: ${input.name ?? '?'}${input.command ? ` — ${input.command} ${(input.args ?? []).join(' ')}` : ''}`,
      }
    }
    if (input.op === 'input') {
      return {
        behavior: 'ask' as const,
        message: `Service input → ${input.name ?? '?'}: ${input.text?.slice(0, 80) ?? ''}`,
      }
    }
    return { behavior: 'allow' as const, updatedInput: input }
  },
  toAutoClassifierInput(input: Input) {
    if (input.op === 'start') return `service start: ${input.command ?? ''} ${(input.args ?? []).join(' ')}`
    if (input.op === 'input') return `service input: ${input.text ?? ''}`
    return ''
  },
  async validateInput(input: Input) {
    if (input.op !== 'list' && !input.name) {
      return { result: false as const, message: `${input.op} requires name`, errorCode: 1 }
    }
    if (input.op === 'start' && !input.command) {
      return { result: false as const, message: 'start requires command', errorCode: 1 }
    }
    if (input.op === 'input' && input.text === undefined) {
      return { result: false as const, message: 'input requires text', errorCode: 1 }
    }
    return { result: true as const }
  },
  get inputSchema(): SchemaType {
    return inputSchema()
  },
  renderToolUseMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  // HZ7 projection: the renderer paints `result` — search indexes the same.
  extractSearchText({ result }) {
    return result
  },
  async call(input: Input, context: ToolUseContext) {
    const startedAt = Date.now()
    const sessionId = (() => {
      try {
        const state = context.getAppState() as { sessionId?: string }
        return String(state.sessionId ?? 'session')
      } catch {
        return 'session'
      }
    })()
    let output: Output
    try {
      output = await runOp(input, sessionId)
    } catch (err) {
      output = { op: input.op, result: `${input.op} failed: ${(err as Error).message}` }
    }
    const failed =
      /^(start|wait|stop|restart|input) (failed|needs)/.test(output.result) ||
      output.state === 'failed' ||
      output.state === 'absent' ||
      /did NOT become ready|already .* — stop or restart|no service '/.test(output.result)
    return {
      data: output,
      effect: {
        outcome: MUTATING_OPS.has(input.op)
          ? failed
            ? ('failed' as const)
            : ('succeeded' as const)
          : failed
            ? ('no-change' as const)
            : ('succeeded' as const),
        operation: `service.${input.op}`,
        changedPaths: [],
        evidence: output.result.split('\n')[0]?.slice(0, 160) ?? '',
        startedAt,
        completedAt: Date.now(),
        ...(output.name ? { details: { name: output.name, state: output.state } } : {}),
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
})
