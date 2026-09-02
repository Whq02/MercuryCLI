// ============================================================================
//  journeys/runner — the journey executor. Composes the
//  EXISTING owners: project services (start/wait/logs/stop), bounded child
//  processes, loopback fetch, the structural parse facility. The journey
//  itself is a FULL execution-plane owner (kind 'journey', census-
//  classified): registered at start, settled at the end, reconcilable
//  from the in-process live map, stoppable through the plane.
//
//  Honesty is mechanical: the verdict is the conjunction of step states;
//  a failed step marks the rest skipped; cancellation settles 'cancelled';
//  cleanup outcomes are part of the record.
// ============================================================================

import { execFile } from 'node:child_process'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { registerOwnerScopedStore } from '../run/ownerLifecycle.js'
import type { OwnerKey } from '../run/ownerKey.js'
import { OwnerScopedStore } from '../run/ownerScopedStore.js'
import { recordCanonicalEvidence } from '../primitives/evidencePlane.js'
import {
  registerExecution,
  registerExecutionDomain,
  requestStopExecution,
  settleExecution,
  transitionExecution,
} from '../primitives/executionPlane.js'
import {
  readLogs,
  startService,
  stopService,
  waitForReady,
} from '../projectServices/serviceManager.js'
import type { ServiceSpec } from '../projectServices/contracts.js'
import type {
  JourneyRecord,
  JourneySpec,
  JourneyStep,
  JourneyStepResult,
} from './contracts.js'

const RING = 16
const MAX_DETAIL = 400
const DEFAULT_STEP_TIMEOUT: Record<JourneyStep['kind'], number> = {
  'service.start': 20_000,
  'service.wait': 20_000,
  'http.request': 10_000,
  'command.run': 30_000,
  'file.inspect': 5_000,
  'log.match': 10_000,
  'diagnostic.check': 15_000,
  'value.assert': 2_000,
  'service.stop': 15_000,
}

interface OwnerJourneys {
  records: Map<string, JourneyRecord>
  order: string[]
  evicted: Set<string>
}

const store = new OwnerScopedStore<OwnerJourneys>({
  name: 'journeys',
  create: () => ({ records: new Map(), order: [], evicted: new Set() }),
  cap: 32,
})
registerOwnerScopedStore(store)

export function getJourney(owner: OwnerKey, id: string): JourneyRecord | undefined {
  return store.peek(owner)?.records.get(id)
}

export function listJourneys(owner: OwnerKey): JourneyRecord[] {
  const owned = store.peek(owner)
  if (!owned) return []
  return owned.order.map(id => owned.records.get(id)!).filter(Boolean)
}

export function journeyExpired(owner: OwnerKey, id: string): boolean {
  return store.peek(owner)?.evicted.has(id) ?? false
}

function remember(owner: OwnerKey, record: JourneyRecord): void {
  const owned = store.get(owner)
  if (!owned.records.has(record.id)) owned.order.push(record.id)
  owned.records.set(record.id, record)
  while (owned.order.length > RING) {
    const dropped = owned.order.shift()!
    owned.records.delete(dropped)
    owned.evicted.add(dropped)
  }
}

// ── execution-plane domain (kind 'journey' — full owner) ────────────────────

// live journeys, for reconcile + plane-driven stop
const liveAborts = new Map<string, AbortController>()

let domainInstalled = false
export function installJourneyExecutionDomain(): void {
  if (domainInstalled) return
  domainInstalled = true
  registerExecutionDomain('journey', {
    reconcile: record =>
      liveAborts.has(record.spec.id)
        ? { state: 'running' }
        : { state: 'stopped', reason: 'no live runner in this process' },
    requestStop: record => {
      liveAborts.get(record.spec.id)?.abort()
    },
  })
}
installJourneyExecutionDomain()

// ── loopback law ─────────────────────────────────────────────────────────────

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export function isLoopbackUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return LOOPBACK_HOSTS.has(u.hostname)
  } catch {
    return false
  }
}

// ── step executors ───────────────────────────────────────────────────────────

