import { statSync } from 'node:fs'

import { flagEnv } from '../substrate/flagRegistry.js'
import { resolveEffectiveSettingsSnapshot } from '../substrate/startupMenu.js'
import { minutesKnobToMs } from '../utils/deadline.js'
import { logForDebugging } from '../utils/debug.js'
import { validateWorkerModelChoice } from '../services/concourse/workerModels.js'
import { deriveSessionKitForWorkspace, type SessionKitV1 } from './sessionKit.js'
import {
  buildConcourseWorkerSpec,
  canonicalWorkspaceId,
  CONCOURSE_SHORT_PREFIX,
  effectiveSeatCeiling,
  readSessionWorkers,
} from './concourseSupervisor.js'
import type { StreamJsonChildSpec } from './headlessRun.js'
import { isProcessAlive } from './ownerWatch.js'

export const DEFAULT_WARM_RUNNER_IDLE_RETIRE_MINUTES = 5

export function warmRunnerIdleRetireMs(): number {
  return minutesKnobToMs(flagEnv('MERCURY_WARM_RUNNER_IDLE_RETIRE_MINUTES'), DEFAULT_WARM_RUNNER_IDLE_RETIRE_MINUTES)
}

export function warmRunnerPoolEnabled(): boolean {
  return flagEnv('MERCURY_WARM_RUNNER') !== '0'
}

const CLAIM_ANSWER_DEADLINE_MS = 10_000

export const WARM_CLAIM_REQUEST_PREFIX = 'mercury-warm-claim-'

interface WarmRunnerEntry {
  short: string
  workspaceId: string
  pid?: number
  spawnedAt: number
  lastKeptAt: number
  bootModelKey: string
  snapshotId: string
  kit: SessionKitV1
}

const pool = new Map<string, WarmRunnerEntry>()

const claimWaiters = new Map<string, (outcome: { ok: boolean; error?: string }) => void>()

interface TrailingEnsure {
  kit: SessionKitV1 | undefined
  deps: WarmRunnerDeps
  waiters: Array<{ resolve: (outcome: WarmEnsureOutcome) => void; reject: (err: unknown) => void }>
}

interface EnsureFlight {
  kit: SessionKitV1 | undefined
  run: Promise<WarmEnsureOutcome>
  trailing: TrailingEnsure | null
}

const ensureFlights = new Map<string, EnsureFlight>()

export function resetWarmRunnersForTesting(): void {
  pool.clear()
  claimWaiters.clear()
  ensureFlights.clear()
}

export interface WarmRosterPort {
  has(short: string): { alive: boolean; present: boolean; ready: boolean }
  list(): ReadonlyArray<{ short: string; outcome?: unknown }>
  registerLongLived(short: string, spec: StreamJsonChildSpec): { ok: boolean; pid?: number; error?: string }
  control(short: string, frame: string): boolean
  kill(short: string): boolean
  patchSeatClaim(
    short: string,
    patch: { model: string; effort: string; respawnExtraArgv: readonly string[] },
  ): StreamJsonChildSpec | null
}

export interface WarmRunnerDeps {
  roster: () => WarmRosterPort | undefined
  dir?: string
  onWarmSpawned?: (short: string, workspaceId: string, pid: number | undefined) => void
}

export type WarmEnsureOutcome = { state: 'warmed' | 'kept' | 'refused'; detail?: string; short?: string }

function liveSeatCount(dir: string | undefined, roster: WarmRosterPort): number {
  const records = readSessionWorkers(dir)
  const liveShorts = new Set(roster.list().filter(j => !j.outcome).map(j => j.short))
  return Object.values(records).filter(
    r => r.endedAt === undefined && r.parkedAt === undefined && (liveShorts.has(r.runnerId) || r.attachedAt !== undefined),
  ).length
}

function livePoolEntries(roster: WarmRosterPort): WarmRunnerEntry[] {
  const out: WarmRunnerEntry[] = []
  for (const [ws, entry] of [...pool]) {
    const state = roster.has(entry.short)
    const alive = state.present && state.alive && (entry.pid === undefined || isProcessAlive(entry.pid))
    if (!alive) {
      pool.delete(ws)
      continue
    }
    out.push(entry)
  }
  return out
}

