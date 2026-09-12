import { readFileSync } from 'node:fs'
import { runEngineCheck, type EngineCheckArgs } from './compileGate.js'
import { parseEngineTreeSpec } from './frozenTree.js'
import { engineLogTail } from './logs.js'
import { readEngineManifest } from './manifest.js'
import {
  ENGINE_DEFAULT_PRIORITY,
  ENGINE_PRIORITIES,
  EngineJobService,
  listEngineRunIds,
  type EngineJobRequest,
  type EnginePriority,
  type EngineRunRecord,
} from './service.js'

export const ENGINE_OPS: ReadonlySet<string> = new Set(['engine_run', 'engine_check', 'engine_jobs', 'engine_cancel', 'engine_result'])
export const ENGINE_EXEC_OPS: ReadonlySet<string> = new Set(['engine_run', 'engine_check'])
export const ENGINE_DEFAULT_TAIL_CHARS = 2000
export const ENGINE_RESULT_TAIL_CHARS = 4000
export const ENGINE_WAIT_GRACE_MS = 60_000

type Args = Record<string, unknown>

function boolArg(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(s)) return true
    if (['0', 'false', 'no', 'off'].includes(s)) return false
  }
  return fallback
}

function intArg(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

function listArg(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((s): s is string => typeof s === 'string').map(s => s.trim()).filter(s => s.length > 0)
  if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(s => s.length > 0)
  return []
}

function priorityArg(v: unknown): EnginePriority | { error: string } {
  if (v === undefined || v === null || v === '') return ENGINE_DEFAULT_PRIORITY
  if (typeof v === 'string' && (ENGINE_PRIORITIES as readonly string[]).includes(v.trim())) return v.trim() as EnginePriority
  return { error: `priority "${String(v)}" is not one of ${ENGINE_PRIORITIES.join(' > ')} (default ${ENGINE_DEFAULT_PRIORITY})` }
}

function json(v: unknown): string {
  return JSON.stringify(v, null, 2)
}

export function engineOpPermissionMessage(op: string, args: Args | undefined): string | null {
  const a = args ?? {}
  switch (op) {
    case 'engine_run': {
      const suites = listArg(a.suites)
      const native = boolArg(a.native, false)
      return `Godot exec: engine_run${suites.length > 0 ? ` (${suites.join(', ')})` : ' (every manifest suite)'} — runs ${native ? 'a display Godot job' : 'headless Godot workers'} on a frozen copy of the project under .mercury/engine/ (the editor is not touched${native ? '; a window opens on the display' : ''})`
    }
    case 'engine_check':
      return 'Godot exec: engine_check — parses the changed scripts and shaders with headless Godot, one file at a time (seconds; the editor is not touched)'
    case 'engine_cancel':
      return `Godot mutate: engine_cancel${typeof a.id === 'string' ? ` (${a.id})` : ''} — ends that engine job's process tree; the editor is not touched`
    default:
      return null
  }
}

function withTails(record: EngineRunRecord, chars: number): EngineRunRecord & { logTails: Record<string, string> } {
  const logTails: Record<string, string> = {}
  if (chars > 0) {
    for (const row of record.results) {
      if ('skipped' in row || row.ok) continue
      try {
        logTails[row.name] = engineLogTail(readFileSync(row.log, 'utf8'), chars)
      } catch {
        continue
      }
    }
  }
  return { ...record, logTails }
}

async function engineRun(a: Args, projectRoot: string): Promise<string> {
  const spec = parseEngineTreeSpec(a.tree)
  if ('error' in spec) return `engine_run refused: ${spec.error}`
  const priority = priorityArg(a.priority)
  if (typeof priority !== 'string') return `engine_run refused: ${priority.error}`
  const request: EngineJobRequest = {
    suites: listArg(a.suites),
    tree: spec,
    native: boolArg(a.native, false),
    capture: boolArg(a.capture, false),
    priority,
    budgetMs: intArg(a.budgetMs),
    displayShared: boolArg(a.displayShared, false),
    keepTree: boolArg(a.keepTree, false),
    label: typeof a.label === 'string' && a.label.trim().length > 0 ? a.label.trim().slice(0, 80) : null,
  }
  const service = EngineJobService.for(projectRoot)
  const job = await service.submit(request)
  if ('refused' in job) return `engine_run refused: ${job.refused}`
  if (job.state === 'failed') return `engine_run failed before it ran: ${job.error ?? 'unknown'}\n${json({ id: job.id, tree: job.request.tree.label })}`
  if (!boolArg(a.wait, true)) {
    return json({
      id: job.id,
      state: job.state,
      queuedAt: job.queuedAt,
      tree: job.request.tree.label,
      priority: job.request.priority,
      hint: 'op:"engine_result" {id} reads the run when it is done; op:"engine_jobs" shows the queue and the workers; op:"engine_cancel" {id} ends it',
    })
  }
  const manifest = readEngineManifest(projectRoot)
  const selected = manifest.suites.filter(s => request.suites.length === 0 || request.suites.includes(s.name))
  const own = request.budgetMs ?? selected.reduce((sum, s) => sum + s.timeoutMs, 0) + manifest.defaults.importTimeoutMs
  const queuedAhead = service.jobs().queued.length + service.jobs().running.length
  const waitMs = intArg(a.waitMs) ?? own * Math.max(1, queuedAhead) + ENGINE_WAIT_GRACE_MS
  const settled = await service.wait(job.id, waitMs)
  if (settled && settled.record && settled.state !== 'queued' && settled.state !== 'running') {
    return json(withTails(settled.record, intArg(a.tailChars) ?? ENGINE_DEFAULT_TAIL_CHARS))
  }
  return json({
    id: job.id,
    state: settled?.state ?? job.state,
    note: `still ${settled?.state ?? job.state} after ${waitMs} ms — op:"engine_result" {id} reads it when done; op:"engine_cancel" {id} ends it`,
  })
}

async function engineCheck(a: Args, projectRoot: string): Promise<string> {
  const service = EngineJobService.for(projectRoot)
  const exe = await service.executable()
  if ('error' in exe) return `engine_check refused: no Godot executable — ${exe.error}`
  const files = listArg(a.files)
  const checkArgs: EngineCheckArgs = {
    files: files.length > 0 ? files : undefined,
    all: boolArg(a.all, false),
    tree: a.tree,
    shaders: a.shaders === undefined ? undefined : boolArg(a.shaders, true),
    parallel: intArg(a.parallel) ?? undefined,
  }
  return json(await runEngineCheck(projectRoot, checkArgs, { executable: exe.resolved }))
}

export async function runEngineOp(op: string, args: Args | undefined, projectRoot: string): Promise<string> {
  const a = args ?? {}
  switch (op) {
    case 'engine_run':
      return engineRun(a, projectRoot)
    case 'engine_check':
      return engineCheck(a, projectRoot)
    case 'engine_jobs': {
      const service = EngineJobService.for(projectRoot)
      return json({ ...service.jobs(), runsOnDisk: listEngineRunIds(projectRoot).slice(0, 20) })
    }
    case 'engine_cancel': {
      const id = typeof a.id === 'string' ? a.id.trim() : ''
      if (id.length === 0) return 'engine_cancel needs {id} — op:"engine_jobs" lists the queued and running jobs'
      return json(await EngineJobService.for(projectRoot).cancel(id))
    }
    case 'engine_result': {
      const id = typeof a.id === 'string' ? a.id.trim() : ''
      if (id.length === 0) {
        const ids = listEngineRunIds(projectRoot).slice(0, 10)
        return `engine_result needs {id} — runs on disk: ${ids.length > 0 ? ids.join(', ') : 'none yet (op:"engine_run" makes one)'}`
      }
      const record = EngineJobService.for(projectRoot).result(id)
      if (!record) {
        const ids = listEngineRunIds(projectRoot).slice(0, 10)
        return `no run ${id} under .mercury/engine/runs — recent: ${ids.length > 0 ? ids.join(', ') : 'none'}`
      }
      return json(withTails(record, intArg(a.tail) ?? ENGINE_RESULT_TAIL_CHARS))
    }
    default:
      return `unknown engine op ${op}`
  }
}