interface StepContext {
  owner: OwnerKey
  root: string
  sessionId: string
  signal: AbortSignal
  startedServices: string[]
  lastHttpJson: unknown
  logCursors: Map<string, number>
}

function bounded(s: string): string {
  return s.length > MAX_DETAIL ? `${s.slice(0, MAX_DETAIL)}…` : s
}

function jsonPath(value: unknown, dotted: string): unknown {
  let cur = value
  for (const part of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

async function runStep(
  step: JourneyStep,
  ctx: StepContext,
): Promise<{ ok: boolean; detail: string }> {
  switch (step.kind) {
    case 'service.start': {
      const spec: ServiceSpec = {
        name: step.name,
        command: step.command,
        args: step.args ?? [],
        cwd: ctx.root,
        readiness: step.readiness ?? [],
        readinessMode: step.readinessMode ?? 'all',
        restart: 'never',
        lifecycle: 'session',
      }
      const out = await startService({ spec, sessionId: ctx.sessionId })
      if ('error' in out) return { ok: false, detail: out.error }
      ctx.startedServices.push(step.name)
      return { ok: true, detail: `service '${step.name}' spawned (pid ${out.record.pid}) — mercury://service/${step.name}` }
    }
    case 'service.wait': {
      const out = await waitForReady(ctx.root, step.name, step.timeoutMs ?? DEFAULT_STEP_TIMEOUT['service.wait'])
      if (!out.ready) {
        const unmet = out.statuses.filter(s => !s.met).map(s => s.detail)
        return {
          ok: false,
          detail: `'${step.name}' not ready — unmet: ${unmet.join('; ') || 'no record'}`,
        }
      }
      return { ok: true, detail: `'${step.name}' ready (${out.statuses.length} condition(s) met)` }
    }
    case 'http.request': {
      if (!isLoopbackUrl(step.url)) {
        return { ok: false, detail: `'${step.url}' is not loopback — journeys drive LOCAL fixtures only` }
      }
      let res: Response
      try {
        res = await fetch(step.url, {
          method: step.method ?? 'GET',
          ...(step.body !== undefined && { body: step.body }),
          ...(step.headers !== undefined && { headers: step.headers }),
          signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(step.timeoutMs ?? DEFAULT_STEP_TIMEOUT['http.request'])]),
        })
      } catch (err) {
        return { ok: false, detail: `request failed: ${(err as Error).message}` }
      }
      const text = await res.text()
      try {
        ctx.lastHttpJson = JSON.parse(text)
      } catch {
        ctx.lastHttpJson = undefined
      }
      const e = step.expect
      if (e?.status !== undefined && res.status !== e.status) {
        return { ok: false, detail: `status ${res.status} ≠ expected ${e.status} (body: ${bounded(text.slice(0, 120))})` }
      }
      if (e?.bodyIncludes !== undefined && !text.includes(e.bodyIncludes)) {
        return { ok: false, detail: `body does not include '${e.bodyIncludes}' (got: ${bounded(text.slice(0, 160))})` }
      }
      for (const [name, want] of Object.entries(e?.headerIncludes ?? {})) {
        const got = res.headers.get(name)
        if (got === null || !got.includes(want)) {
          return { ok: false, detail: `header '${name}' is '${got ?? '(absent)'}' — expected to include '${want}'` }
        }
      }
      if (e?.jsonPath !== undefined) {
        const got = jsonPath(ctx.lastHttpJson, e.jsonPath)
        if (String(got) !== (e.equals ?? '')) {
          return { ok: false, detail: `json ${e.jsonPath} = '${String(got)}' ≠ '${e.equals ?? ''}'` }
        }
      }
      return { ok: true, detail: `${step.method ?? 'GET'} ${step.url} → ${res.status} (${text.length}B)` }
    }
    case 'command.run': {
      return await new Promise(resolvePromise => {
        execFile(
          step.command,
          step.args ?? [],
          {
            windowsHide: true,
            cwd: step.cwd ?? ctx.root,
            timeout: step.timeoutMs ?? DEFAULT_STEP_TIMEOUT['command.run'],
            maxBuffer: 4 * 1024 * 1024,
            env: { ...subprocessEnv() },
            signal: ctx.signal,
          },
          (err, stdout, stderr) => {
            if (err && (err as { killed?: boolean }).killed) {
              resolvePromise({
                ok: false,
                detail: `command timed out after ${step.timeoutMs ?? DEFAULT_STEP_TIMEOUT['command.run']}ms (killed)`,
              })
              return
            }
            const exitCode = err ? ((err as { code?: number }).code ?? 1) : 0
            const wanted = step.expect?.exitCode ?? 0
            if (typeof exitCode !== 'number' || exitCode !== wanted) {
              resolvePromise({
                ok: false,
                detail: `exit ${String(exitCode)} ≠ expected ${wanted} — ${bounded(stderr || stdout)}`,
              })
              return
            }
            if (step.expect?.stdoutIncludes !== undefined && !stdout.includes(step.expect.stdoutIncludes)) {
              resolvePromise({
                ok: false,
                detail: `stdout does not include '${step.expect.stdoutIncludes}' (got: ${bounded(stdout.slice(0, 160))})`,
              })
              return
            }
            resolvePromise({ ok: true, detail: `exit ${String(exitCode)} — ${bounded(stdout.split('\n')[0] ?? '')}` })
          },
        )
      })
    }
    case 'file.inspect': {
      const full = path.isAbsolute(step.path) ? step.path : path.join(ctx.root, step.path)
      const exists = existsSync(full)
      const wantExists = step.expect?.exists ?? true
      if (exists !== wantExists) {
        return { ok: false, detail: `'${step.path}' ${exists ? 'exists' : 'does not exist'} — expected ${wantExists ? 'present' : 'absent'}` }
      }
      if (step.expect?.contains !== undefined) {
        if (!exists) return { ok: false, detail: `'${step.path}' absent — cannot check content` }
        const text = readFileSync(full, 'utf8')
        if (!text.includes(step.expect.contains)) {
          return { ok: false, detail: `'${step.path}' does not contain '${step.expect.contains}'` }
        }
      }
      return { ok: true, detail: `'${step.path}' ${exists ? 'present' : 'absent'} as expected` }
    }
    case 'log.match': {
      const deadline = Date.now() + (step.timeoutMs ?? DEFAULT_STEP_TIMEOUT['log.match'])
      const re = new RegExp(step.pattern)
      for (;;) {
        const out = await readLogs(ctx.root, step.service, {
          cursor: ctx.logCursors.get(step.service) ?? 0,
          limitLines: 500,
        })
        if ('error' in out) return { ok: false, detail: out.error }
        const hit = out.lines.find(l => re.test(l))
        if (hit) {
          ctx.logCursors.set(step.service, out.nextCursor)
          return { ok: true, detail: `log matched /${step.pattern}/: ${bounded(hit)}` }
        }
        if (Date.now() > deadline) {
          return { ok: false, detail: `no log line matched /${step.pattern}/ within the timeout (${out.lines.length} line(s) scanned)` }
        }
        if (ctx.signal.aborted) return { ok: false, detail: 'cancelled while waiting on logs' }
        await new Promise(r => setTimeout(r, 150))
      }
    }
    case 'diagnostic.check': {
      const { resolveStructureTypescript, loadTs, parseSource } = await import('../structure/tsFacility.js')
      const resolution = resolveStructureTypescript(ctx.root)
      if (resolution.state === 'unavailable') return { ok: false, detail: resolution.note }
      const ts = loadTs(resolution.modulePath)
      const problems: string[] = []
      for (const rel of step.files.slice(0, 20)) {
        const full = path.isAbsolute(rel) ? rel : path.join(ctx.root, rel)
        if (!existsSync(full)) {
          problems.push(`${rel}: absent`)
          continue
        }
        const { parseErrors } = parseSource(ts, full, readFileSync(full, 'utf8'))
        if (parseErrors.length > 0) problems.push(`${rel}: ${parseErrors[0]}`)
      }
      if (problems.length > 0) {
        return { ok: false, detail: `parse diagnostics: ${problems.join(' · ')}` }
      }
      return { ok: true, detail: `parse diagnostics clean on ${step.files.length} file(s) (semantic diagnostics ride the LSP owner)` }
    }
    case 'value.assert': {
      if (ctx.lastHttpJson === undefined) {
        return { ok: false, detail: 'no JSON body from a prior http.request to assert into' }
      }
      const got = jsonPath(ctx.lastHttpJson, step.jsonPath)
      if (String(got) !== step.equals) {
        return { ok: false, detail: `json ${step.jsonPath} = '${String(got)}' ≠ '${step.equals}'` }
      }
      return { ok: true, detail: `json ${step.jsonPath} = '${step.equals}'` }
    }
    case 'service.stop': {
      const out = await stopService(ctx.root, step.name)
      if ('error' in out) return { ok: false, detail: out.error }
      const idx = ctx.startedServices.indexOf(step.name)
      if (idx !== -1) ctx.startedServices.splice(idx, 1)
      return { ok: true, detail: `service '${step.name}' stopped (explicit)` }
    }
  }
}