function mintWarmShort(dir: string | undefined, roster: WarmRosterPort): string | null {
  const records = readSessionWorkers(dir)
  const used = new Set(Object.values(records).filter(r => r.endedAt === undefined).map(r => r.runnerId))
  for (let n = 1; n <= used.size + 4096; n++) {
    const candidate = `${CONCOURSE_SHORT_PREFIX}${n}`
    if (!used.has(candidate) && !roster.has(candidate).present) return candidate
  }
  return null
}

function currentSnapshotId(): string {
  return resolveEffectiveSettingsSnapshot({ sessionId: 'warm-unclaimed' }).snapshotId
}

function sameKit(a: SessionKitV1, b: SessionKitV1): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export async function ensureWarmRunner(
  args: {
    workspaceDir: string
    retiring?: string
    bootCarriesRunnerOptions?: boolean
    kit?: SessionKitV1
  },
  deps: WarmRunnerDeps,
): Promise<WarmEnsureOutcome> {
  if (!warmRunnerPoolEnabled()) {
    return { state: 'refused', detail: 'the warm pool is off (MERCURY_WARM_RUNNER=0)' }
  }
  if (args.bootCarriesRunnerOptions === true) {
    return { state: 'refused', detail: 'this boot carries runner-side options the pool cannot serve — its sessions spawn cold with them' }
  }
  const roster = deps.roster()
  if (!roster) return { state: 'refused', detail: 'daemon roster not ready' }
  let workspaceId: string
  try {
    workspaceId = canonicalWorkspaceId(args.workspaceDir)
  } catch {
    return { state: 'refused', detail: `workspace does not resolve: ${args.workspaceDir}` }
  }
  if (args.retiring !== undefined) {
    try {
      retireWarmRunner(canonicalWorkspaceId(args.retiring), 'workspace-switch', deps)
    } catch {
    }
  }
  const inFlight = ensureFlights.get(workspaceId)
  if (inFlight !== undefined) return awaitBehindFlight(inFlight, args.kit, deps)
  const flight: EnsureFlight = { kit: args.kit, run: ensureWarmRunnerFlight(workspaceId, args.kit, deps), trailing: null }
  ensureFlights.set(workspaceId, flight)
  settleEnsureFlight(workspaceId, flight)
  return flight.run
}

function sameRequestedKit(a: SessionKitV1 | undefined, b: SessionKitV1 | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return sameKit(a, b)
}

function awaitBehindFlight(
  flight: EnsureFlight,
  kit: SessionKitV1 | undefined,
  deps: WarmRunnerDeps,
): Promise<WarmEnsureOutcome> {
  if (flight.trailing === null && sameRequestedKit(flight.kit, kit)) return flight.run
  return new Promise<WarmEnsureOutcome>((resolve, reject) => {
    const waiters = flight.trailing?.waiters ?? []
    waiters.push({ resolve, reject })
    flight.trailing = { kit, deps, waiters }
  })
}

function settleEnsureFlight(workspaceId: string, flight: EnsureFlight): void {
  const onSettled = (): void => {
    const next = flight.trailing
    if (next === null) {
      if (ensureFlights.get(workspaceId) === flight) ensureFlights.delete(workspaceId)
      return
    }
    flight.trailing = null
    flight.kit = next.kit
    flight.run = ensureWarmRunnerFlight(workspaceId, next.kit, next.deps)
    void flight.run.then(
      outcome => {
        for (const waiter of next.waiters) waiter.resolve(outcome)
      },
      (err: unknown) => {
        for (const waiter of next.waiters) waiter.reject(err)
      },
    )
    void flight.run.then(onSettled, onSettled)
  }
  void flight.run.then(onSettled, onSettled)
}

async function ensureWarmRunnerFlight(
  workspaceId: string,
  carriedKit: SessionKitV1 | undefined,
  deps: WarmRunnerDeps,
): Promise<WarmEnsureOutcome> {
  const roster = deps.roster()
  if (!roster) return { state: 'refused', detail: 'daemon roster not ready' }
  const kit = carriedKit ?? deriveSessionKitForWorkspace(workspaceId)
  const existing = pool.get(workspaceId)
  if (existing !== undefined) {
    const state = roster.has(existing.short)
    if (state.present && state.alive && (existing.pid === undefined || isProcessAlive(existing.pid))) {
      if (sameKit(existing.kit, kit)) {
        existing.lastKeptAt = Date.now()
        return { state: 'kept', detail: existing.short, short: existing.short }
      }
      retireWarmRunner(workspaceId, 'kit drift — the menu moved since the warm boot', deps)
    } else {
      pool.delete(workspaceId)
    }
  }
  let stat
  try {
    stat = statSync(workspaceId)
  } catch {
    return { state: 'refused', detail: `workspace does not exist: ${workspaceId}` }
  }
  if (!stat.isDirectory()) return { state: 'refused', detail: `workspace is not a directory: ${workspaceId}` }
  const ceiling = effectiveSeatCeiling()
  const seatsHeld = liveSeatCount(deps.dir, roster) + livePoolEntries(roster).length
  if (seatsHeld + 1 > ceiling) {
    return { state: 'refused', detail: `seat reading: ${seatsHeld} held of ${ceiling} — no headroom for a warm runner` }
  }
  const validated = await validateWorkerModelChoice(undefined, 'session')
  if (!validated.ok) {
    return { state: 'refused', detail: `registry default unavailable (${validated.reason}) — the next dispatch spawns cold` }
  }
  if (validated.keyless === true) {
    return { state: 'refused', detail: 'keyless home — nothing to warm; the next birth spawns cold on no model' }
  }
  const appeared = pool.get(workspaceId)
  if (appeared !== undefined) {
    const state = roster.has(appeared.short)
    if (state.present && state.alive && (appeared.pid === undefined || isProcessAlive(appeared.pid)) && sameKit(appeared.kit, kit)) {
      appeared.lastKeptAt = Date.now()
      return { state: 'kept', detail: appeared.short, short: appeared.short }
    }
  }
  const short = mintWarmShort(deps.dir, roster)
  if (short === null) return { state: 'refused', detail: 'no free worker slot' }
  const snapshotId = currentSnapshotId()
  const spec = buildConcourseWorkerSpec({
    runnerId: short,
    workspaceId,
    modelKey: validated.entry.modelId,
    effort: 'high',
    warm: true,
    kit,
  })
  const reg = roster.registerLongLived(short, spec)
  if (!reg.ok) return { state: 'refused', detail: reg.error ?? 'registerLongLived refused' }
  pool.set(workspaceId, {
    short,
    workspaceId,
    ...(reg.pid !== undefined ? { pid: reg.pid } : {}),
    spawnedAt: Date.now(),
    lastKeptAt: Date.now(),
    bootModelKey: validated.entry.modelId,
    snapshotId,
    kit,
  })
  deps.onWarmSpawned?.(short, workspaceId, reg.pid)
  return { state: 'warmed', detail: short, short }
}

export type WarmClaimOutcome =
  | { claimed: true; short: string; pid?: number; spec: StreamJsonChildSpec }
  | { claimed: false; reason: string }