// ── the journey ──────────────────────────────────────────────────────────────

export interface RunJourneyOptions {
  owner: OwnerKey
  root: string
  sessionId?: string
  signal?: AbortSignal
}

export async function runJourney(spec: JourneySpec, opts: RunJourneyOptions): Promise<JourneyRecord> {
  const id = `jy-${createHash('sha1')
    .update(JSON.stringify(spec))
    .update(randomBytes(4))
    .digest('hex')
    .slice(0, 12)}`
  const abort = new AbortController()
  if (opts.signal) {
    if (opts.signal.aborted) abort.abort()
    else opts.signal.addEventListener('abort', () => abort.abort(), { once: true })
  }
  liveAborts.set(id, abort)

  registerExecution({
    owner: opts.owner,
    id,
    kind: 'journey',
    label: `journey: ${spec.objective.slice(0, 60)}`,
    lifecycle: 'owner',
    cwd: opts.root,
    initialState: 'running',
  })

  const record: JourneyRecord = {
    id,
    objective: spec.objective,
    state: 'running',
    createdAt: Date.now(),
    root: opts.root,
    steps: [],
    cleanup: [],
    executionRef: `mercury://execution/${id}`,
    evidenceRefs: [],
  }
  remember(opts.owner, record)

  const ctx: StepContext = {
    owner: opts.owner,
    root: opts.root,
    sessionId: opts.sessionId ?? `journey-${id}`,
    signal: abort.signal,
    startedServices: [],
    lastHttpJson: undefined,
    logCursors: new Map(),
  }

  let failedStep: number | undefined
  let cancelled = false

  for (const [index, step] of spec.steps.entries()) {
    const label = step.label ?? `${step.kind}[${index}]`
    if (abort.signal.aborted) {
      cancelled = true
      record.steps.push({ index, kind: step.kind, label, state: 'cancelled', detail: 'cancelled before this step', elapsedMs: 0 })
      continue
    }
    if (failedStep !== undefined) {
      record.steps.push({ index, kind: step.kind, label, state: 'skipped', detail: `skipped — step ${failedStep} failed`, elapsedMs: 0 })
      continue
    }
    const startedAt = Date.now()
    let out: { ok: boolean; detail: string }
    try {
      const timeoutMs = step.timeoutMs ?? DEFAULT_STEP_TIMEOUT[step.kind]
      // The outer race is a SAFETY NET above the step's own deadline, never
      // a competitor: wait/log/command executors own timeoutMs themselves
      // and answer with the SPECIFIC unmet condition — racing at the same
      // deadline stole that answer ("step timed out" where the honest detail
      // was "unmet: log /READY/"). +2s grace keeps the net for wedged steps.
      const watchdogMs = timeoutMs + 2_000
      out = await Promise.race([
        runStep(step, ctx),
        new Promise<{ ok: boolean; detail: string }>(resolvePromise => {
          const t = setTimeout(
            () => resolvePromise({ ok: false, detail: `step wedged past ${watchdogMs}ms (its own ${timeoutMs}ms deadline never answered)` }),
            watchdogMs,
          )
          ;(t as { unref?: () => void }).unref?.()
        }),
      ])
    } catch (err) {
      out = { ok: false, detail: `step threw: ${(err as Error).message.slice(0, 200)}` }
    }
    if (abort.signal.aborted && !out.ok) {
      cancelled = true
      record.steps.push({ index, kind: step.kind, label, state: 'cancelled', detail: out.detail, elapsedMs: Date.now() - startedAt })
      continue
    }
    let evidenceRef: string | undefined
    try {
      const ev = recordCanonicalEvidence({
        owner: opts.owner,
        kind: 'check',
        origin: 'observed',
        claim: `journey ${id} step ${index} (${step.kind}) ${out.ok ? 'passed' : 'FAILED'}: ${out.detail.slice(0, 140)}`,
        refs: [`mercury://journey/${id}`],
      })
      evidenceRef = `mercury://evidence/${ev.id}`
      record.evidenceRefs.push(evidenceRef)
    } catch {
      /* evidence never blocks the observation */
    }
    record.steps.push({
      index,
      kind: step.kind,
      label,
      state: out.ok ? 'passed' : 'failed',
      detail: bounded(out.detail),
      ...(evidenceRef !== undefined && { evidenceRef }),
      elapsedMs: Date.now() - startedAt,
    })
    if (!out.ok) failedStep = index
  }

  // cleanup: stop every service this journey started (unless keep).
  for (const name of [...ctx.startedServices]) {
    if (spec.cleanup === 'keep') {
      record.cleanup.push({ service: name, action: 'kept' })
      continue
    }
    try {
      const out = await stopService(opts.root, name)
      record.cleanup.push(
        'error' in out
          ? { service: name, action: 'stop-failed', detail: out.error }
          : { service: name, action: 'stopped' },
      )
    } catch (err) {
      record.cleanup.push({ service: name, action: 'stop-failed', detail: (err as Error).message })
    }
  }

  record.state = cancelled ? 'cancelled' : failedStep !== undefined ? 'failed' : 'succeeded'
  record.settledAt = Date.now()
  if (failedStep !== undefined) record.failedStep = failedStep
  liveAborts.delete(id)

  try {
    const ev = recordCanonicalEvidence({
      owner: opts.owner,
      kind: 'check',
      origin: 'observed',
      claim: `journey ${id} '${spec.objective.slice(0, 60)}' settled ${record.state} — ${record.steps.filter(s => s.state === 'passed').length}/${record.steps.length} step(s) passed, cleanup: ${record.cleanup.map(c => `${c.service}:${c.action}`).join(', ') || 'none'}`,
      refs: [`mercury://journey/${id}`, record.executionRef],
    })
    record.evidenceRefs.push(`mercury://evidence/${ev.id}`)
  } catch {
    /* evidence never blocks settlement */
  }

  if (cancelled) {
    // the plane may already be 'stopping' (stop came through requestStop)
    try {
      settleExecution(opts.owner, id, 'cancelled', { outcome: { reason: 'journey cancelled' } })
    } catch {
      transitionExecution(opts.owner, id, 'cancelled', { outcome: { reason: 'journey cancelled' } })
    }
  } else {
    settleExecution(opts.owner, id, failedStep !== undefined ? 'failed' : 'succeeded', {
      outcome: {
        reason:
          failedStep !== undefined
            ? `step ${failedStep} failed: ${record.steps[failedStep]?.detail.slice(0, 120)}`
            : `${record.steps.length} step(s) passed`,
      },
      evidenceRefs: record.evidenceRefs.slice(-1),
    })
  }

  remember(opts.owner, record)
  return record
}

/** Cancel a running journey through the SAME plane stop path. */
export function cancelJourney(owner: OwnerKey, id: string): boolean {
  if (!liveAborts.has(id)) return false
  requestStopExecution(owner, id)
  return true
}

/** TEST-ONLY: reset (proof harnesses). */
export function _resetJourneysForTesting(): void {
  store.clearAllForShutdown()
  liveAborts.clear()
}