export async function claimWarmRunner(
  args: {
    workspaceId: string
    sessionId: string
    modelKey: string
    effort: string
    permissionMode: string
    kit: SessionKitV1
    resume?: true
    answerDeadlineMs?: number
  },
  deps: WarmRunnerDeps,
): Promise<WarmClaimOutcome> {
  const roster = deps.roster()
  if (!roster) return { claimed: false, reason: 'roster not ready' }
  const entry = pool.get(args.workspaceId)
  if (entry === undefined) return { claimed: false, reason: 'no warm runner for this workspace' }
  const state = roster.has(entry.short)
  if (!state.present || !state.alive || (entry.pid !== undefined && !isProcessAlive(entry.pid))) {
    pool.delete(args.workspaceId)
    return { claimed: false, reason: 'the warm runner died' }
  }
  if (currentSnapshotId() !== entry.snapshotId) {
    retireWarmRunner(args.workspaceId, 'settings-drift', deps)
    return { claimed: false, reason: 'effective settings changed since the warm boot' }
  }
  if (!sameKit(args.kit, entry.kit)) {
    retireWarmRunner(args.workspaceId, 'kit drift — the warm runner booted a different kit than this admission carries', deps)
    return { claimed: false, reason: 'the menu kit changed since the warm boot' }
  }
  const requestId = `${WARM_CLAIM_REQUEST_PREFIX}${entry.short}-${Date.now().toString(36)}`
  const frame = JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: {
      subtype: 'claim_session',
      session_id: args.sessionId,
      model: args.modelKey,
      permission_mode: args.permissionMode,
      effort: args.effort,
      ...(args.resume === true ? { resume: true } : {}),
    },
  })
  const answered = new Promise<{ ok: boolean; error?: string }>(resolve => {
    const timer = setTimeout(() => {
      claimWaiters.delete(requestId)
      resolve({ ok: false, error: `no claim answer in ${(args.answerDeadlineMs ?? CLAIM_ANSWER_DEADLINE_MS) / 1000}s` })
    }, args.answerDeadlineMs ?? CLAIM_ANSWER_DEADLINE_MS)
    timer.unref?.()
    claimWaiters.set(requestId, outcome => {
      clearTimeout(timer)
      claimWaiters.delete(requestId)
      resolve(outcome)
    })
  })
  if (!roster.control(entry.short, frame)) {
    claimWaiters.delete(requestId)
    retireWarmRunner(args.workspaceId, 'no control channel', deps)
    return { claimed: false, reason: 'the warm runner has no live control channel' }
  }
  const outcome = await answered
  if (!outcome.ok) {
    retireWarmRunner(args.workspaceId, `claim failed (${outcome.error ?? 'error'})`, deps)
    return { claimed: false, reason: outcome.error ?? 'the claim was refused' }
  }
  pool.delete(args.workspaceId)
  const spec = roster.patchSeatClaim(entry.short, {
    model: args.modelKey,
    effort: args.effort,
    respawnExtraArgv: ['--resume', args.sessionId, '--permission-prompt-tool', 'stdio', '--include-partial-messages'],
  })
  if (spec === null) {
    roster.kill(entry.short)
    return { claimed: false, reason: 'the claimed seat vanished before the spec patch' }
  }
  return { claimed: true, short: entry.short, ...(entry.pid !== undefined ? { pid: entry.pid } : {}), spec }
}

export function onWarmRunnerLine(line: string): void {
  if (claimWaiters.size === 0 || !line.includes(WARM_CLAIM_REQUEST_PREFIX) || !line.includes('"control_response"')) return
  try {
    const frame = JSON.parse(line) as {
      type?: string
      response?: { subtype?: string; request_id?: string; error?: string }
    }
    if (frame.type !== 'control_response' || typeof frame.response?.request_id !== 'string') return
    const waiter = claimWaiters.get(frame.response.request_id)
    if (waiter === undefined) return
    waiter(frame.response.subtype === 'success' ? { ok: true } : { ok: false, error: frame.response.error ?? 'claim refused' })
  } catch {
  }
}

export function retireWarmRunner(workspaceId: string, reason: string, deps: WarmRunnerDeps): boolean {
  const entry = pool.get(workspaceId)
  if (entry === undefined) return false
  pool.delete(workspaceId)
  const roster = deps.roster()
  const killed = roster !== undefined ? roster.kill(entry.short) : false
  // eslint-disable-next-line no-console
  console.error(`[daemon] warm runner retired: ${entry.short} (${workspaceId}) — ${reason}${killed ? '' : ' (no live child to kill)'}`)
  return true
}

export function sweepIdleWarmRunners(deps: WarmRunnerDeps, opts: { nowMs?: number; thresholdMs?: number } = {}): number {
  const thresholdMs = opts.thresholdMs ?? warmRunnerIdleRetireMs()
  if (!(thresholdMs > 0)) return 0
  const roster = deps.roster()
  if (!roster) return 0
  const nowMs = opts.nowMs ?? Date.now()
  let retired = 0
  for (const entry of livePoolEntries(roster)) {
    const idleMs = nowMs - Math.max(entry.spawnedAt, entry.lastKeptAt)
    if (idleMs < thresholdMs) continue
    retireWarmRunner(entry.workspaceId, `idle ${Math.round(idleMs / 1000)}s past the warm budget`, deps)
    retired++
  }
  return retired
}

export function warmRunnerCount(): number {
  return pool.size
}

export function warmRunnerShorts(): string[] {
  return Array.from(pool.values(), e => e.short)
}

export function warmRunnerFor(workspaceId: string): { short: string; workspaceId: string } | undefined {
  const entry = pool.get(workspaceId)
  return entry === undefined ? undefined : { short: entry.short, workspaceId: entry.workspaceId }
}
