import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from '../utils/crypto.js'
import { recordToEntry } from '../fabric/entryCodec.js'
import { billingSafeRetainedForm, servedModelOfAssistantRow } from '../utils/model/retainedModel.js'
import { logForDebugging } from '../utils/debug.js'
import { durableAtomicPublishSync } from '../substrate/durablePublish.js'
import { flagSpellings } from '../substrate/flagRegistry.js'
import { resolveEffectiveSettingsSnapshot } from '../substrate/startupMenu.js'
import { getProcessStartToken, getProcessStartTokenCachedOrRefresh, isProcessAlive } from './ownerWatch.js'
import { daemonDir } from './controlSocket.js'
import { decideTransition, type ConcourseSessionState } from './concourseLifecycle.js'
import { ensureWorkerWorktree, reapWorkerWorktree, workspaceKindOf } from './concourseWorktrees.js'
import type { CrewRosterPort } from './crewSpawn.js'
import { foldLegacyWorkerModelKey, validateWorkerModelChoice } from '../services/concourse/workerModels.js'
import { describeSeatReading, resolveSeatCeiling } from '../services/switchboard/capacityCheck.js'
import { retireSeatProjections } from '../services/engine-connector/seatProjections.js'
import type { StreamJsonChildSpec } from './headlessRun.js'
import { HEADLESS_PERMISSION_MODES, type HeadlessPermissionMode } from './headlessRun.js'
import { decodePermissionModeSpelling, type PermissionMode } from '../types/permissions.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import { EFFORT_LEVELS, normalizeEffortLevelString } from '../utils/effort.js'
import { getProjectDir } from '../utils/sessionStorage/paths.js'
import { scanTranscriptLinesBackward } from '../utils/sessionStorage/transcriptReader.js'
import { splitAppendSystemPrompt } from '../services/switchboard/runnerArgv.js'
import { writeSessionCloseReceipts } from '../services/switchboard/sessionReceipts.js'
import { deriveSessionKitForPreset, deriveSessionKitForWorkspace, kitStampOf, noteRecordlessResumeKit, restampSessionKit, type KitStampSource, type SessionKitV1 } from './sessionKit.js'


export const CONCOURSE_SHORT_PREFIX = 'concourse-w'


export function canonicalWorkspaceId(dir: string): string {
  try {
    return realpathSync(dir).normalize('NFC')
  } catch {
    return dir.normalize('NFC')
  }
}


export type WorkspaceIsolation = 'exclusive' | 'shared' | 'worktree-isolated' | 'read-only'

export interface WorkspaceClaim {
  workspaceId: string
  isolation?: WorkspaceIsolation
}

export interface ConcourseMoveV1 {
  verb: 'worktree' | 'read-only' | 'queue' | 'pause-holder' | 'revive' | 'retry' | 'init-git'
  label: string
}

export type AdmissionDecision =
  | { admit: true }
  | {
      admit: false
      reason: string
      code: 'runtime-ceiling' | 'workspace-collision'
      moves?: ConcourseMoveV1[]
    }

export function evaluateConcourseAdmission(
  live: readonly WorkspaceClaim[],
  req: WorkspaceClaim,
  ceiling: number = effectiveSeatCeiling(),
): AdmissionDecision {
  if (live.length >= ceiling) {
    return {
      admit: false,
      code: 'runtime-ceiling',
      reason: `every seat is taken — ${describeSeatReading(ceiling)}`,
      moves: [
        { verb: 'queue', label: 'it queues and starts when a seat frees' },
        { verb: 'pause-holder', label: 'or stop a running session to free one' },
      ],
    }
  }
  const reqIso = req.isolation ?? 'exclusive'
  for (const claim of live) {
    if (claim.workspaceId !== req.workspaceId) continue
    const liveIso = claim.isolation ?? 'exclusive'
    const bothReadOnly = liveIso === 'read-only' && reqIso === 'read-only'
    const eitherIsolated = liveIso === 'worktree-isolated' || reqIso === 'worktree-isolated'
    const bothShared = liveIso === 'shared' && reqIso === 'shared'
    if (bothReadOnly || eitherIsolated || bothShared) continue
    return {
      admit: false,
      code: 'workspace-collision',
      reason: `the repo's main checkout is held by a live session`,
      moves: [
        { verb: 'worktree', label: 'replay the launch — it forks a worktree of its own' },
        { verb: 'queue', label: 'or wait — it starts when the checkout frees' },
      ],
    }
  }
  return { admit: true }
}


export interface ConcourseWorkerRecordV1 {
  schema: 1
  runnerId: string
  sessionId: string
  workspaceId: string
  isolation: WorkspaceIsolation
  modelKey: string
  keyless?: true
  agentName?: string
  seatsMax?: 1 | 2
  effort?: string
  spawnedAt: number
  endedAt?: number
  pausedAt?: number
  pausedBy?: string
  pendingModelKey?: string
  pendingEffort?: string
  pendingKitEdits?: Array<{ edit: import('./sessionKit.js').SessionKitEditV1; by: string }>
  spawnSwitches?: Partial<Record<'subagents' | 'workflows', 'on' | 'off'>>
  pendingSpawnSwitches?: Array<{ kind: 'subagents' | 'workflows'; on: boolean; by: string }>
  lastLiveAt: number
  pid?: number
  procStart?: string
  lastDeliveryAt?: number
  lastTurnSettledAt?: number
  bornBlankAt?: number
  settingsSnapshot?: import('../substrate/startupMenu.js').SessionEffectiveSettingsSnapshotV1
  branchName?: string
  worktreePath?: string
  workspaceKind?: 'git' | 'plain-folder'
  title?: string
  titleSource?: 'operator' | 'minted'
  titleMintedAt?: number
  attachedAt?: number
  attachedBy?: string
  attachRequestedAt?: number
  attachRequestedBy?: string
  lastAttachGrantAt?: number
  stoppedAt?: number
  stoppedBy?: string
  stopRequestedAt?: number
  stopRequestedBy?: string
  stopRequestedRetired?: ConcourseWorkerRecordV1['retired']
  retired?: { reason: 'idle-empty'; idleMs: number; thresholdMs: number; at: number }
  crash?: { at: number; reason: string; respawning: boolean }
  runnerArgv?: string[]
  workflowsAllowed?: true
  workflowsGrantedBy?: string
  workflowsGrantedAt?: number
  focusedAt?: number
  focusedBy?: string
  parkedAt?: number
  parkedBy?: string
  parkReason?: string
  parkRequestedAt?: number
  parkRequestedBy?: string
  contract?: import('./sessionContract.js').SessionContractV1
  kit?: import('./sessionKit.js').SessionKitV1
  schedules?: import('./saturn.js').SaturnScheduleV1[]
  heldFires?: import('./saturn.js').HeldFireV1[]
}

export function isNewbornRecord(rec: Pick<ConcourseWorkerRecordV1, 'bornBlankAt' | 'lastDeliveryAt'>): boolean {
  return rec.bornBlankAt !== undefined && rec.lastDeliveryAt === undefined
}

export function turnInFlightOf(rec: Pick<ConcourseWorkerRecordV1, 'lastDeliveryAt' | 'lastTurnSettledAt'>): boolean {
  return rec.lastDeliveryAt !== undefined && (rec.lastTurnSettledAt === undefined || rec.lastTurnSettledAt < rec.lastDeliveryAt)
}


export interface CollisionEvidenceV1 {
  schema: 1
  kind: 'exclusive-overlap' | 'authored-work-retained'
  workspaceId: string
  holders: Array<{ workerId: string; sessionId?: string; isolation?: WorkspaceIsolation }>
  observedAt: number
  refusedClientMessageId?: string
  detail?: string
  files?: string[]
  branchName?: string
  consumedAt?: number
}

interface CollisionFileV1 {
  version: 1
  rows: CollisionEvidenceV1[]
}

const COLLISION_EVIDENCE_CAP = 100

export function concourseCollisionsPath(dir: string = daemonDir()): string {
  return join(dir, 'concourse-collisions.json')
}

export function readCollisionEvidence(dir?: string): CollisionEvidenceV1[] {
  try {
    const raw = JSON.parse(readFileSync(concourseCollisionsPath(dir), 'utf8')) as CollisionFileV1
    if (!raw || raw.version !== 1 || !Array.isArray(raw.rows)) return []
    return raw.rows
  } catch {
    return []
  }
}

export function recordCollisionEvidence(row: CollisionEvidenceV1, dir?: string): void {
  const rows = [...readCollisionEvidence(dir), row].slice(-COLLISION_EVIDENCE_CAP)
  durableAtomicPublishSync(
    concourseCollisionsPath(dir),
    `${JSON.stringify({ version: 1, rows } satisfies CollisionFileV1, null, 1)}\n`,
  )
}

export function markCollisionEvidenceConsumed(
  workspaceId: string,
  workerIds: readonly string[],
  dir?: string,
): void {
  const ids = new Set(workerIds)
  const rows = readCollisionEvidence(dir).map(row =>
    row.kind === 'authored-work-retained' &&
    row.workspaceId === workspaceId &&
    row.consumedAt === undefined &&
    row.holders.some(h => ids.has(h.workerId))
      ? { ...row, consumedAt: Date.now() }
      : row,
  )
  durableAtomicPublishSync(
    concourseCollisionsPath(dir),
    `${JSON.stringify({ version: 1, rows } satisfies CollisionFileV1, null, 1)}\n`,
  )
}

interface ConcourseWorkerFileV1 {
  version: 1
  workers: Record<string, ConcourseWorkerRecordV1>
}

export function concourseWorkersPath(dir: string = daemonDir()): string {
  return join(dir, 'concourse-workers.json')
}

export function readSessionWorkers(dir?: string): Record<string, ConcourseWorkerRecordV1> {
  try {
    const raw = JSON.parse(readFileSync(concourseWorkersPath(dir), 'utf8')) as ConcourseWorkerFileV1
    if (!raw || raw.version !== 1 || typeof raw.workers !== 'object') return {}
    for (const rec of Object.values(raw.workers)) {
      const legacy = rec as ConcourseWorkerRecordV1 & { workerId?: string }
      if (legacy.runnerId === undefined && typeof legacy.workerId === 'string') {
        legacy.runnerId = legacy.workerId
      }
      delete legacy.workerId
    }
    return raw.workers
  } catch {
    return {}
  }
}

export function markConcourseWorkerDelivery(runnerId: string, dir?: string): void {
  try {
    updateConcourseWorkers(workers => {
      const rec = workers[runnerId]
      if (rec && rec.endedAt === undefined) {
        rec.lastDeliveryAt = Date.now()
        delete rec.crash
        if (rec.contract !== undefined && rec.contract.status === 'acknowledged') {
          rec.contract.status = 'active'
        }
      }
    }, dir)
  } catch {
  }
}

export function markConcourseWorkerTurnSettled(runnerId: string, dir?: string): void {
  try {
    updateConcourseWorkers(workers => {
      const rec = workers[runnerId]
      if (rec && rec.endedAt === undefined) rec.lastTurnSettledAt = Date.now()
    }, dir)
  } catch {
  }
}

export function markConcourseWorkerCrash(
  runnerId: string,
  crash: { reason: string; respawning: boolean },
  dir?: string,
): void {
  let journal = false
  let sessionId: string | undefined
  try {
    updateConcourseWorkers(workers => {
      const rec = workers[runnerId]
      if (rec && rec.endedAt === undefined) {
        journal = rec.crash === undefined
        sessionId = rec.sessionId
        rec.crash = { at: Date.now(), reason: crash.reason, respawning: crash.respawning }
      }
    }, dir)
  } catch {
  }
  if (journal) {
    void import('../services/notificationPolicy.js')
      .then(policy =>
        policy.journalConcourseSignal({
          kind: 'failed',
          targetId: runnerId,
          revision: Date.now(),
          title: 'session crashed',
          detail: `worker ${runnerId}: ${crash.reason}`,
          ...(sessionId !== undefined ? { deepLink: { sessionId } } : {}),
          obligationBacked: false,
        }),
      )
      .catch(err => {
        logForDebugging(`[concourse] failed-signal journal failed for ${runnerId}: ${err}`)
      })
  }
}

function pidFieldsOf(pid: number | undefined): { pid?: number; procStart?: string } {
  if (pid === undefined) return {}
  const token = getProcessStartToken(pid) ?? getProcessStartTokenCachedOrRefresh(pid)
  return { pid, ...(token !== null && token !== '' ? { procStart: token } : {}) }
}

function workerPidAlive(rec: { pid?: number; procStart?: string }): boolean {
  if (rec.pid === undefined || !isProcessAlive(rec.pid)) return false
  if (rec.procStart !== undefined) {
    const current = getProcessStartTokenCachedOrRefresh(rec.pid)
    if (current === '') return false
    if (current !== null && current !== rec.procStart) return false
  }
  return true
}

export function markConcourseWorkerRespawn(runnerId: string, pid: number, dir?: string): void {
  try {
    updateConcourseWorkers(workers => {
      const rec = workers[runnerId]
      if (rec && rec.endedAt === undefined) {
        rec.pid = pid
        const fields = pidFieldsOf(pid)
        if (fields.procStart !== undefined) rec.procStart = fields.procStart
        else delete rec.procStart
        rec.lastLiveAt = Date.now()
      }
    }, dir)
  } catch {
  }
}

export function concourseDeltaPath(dir: string = daemonDir()): string {
  return join(dir, 'concourse-delta.json')
}

export interface ConcourseDeltaStampV1 {
  version: 1
  revision: number
  pid: number
  at: number
}

let concourseDeltaRevision = 0

function stampConcourseDelta(dir?: string): void {
  try {
    concourseDeltaRevision += 1
    durableAtomicPublishSync(
      concourseDeltaPath(dir),
      `${JSON.stringify({ version: 1, revision: concourseDeltaRevision, pid: process.pid, at: Date.now() } satisfies ConcourseDeltaStampV1)}\n`,
    )
  } catch {
  }
}

function publishConcourseWorkers(workers: Record<string, ConcourseWorkerRecordV1>, dir?: string): void {
  durableAtomicPublishSync(
    concourseWorkersPath(dir),
    `${JSON.stringify({ version: 1, workers } satisfies ConcourseWorkerFileV1, null, 1)}\n`,
  )
  stampConcourseDelta(dir)
}

export function updateConcourseWorkers(
  mutate: (workers: Record<string, ConcourseWorkerRecordV1>) => void,
  dir?: string,
): Record<string, ConcourseWorkerRecordV1> {
  const workers = readSessionWorkers(dir)
  mutate(workers)
  publishConcourseWorkers(workers, dir)
  return workers
}


export function concourseWorkerStripEnv(): string[] {
  return [
    'MERCURY_SPLASH_HANDOFF',
    'MERCURY_ALT_HELD',
    'MERCURY_LAUNCH_ID',
    'MERCURY_SESSION_KIT',
  ].flatMap(flagSpellings)
}

export function seatInitialPermissionMode(override?: PermissionMode): HeadlessPermissionMode {
  const asHeadless = (mode: string | undefined): HeadlessPermissionMode | undefined => {
    if (mode === undefined || mode.length === 0) return undefined
    const decoded = decodePermissionModeSpelling(mode)
    return (HEADLESS_PERMISSION_MODES as readonly string[]).includes(decoded) ? (decoded as HeadlessPermissionMode) : undefined
  }
  const carried = asHeadless(override)
  if (carried !== undefined) return carried
  try {
    const saved = asHeadless(getInitialSettings().permissions?.defaultMode)
    if (saved !== undefined) return saved
  } catch {
  }
  return 'flow'
}

export function buildConcourseWorkerSpec(args: {
  runnerId: string
  sessionId?: string
  workspaceId: string
  modelKey: string
  keyless?: true
  effort?: string
  title?: string
  resume?: boolean
  cwd?: string
  permissionMode?: PermissionMode
  runnerArgv?: readonly string[]
  warm?: boolean
  kit?: SessionKitV1
}): StreamJsonChildSpec {
  const runnerArgv = splitAppendSystemPrompt(args.runnerArgv ?? [])
  const wireArgv = ['--permission-prompt-tool', 'stdio', '--include-partial-messages'] as const
  return {
    model: foldLegacyWorkerModelKey(args.modelKey),
    ...(args.keyless ? { keyless: true } : {}),
    effort: args.effort ?? 'high',
    appendSystemPrompt: [
      "You run as a BACKGROUND session on the operator's switchboard.",
      'Delegation (subagents/workflows) is available only while this session holds the workflows-allowed tag or the operator is present — when those tools are absent, plan and work single-handed; never wait for them.',
      "'Idle', 'wait', or 'stand by' means END YOUR TURN — the harness wakes you on the next delivery. Never hold a turn open with sleeps or timers to stay available.",
      ...(runnerArgv.append !== null ? ['', runnerArgv.append] : []),
    ].join('\n'),
    role: 'MERCURY_CONCOURSE_WORKER',
    agentName: args.runnerId,
    agentId: `${args.runnerId}@concourse`,
    plainIdentity: true,
    cwd: args.cwd ?? args.workspaceId,
    extraEnv: {
      MERCURY_SESSION_HOME: getProjectDir(args.workspaceId),
      ...(args.kit !== undefined ? { MERCURY_SESSION_KIT: JSON.stringify(args.kit) } : {}),
    },
    permissionMode: seatInitialPermissionMode(args.permissionMode),
    stripEnv: concourseWorkerStripEnv(),
    extraArgv: args.warm
      ? [...wireArgv]
      : args.resume
        ? ['--resume', args.sessionId!, ...wireArgv, ...runnerArgv.rest]
        : [
            '--session-id',
            args.sessionId!,
            ...(args.title !== undefined ? ['--name', args.title] : []),
            ...wireArgv,
            ...runnerArgv.rest,
          ],
    respawnExtraArgv: args.warm ? [...wireArgv] : ['--resume', args.sessionId!, ...wireArgv, ...runnerArgv.rest],
  }
}


export interface ConcourseAdmitDeps {
  roster: () => (CrewRosterPort & { kill?(short: string): boolean }) | undefined
  dir?: string
  onSpawned?: (runnerId: string, spec: StreamJsonChildSpec, pid: number | undefined) => void
  claimWarm?: (args: {
    workspaceId: string
    sessionId: string
    modelKey: string
    effort: string
    permissionMode: string
    kit: SessionKitV1
    resume?: true
  }) => Promise<
    { claimed: true; short: string; pid?: number; spec: StreamJsonChildSpec } | { claimed: false; reason: string }
  >
  ensureWarm?: (workspaceDir: string, kit?: SessionKitV1) => void
}

export function effectiveSeatCeiling(): number {
  return resolveSeatCeiling()
}

export type DefaultedAdmissionResolution =
  | { kind: 'decision'; decision: AdmissionDecision; effectiveIsolation: WorkspaceIsolation }
  | { kind: 'git-offer'; code: 'no-repository'; error: string; moves: ConcourseMoveV1[] }

export function resolveDefaultedAdmission(
  live: ReadonlyArray<{ workspaceId: string; isolation?: WorkspaceIsolation }>,
  claim: { workspaceId: string; isolation?: WorkspaceIsolation },
  seatCeiling: number = effectiveSeatCeiling(),
): DefaultedAdmissionResolution {
  const requested: WorkspaceIsolation = claim.isolation ?? 'exclusive'
  let decision = evaluateConcourseAdmission(
    live,
    { workspaceId: claim.workspaceId, isolation: requested },
    seatCeiling,
  )
  let effectiveIsolation = requested
  if (!decision.admit && decision.code === 'workspace-collision' && claim.isolation === undefined) {
    if (workspaceKindOf(claim.workspaceId) === 'git') {
      const retry = evaluateConcourseAdmission(
        live,
        { workspaceId: claim.workspaceId, isolation: 'worktree-isolated' },
        seatCeiling,
      )
      if (retry.admit) effectiveIsolation = 'worktree-isolated'
      decision = retry
    } else {
      return {
        kind: 'git-offer',
        code: 'no-repository',
        error: 'two sessions here need git — say yes to the git offer and this one forks on its own',
        moves: [{ verb: 'init-git', label: 'say yes to the git offer — it forks and starts by itself' }],
      }
    }
  }
  return { kind: 'decision', decision, effectiveIsolation }
}

export interface ConcourseAdmitRequest {
  workspaceDir: string
  isolation?: WorkspaceIsolation
  modelKey?: string
  effort?: string
  title?: string
  agentName?: string
  seatsMax?: 1 | 2
  resumeSessionId?: string
  permissionMode?: PermissionMode
  runnerArgv?: string[]
  bornBlank?: boolean
  vacatingSessionId?: string
  kit?: SessionKitV1
  kitPreset?: string
}

export type ConcourseRefusalCode =
  | 'runtime-ceiling'
  | 'workspace-collision'
  | 'invalid-request'
  | 'not-ready'
  | 'spawn-failed'
  | 'no-repository'
  | 'git-unavailable'
  | 'unborn-head'

export type ConcourseAdmitResult =
  | {
      ok: true
      runnerId: string
      sessionId: string
      workspaceId: string
      pid?: number
      branchName?: string
      mainHolderTitle?: string
      modelId?: string
      modelDisplayName?: string
      note?: string
      effort?: string
      kitSource?: 'carried' | 'derived' | 'preset'
      presetName?: string
      presetNote?: string
      liveHop?: true
    }
  | { ok: false; error: string; code: ConcourseRefusalCode; moves?: ConcourseMoveV1[] }

export function resumeModelKeyOf(sessionId: string, workspaceDir: string, dir?: string): string | undefined {
  const fromRecord = Object.values(readSessionWorkers(dir))
    .filter(r => r.sessionId === sessionId && r.modelKey !== undefined && r.keyless !== true)
    .sort((a, b) => b.spawnedAt - a.spawnedAt)[0]?.modelKey
  if (fromRecord !== undefined) return fromRecord
  let workspaceId = workspaceDir
  try {
    workspaceId = canonicalWorkspaceId(workspaceDir)
  } catch {
  }
  const transcript = join(getProjectDir(workspaceId), `${sessionId}.jsonl`)
  if (!existsSync(transcript)) return undefined
  let retained: string | undefined
  try {
    scanTranscriptLinesBackward(transcript, line => {
      if (!line.includes('assistant') && !line.includes('output')) return
      try {
        const row = JSON.parse(line) as Record<string, unknown>
        const entry = (
          typeof row.recordId === 'string' && row.payload !== undefined
            ? (recordToEntry(row as never) as Record<string, unknown>)
            : row
        ) as { type?: string; message?: { model?: unknown } }
        const served = servedModelOfAssistantRow(entry)
        if (served !== undefined) {
          retained = billingSafeRetainedForm(served)
          return true
        }
      } catch {
      }
      return
    })
  } catch {
  }
  return retained
}

export function makeConcourseAdmitHandler(
  deps: ConcourseAdmitDeps,
): (req: ConcourseAdmitRequest) => Promise<ConcourseAdmitResult> {
  return async req => {
    if (req.effort !== undefined) {
      const level = normalizeEffortLevelString(req.effort)
      if (level === undefined) {
        return {
          ok: false,
          code: 'invalid-request',
          error: `effort refused ('${req.effort}' is not on the shared ladder — the levels are ${EFFORT_LEVELS.join(' | ')})`,
        }
      }
      req = { ...req, effort: level }
    }
    const retainedModelKey =
      req.modelKey === undefined && req.resumeSessionId !== undefined
        ? resumeModelKeyOf(req.resumeSessionId, req.workspaceDir, deps.dir)
        : undefined
    const validated = await validateWorkerModelChoice(req.modelKey ?? retainedModelKey, 'session')
    let admission = validated
    let retainedNote: string | undefined
    if (!validated.ok && req.modelKey === undefined && retainedModelKey !== undefined && validated.reason.startsWith('no-credential:')) {
      const unnamed = await validateWorkerModelChoice(undefined, 'session')
      if (unnamed.ok) {
        admission = unnamed
        retainedNote =
          unnamed.keyless === true
            ? `the session's model ${retainedModelKey} has no credential here — the first model send picks the neutral default; /model chooses`
            : `the session's model ${retainedModelKey} has no credential here — it continues on ${unnamed.entry.displayName} (the neutral default); /model chooses`
      }
    }
    if (!admission.ok) {
      return {
        ok: false,
        code: 'invalid-request',
        error: `model refused (${admission.reason})${admission.action !== undefined ? ` · ${admission.action}` : ''}${admission.detail !== undefined ? ` — ${admission.detail}` : ''} (got ${JSON.stringify(req.modelKey ?? retainedModelKey ?? '(unset → registry default)')}${retainedModelKey !== undefined && req.modelKey === undefined ? ' — the model this session ran on; --model picks another' : ''})`,
      }
    }
    const modelKey = admission.entry.modelId
    const modelDisplayName = admission.entry.displayName
    const keyless = admission.keyless === true
    if (keyless && admission.note !== undefined && retainedNote === undefined) retainedNote = admission.note
    let stat
    try {
      stat = statSync(req.workspaceDir)
    } catch {
      return { ok: false, code: 'invalid-request', error: `workspace does not exist: ${req.workspaceDir}` }
    }
    if (!stat.isDirectory()) {
      return { ok: false, code: 'invalid-request', error: `workspace is not a directory: ${req.workspaceDir}` }
    }
    const roster = deps.roster()
    if (!roster) return { ok: false, code: 'not-ready', error: 'daemon roster not ready' }

    const workspaceId = canonicalWorkspaceId(req.workspaceDir)
    let preset: { name: string; kit: SessionKitV1; note?: string } | undefined
    if (req.kitPreset !== undefined) {
      if (req.kit !== undefined) {
        return {
          ok: false,
          code: 'invalid-request',
          error: `kit and kitPreset are one door — send one (got a carried kit beside preset '${req.kitPreset.slice(0, 64)}')`,
        }
      }
      const derived = deriveSessionKitForPreset(req.kitPreset, workspaceId)
      if (!derived.ok) return { ok: false, code: 'invalid-request', error: derived.reason }
      preset = { name: req.kitPreset, kit: derived.kit, ...(derived.note !== undefined ? { note: derived.note } : {}) }
    }
    const records = readSessionWorkers(deps.dir)
    const liveShorts = new Set(roster.list().filter(j => !j.outcome).map(j => j.short))
    const liveWorkers = Object.values(records).filter(
      r => r.endedAt === undefined && r.parkedAt === undefined && (liveShorts.has(r.runnerId) || r.attachedAt !== undefined),
    )
    if (req.resumeSessionId !== undefined) {
      const standing = Object.values(records).find(r => r.sessionId === req.resumeSessionId && r.endedAt === undefined)
      if (standing !== undefined) {
        const others = liveWorkers
          .filter(r => r.runnerId !== standing.runnerId)
          .map(r => ({ workspaceId: r.workspaceId, isolation: r.isolation }))
        const reactivated = await reactivateConcourseSession(
          standing,
          {
            modelKey,
            modelDisplayName,
            ...(keyless ? { keyless: true } : {}),
            ...(req.effort !== undefined ? { effort: req.effort } : {}),
            ...(req.permissionMode !== undefined ? { permissionMode: req.permissionMode } : {}),
            ...(req.kit !== undefined ? { kit: req.kit } : {}),
            ...(preset !== undefined ? { preset } : {}),
            by: 'operator',
          },
          others,
          deps,
        )
        return reactivated.ok && retainedNote !== undefined ? { ...reactivated, note: retainedNote } : reactivated
      }
    }
    const admissionClaims = liveWorkers.filter(
      r => req.vacatingSessionId === undefined || r.sessionId !== req.vacatingSessionId,
    )
    const resolution = resolveDefaultedAdmission(
      admissionClaims.map(r => ({ workspaceId: r.workspaceId, isolation: r.isolation })),
      { workspaceId, ...(req.isolation !== undefined ? { isolation: req.isolation } : {}) },
    )
    if (resolution.kind === 'git-offer') {
      return { ok: false, code: resolution.code, error: resolution.error, moves: resolution.moves }
    }
    const { decision } = resolution
    const effectiveIsolation = resolution.effectiveIsolation
    if (!decision.admit)
      return {
        ok: false,
        code: decision.code,
        error: decision.reason,
        ...(decision.moves !== undefined ? { moves: decision.moves } : {}),
      }

    const kit = req.kit ?? preset?.kit ?? deriveSessionKitForWorkspace(workspaceId)
    if (
      deps.claimWarm !== undefined &&
      !keyless &&
      req.resumeSessionId === undefined &&
      (effectiveIsolation === 'exclusive' || effectiveIsolation === 'shared') &&
      (req.runnerArgv === undefined || req.runnerArgv.length === 0)
    ) {
      const claimSessionId = randomUUID()
      const claimEffort = req.effort ?? 'high'
      const claimStartedAt = Date.now()
      const claimed = await deps.claimWarm({
        workspaceId,
        sessionId: claimSessionId,
        modelKey,
        effort: claimEffort,
        permissionMode: seatInitialPermissionMode(req.permissionMode),
        kit,
      })
      if (claimed.claimed) {
        // eslint-disable-next-line no-console
        console.error(`[daemon] warm claim acked in ${Date.now() - claimStartedAt}ms: ${claimed.short} takes session ${claimSessionId}`)
        const runnerId = claimed.short
        const snapshot = resolveEffectiveSettingsSnapshot({ sessionId: claimSessionId })
        updateConcourseWorkers(workers => {
          workers[runnerId] = {
            schema: 1,
            runnerId,
            sessionId: claimSessionId,
            workspaceId,
            isolation: effectiveIsolation,
            modelKey,
            effort: claimEffort,
            ...(typeof req.agentName === 'string' && req.agentName.trim().length > 0
              ? { agentName: req.agentName.trim().slice(0, 24) }
              : {}),
            ...(req.seatsMax === 1 || req.seatsMax === 2 ? { seatsMax: req.seatsMax } : {}),
            spawnedAt: Date.now(),
            lastLiveAt: Date.now(),
            ...pidFieldsOf(claimed.pid),
            settingsSnapshot: snapshot,
            workspaceKind: workspaceKindOf(workspaceId),
            ...(req.title !== undefined ? { title: req.title } : {}),
            ...(req.bornBlank === true ? { bornBlankAt: Date.now() } : {}),
            ...kitStampOf(kit),
          }
        }, deps.dir)
        deps.onSpawned?.(runnerId, claimed.spec, claimed.pid)
        if (deps.ensureWarm !== undefined) {
          const rewarm = setTimeout(() => deps.ensureWarm!(workspaceId, kit), 0)
          rewarm.unref?.()
        }
        return {
          ok: true,
          ...(retainedNote !== undefined ? { note: retainedNote } : {}),
          runnerId,
          sessionId: claimSessionId,
          workspaceId,
          modelId: modelKey,
          modelDisplayName,
          effort: claimEffort,
          kitSource: req.kit !== undefined ? 'carried' : preset !== undefined ? 'preset' : 'derived',
          ...(preset !== undefined ? { presetName: preset.name, ...(preset.note !== undefined ? { presetNote: preset.note } : {}) } : {}),
          ...(claimed.pid !== undefined ? { pid: claimed.pid } : {}),
        }
      }
      logForDebugging(`[daemon] warm claim declined (${claimed.reason}) — spawning cold`)
      if (deps.ensureWarm !== undefined) {
        const rewarm = setTimeout(() => deps.ensureWarm!(workspaceId, kit), 0)
        rewarm.unref?.()
      }
    }

    const used = new Set(
      Object.values(records)
        .filter(r => r.endedAt === undefined)
        .map(r => r.runnerId),
    )
    let runnerId: string | null = null
    for (let n = 1; n <= used.size + 4096; n++) {
      const candidate = `${CONCOURSE_SHORT_PREFIX}${n}`
      if (!used.has(candidate) && !roster.has(candidate).present) {
        runnerId = candidate
        break
      }
    }
    if (runnerId === null) {
      return { ok: false, code: 'runtime-ceiling', error: `no free worker slot — ${describeSeatReading(effectiveSeatCeiling())}` }
    }

    const sessionId = req.resumeSessionId ?? randomUUID()
    const workspaceKind = workspaceKindOf(workspaceId)
    let workerCwd = workspaceId
    let worktreePath: string | undefined
    let worktreeBranch: string | undefined
    if (effectiveIsolation === 'worktree-isolated') {
      const wt = await ensureWorkerWorktree(workspaceId, runnerId, deps.dir, {
        branchName: mintWorktreeBranchName(req.title ?? sessionId.slice(0, 8), records),
      })
      if (!wt.ok) {
        if (wt.code === 'no-repository' || wt.code === 'unborn-head') {
          return {
            ok: false,
            code: wt.code,
            error: wt.error,
            moves: [{ verb: 'init-git', label: 'say yes to the git offer — then it forks on its own' }],
          }
        }
        if (wt.code === 'git-unavailable') {
          return {
            ok: false,
            code: wt.code,
            error: wt.error,
            moves: [{ verb: 'retry', label: 'install git, then replay the launch' }],
          }
        }
        return { ok: false, code: 'invalid-request', error: wt.error }
      }
      workerCwd = wt.path
      worktreePath = wt.path
      worktreeBranch = wt.branchName
    }
    const priorSnapshot =
      req.resumeSessionId !== undefined
        ? Object.values(records)
            .filter(r => r.sessionId === req.resumeSessionId && r.settingsSnapshot !== undefined)
            .sort((a, b) => b.spawnedAt - a.spawnedAt)[0]?.settingsSnapshot
        : undefined
    const snapshot = priorSnapshot ?? resolveEffectiveSettingsSnapshot({ sessionId })
    const effort =
      req.effort ??
      (req.resumeSessionId !== undefined
        ? Object.values(records)
            .filter(r => r.sessionId === req.resumeSessionId && r.effort !== undefined)
            .sort((a, b) => b.spawnedAt - a.spawnedAt)[0]?.effort
        : undefined) ??
      'high'
    if (req.resumeSessionId !== undefined && worktreePath !== undefined) {
      migrateTranscriptHomeToLaw({ sessionId, workspaceId, worktreePath })
    }
    const runnerArgv =
      req.runnerArgv ??
      (req.resumeSessionId !== undefined
        ? Object.values(records)
            .filter(r => r.sessionId === req.resumeSessionId && r.runnerArgv !== undefined)
            .sort((a, b) => b.spawnedAt - a.spawnedAt)[0]?.runnerArgv
        : undefined)
    const spec = buildConcourseWorkerSpec({
      runnerId,
      sessionId,
      workspaceId,
      modelKey,
      ...(keyless ? { keyless: true } : {}),
      effort,
      cwd: workerCwd,
      kit,
      ...(req.title !== undefined ? { title: req.title } : {}),
      ...(req.resumeSessionId !== undefined ? { resume: true } : {}),
      ...(req.permissionMode !== undefined ? { permissionMode: req.permissionMode } : {}),
      ...(runnerArgv !== undefined && runnerArgv.length > 0 ? { runnerArgv } : {}),
    })
    const reg = roster.registerLongLived(runnerId, spec)
    if (!reg.ok) return { ok: false, code: 'spawn-failed', error: reg.error ?? 'registerLongLived refused' }
    updateConcourseWorkers(workers => {
      workers[runnerId!] = {
        schema: 1,
        runnerId: runnerId!,
        sessionId,
        workspaceId,
        isolation: effectiveIsolation,
        modelKey,
        effort,
        ...(keyless ? { keyless: true } : {}),
        ...(typeof req.agentName === 'string' && req.agentName.trim().length > 0
          ? { agentName: req.agentName.trim().slice(0, 24) }
          : {}),
        ...(req.seatsMax === 1 || req.seatsMax === 2 ? { seatsMax: req.seatsMax } : {}),
        spawnedAt: Date.now(),
        lastLiveAt: Date.now(),
        ...pidFieldsOf(reg.pid),
        settingsSnapshot: snapshot,
        workspaceKind,
        ...(worktreePath !== undefined ? { worktreePath } : {}),
        ...(worktreeBranch !== undefined ? { branchName: worktreeBranch } : {}),
        ...(req.title !== undefined ? { title: req.title } : {}),
        ...(runnerArgv !== undefined && runnerArgv.length > 0 ? { runnerArgv: [...runnerArgv] } : {}),
        ...(req.bornBlank === true ? { bornBlankAt: Date.now() } : {}),
        ...kitStampOf(kit),
      }
    }, deps.dir)
    if (req.resumeSessionId !== undefined) {
      noteRecordlessResumeKit({ workspaceId, sessionId }, kit, req.kit !== undefined ? 'carried' : 'derived', 'daemon:admit')
    }
    deps.onSpawned?.(runnerId, spec, reg.pid)
    const mainHolderTitle =
      worktreeBranch !== undefined
        ? liveWorkers.find(
            r => r.workspaceId === workspaceId && ['exclusive', 'shared'].includes(r.isolation ?? 'exclusive'),
          )?.title
        : undefined
    return {
      ok: true,
      ...(retainedNote !== undefined ? { note: retainedNote } : {}),
      runnerId,
      sessionId,
      workspaceId,
      modelId: modelKey,
      modelDisplayName,
      effort,
      kitSource: req.kit !== undefined ? 'carried' : preset !== undefined ? 'preset' : 'derived',
      ...(preset !== undefined ? { presetName: preset.name, ...(preset.note !== undefined ? { presetNote: preset.note } : {}) } : {}),
      ...(reg.pid !== undefined ? { pid: reg.pid } : {}),
      ...(worktreeBranch !== undefined ? { branchName: worktreeBranch } : {}),
      ...(mainHolderTitle !== undefined ? { mainHolderTitle } : {}),
    }
  }
}

function mintWorktreeBranchName(
  seed: string,
  records: Record<string, ConcourseWorkerRecordV1>,
): string {
  const slug =
    seed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'session'
  const taken = new Set(
    Object.values(records)
      .map(r => r.branchName)
      .filter((b): b is string => b !== undefined),
  )
  const base = `mercury/${slug}`
  if (!taken.has(base)) return base
  for (let n = 2; n <= 9; n++) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
  }
  return `${base}-${Date.now().toString(36).slice(-4)}`
}


export type ConcoursePauseOutcome =
  | { outcome: 'applied' }
  | { outcome: 'noop'; reason: 'already-paused' | 'not-paused' }
  | { outcome: 'refused'; reason: 'unknown-worker' | 'terminal-immutable' | 'not-pausable-yet' }

export function pauseConcourseWorker(
  runnerId: string,
  by: string,
  dir?: string,
): ConcoursePauseOutcome {
  let out: ConcoursePauseOutcome = { outcome: 'refused', reason: 'unknown-worker' }
  updateConcourseWorkers(workers => {
    const rec = workers[runnerId]
    if (!rec) return
    if (rec.endedAt !== undefined) {
      out = { outcome: 'refused', reason: 'terminal-immutable' }
      return
    }
    if (rec.pausedAt !== undefined) {
      out = { outcome: 'noop', reason: 'already-paused' }
      return
    }
    const derived: ConcourseSessionState =
      workerPidAlive(rec) ? 'working' : 'starting'
    const d = decideTransition(derived, 'paused')
    if (d.legal !== true) {
      out = { outcome: 'refused', reason: d.reason === 'terminal-immutable' ? 'terminal-immutable' : 'not-pausable-yet' }
      return
    }
    rec.pausedAt = Date.now()
    rec.pausedBy = by
    out = { outcome: 'applied' }
  }, dir)
  return out
}

export function resumeConcourseWorker(
  runnerId: string,
  by: string,
  dir?: string,
): ConcoursePauseOutcome {
  void by
  let out: ConcoursePauseOutcome = { outcome: 'refused', reason: 'unknown-worker' }
  updateConcourseWorkers(workers => {
    const rec = workers[runnerId]
    if (!rec) return
    if (rec.endedAt !== undefined) {
      out = { outcome: 'refused', reason: 'terminal-immutable' }
      return
    }
    if (rec.pausedAt === undefined && rec.attachRequestedAt === undefined) {
      out = { outcome: 'noop', reason: 'not-paused' }
      return
    }
    if (rec.pausedAt !== undefined) {
      const d = decideTransition('paused', 'starting')
      if (d.legal !== true) {
        out = { outcome: 'refused', reason: 'not-pausable-yet' }
        return
      }
    }
    delete rec.pausedAt
    delete rec.pausedBy
    delete rec.attachRequestedAt
    delete rec.attachRequestedBy
    rec.lastLiveAt = Date.now()
    out = { outcome: 'applied' }
  }, dir)
  return out
}

function reapSettledWorktree(
  rec: ConcourseWorkerRecordV1,
  dir?: string,
): { branchName?: string; committedAhead?: number; files: string[] } | undefined {
  if (rec.worktreePath === undefined) return undefined
  const outcome = reapWorkerWorktree(rec.workspaceId, rec.runnerId, dir, {
    path: rec.worktreePath,
    ...(rec.branchName !== undefined ? { branchName: rec.branchName } : {}),
  })
  if (outcome.outcome !== 'retained') return undefined
  recordCollisionEvidence(
    {
      schema: 1,
      kind: 'authored-work-retained',
      workspaceId: rec.workspaceId,
      holders: [{ workerId: rec.runnerId, sessionId: rec.sessionId, isolation: rec.isolation }],
      observedAt: Date.now(),
      detail:
        outcome.committedAhead !== undefined && outcome.committedAhead > 0
          ? `fork retained at settle — ${outcome.committedAhead} commit(s) ahead on ${rec.branchName ?? 'its branch'}${outcome.files.length > 0 ? ` + ${outcome.files.length} uncommitted file(s)` : ''}`
          : `worktree retained at settle — authored work present (${outcome.files.length} file(s)) at ${rec.worktreePath}`,
      files: outcome.files.slice(0, 20),
      ...(rec.branchName !== undefined ? { branchName: rec.branchName } : {}),
    },
    dir,
  )
  return {
    ...(rec.branchName !== undefined ? { branchName: rec.branchName } : {}),
    ...(outcome.committedAhead !== undefined ? { committedAhead: outcome.committedAhead } : {}),
    files: outcome.files,
  }
}

export function settleConcourseWorker(runnerId: string, dir?: string): boolean {
  let settled = false
  let endedSessionId: string | undefined
  let settledRec: ConcourseWorkerRecordV1 | undefined
  updateConcourseWorkers(workers => {
    const rec = workers[runnerId]
    if (rec && rec.endedAt === undefined) {
      rec.endedAt = Date.now()
      delete rec.focusedAt
      delete rec.focusedBy
      settled = true
      endedSessionId = rec.sessionId
      settledRec = rec
    }
  }, dir)
  if (settled && settledRec !== undefined && settledRec.parkedAt === undefined && !isNewbornRecord(settledRec)) {
    try {
      writeSessionCloseReceipts(getProjectDir(settledRec.workspaceId), settledRec.sessionId, 'settle', settledRec.agentName)
    } catch {
    }
  }
  const retainedInfo =
    settled && settledRec !== undefined ? reapSettledWorktree(settledRec, dir) : undefined
  if (settled && endedSessionId !== undefined) {
    try {
      retireSeatProjections(endedSessionId, dir)
    } catch {
    }
  }
  if (settled && endedSessionId !== undefined) {
    const sid2 = endedSessionId
    void import('../services/notificationPolicy.js')
      .then(policy =>
        policy.journalConcourseSignal({
          kind: 'completed',
          targetId: runnerId,
          revision: Date.now(),
          title: 'session settled',
          detail: `worker ${runnerId} released`,
          deepLink: { sessionId: sid2 },
          obligationBacked: false,
        }),
      )
      .catch(err => {
        logForDebugging(`[concourse] completed-signal journal failed for ${runnerId}: ${err}`)
      })
  }
  if (settled && endedSessionId !== undefined) {
    const sid = endedSessionId
    const rec2 = settledRec
    let retained:
      | {
          workspaceId: string
          title: string
          branchName?: string
          mainHolderSessionId?: string
          batchBranches: string[]
          batchWorkerIds: string[]
          worktreePath?: string
          committedAhead?: number
          uncommittedFiles?: string[]
        }
      | undefined
    if (retainedInfo !== undefined && rec2 !== undefined) {
      const holder = Object.values(readSessionWorkers(dir)).find(
        r =>
          r.endedAt === undefined &&
          r.workspaceId === rec2.workspaceId &&
          (r.isolation ?? 'exclusive') === 'exclusive' &&
          workerPidAlive(r),
      )
      const unconsumed = readCollisionEvidence(dir)
        .filter(
          e =>
            e.kind === 'authored-work-retained' &&
            e.workspaceId === rec2.workspaceId &&
            e.consumedAt === undefined &&
            e.branchName !== undefined,
        )
        .sort((a, b) => a.observedAt - b.observedAt)
      retained = {
        workspaceId: rec2.workspaceId,
        title: rec2.title ?? runnerId,
        ...(rec2.branchName !== undefined ? { branchName: rec2.branchName } : {}),
        ...(holder !== undefined ? { mainHolderSessionId: holder.sessionId } : {}),
        batchBranches: [...new Set(unconsumed.map(e => e.branchName as string))],
        batchWorkerIds: [...new Set(unconsumed.flatMap(e => e.holders.map(h => h.workerId)))],
        ...(rec2.worktreePath !== undefined ? { worktreePath: rec2.worktreePath } : {}),
        ...(retainedInfo.committedAhead !== undefined ? { committedAhead: retainedInfo.committedAhead } : {}),
        ...(retainedInfo.files.length > 0 ? { uncommittedFiles: retainedInfo.files.slice(0, 20) } : {}),
      }
    }
    void import('../services/concourse/coordinatorKernel.js')
      .then(k =>
        k
          .runCoordinatorKernel({
            kind: 'worker-settled',
            sessionId: sid,
            runnerId,
            ...(retained !== undefined ? { retained } : {}),
          })
          .then(receipts => {
            if (
              retained !== undefined &&
              receipts.some(
                r =>
                  (r.verb === 'session.redirect' || r.verb === 'session.launch') &&
                  (r.outcome === 'applied' || r.outcome === 'queued'),
              )
            ) {
              markCollisionEvidenceConsumed(retained.workspaceId, retained.batchWorkerIds, dir)
            }
          }),
      )
      .catch(err => {
        logForDebugging(`[concourse] R2 kernel ride failed for ${runnerId}: ${err}`)
      })
  }
  return settled
}


export interface ConcourseReconcileReceipt {
  settled: string[]
  live: string[]
  newbornsReleased: string[]
  parked: string[]
}

export function reconcileConcourseWorkers(
  rosterLiveShorts: ReadonlySet<string>,
  dir?: string,
): ConcourseReconcileReceipt {
  const receipt: ConcourseReconcileReceipt = { settled: [], live: [], newbornsReleased: [], parked: [] }
  updateConcourseWorkers(workers => {
    for (const rec of Object.values(workers)) {
      if (rec.endedAt !== undefined) continue
      if (rec.focusedAt !== undefined) {
        const seatPid = stampedTerminalPid(rec.focusedBy)
        if (seatPid === undefined || !isProcessAlive(seatPid)) {
          logForDebugging(`[concourse] focus stamp healed off ${rec.runnerId} (terminal ${rec.focusedBy ?? 'unnamed'} is gone)`)
          delete rec.focusedAt
          delete rec.focusedBy
        }
      }
      if (rec.parkedAt !== undefined) {
        receipt.parked.push(rec.runnerId)
        continue
      }
      if (rec.parkRequestedAt !== undefined) {
        const requestedRunnerLive = rosterLiveShorts.has(rec.runnerId) || (workerPidAlive(rec))
        if (!requestedRunnerLive) {
          stampParked(rec, rec.parkRequestedBy ?? 'daemon:reconcile')
          receipt.parked.push(rec.runnerId)
          continue
        }
      }
      if (rec.attachedAt !== undefined || rec.stoppedAt !== undefined) {
        receipt.live.push(rec.runnerId)
        continue
      }
      const rosterLive = rosterLiveShorts.has(rec.runnerId)
      const pidLive = workerPidAlive(rec)
      if (rosterLive || pidLive) {
        rec.lastLiveAt = Date.now()
        receipt.live.push(rec.runnerId)
        continue
      }
      if (rec.bornBlankAt !== undefined && rec.lastDeliveryAt === undefined) {
        receipt.newbornsReleased.push(rec.runnerId)
        continue
      }
      if (rec.crash !== undefined) {
        if (rec.crash.respawning) {
          rec.crash = {
            at: rec.crash.at,
            reason: 'crashed — found dead with its daemon; enter to resume, or x x releases it',
            respawning: false,
          }
        }
        continue
      }
      rec.crash = {
        at: Date.now(),
        reason: 'crashed — found dead with its daemon; enter to resume, or x x releases it',
        respawning: false,
      }
      receipt.settled.push(rec.runnerId)
    }
  }, dir)
  for (const runnerId of receipt.newbornsReleased) settleConcourseWorker(runnerId, dir)
  if (receipt.newbornsReleased.length > 0) {
    logForDebugging(`[concourse] reconciled ${receipt.newbornsReleased.length} blank newborn(s) found dead as RELEASED (nothing to bring back): ${receipt.newbornsReleased.join(', ')}`)
  }
  if (receipt.settled.length > 0) {
    logForDebugging(`[concourse] reconciled ${receipt.settled.length} dead worker record(s) as CRASHED (rows kept): ${receipt.settled.join(', ')}`)
    const at = Date.now()
    for (const runnerId of receipt.settled) {
      const sid = readSessionWorkers(dir)[runnerId]?.sessionId
      void import('../services/notificationPolicy.js')
        .then(policy =>
          policy.journalConcourseSignal({
            kind: 'failed',
            targetId: runnerId,
            revision: at,
            title: 'session died',
            detail: `worker ${runnerId} found dead at reconcile`,
            ...(sid !== undefined ? { deepLink: { sessionId: sid } } : {}),
            obligationBacked: false,
          }),
        )
        .catch(err => {
          logForDebugging(`[concourse] failed-signal journal failed for ${runnerId}: ${err}`)
        })
    }
  }
  return receipt
}

export function listConcourseWorkers(
  rosterLiveShorts: ReadonlySet<string> | null,
  dir?: string,
): ConcourseWorkerRecordV1[] {
  const records = Object.values(readSessionWorkers(dir)).filter(r => r.endedAt === undefined)
  if (rosterLiveShorts === null) return records
  return records.filter(r => rosterLiveShorts.has(r.runnerId))
}


export function migrateTranscriptHomeToLaw(rec: {
  sessionId: string
  workspaceId: string
  worktreePath?: string
}): void {
  if (rec.worktreePath === undefined) return
  try {
    const lawHome = getProjectDir(rec.workspaceId)
    const lawPath = join(lawHome, `${rec.sessionId}.jsonl`)
    const legacyPath = join(getProjectDir(rec.worktreePath), `${rec.sessionId}.jsonl`)
    if (!existsSync(lawPath) && existsSync(legacyPath)) {
      mkdirSync(lawHome, { recursive: true })
      renameSync(legacyPath, lawPath)
    }
  } catch {
  }
}

export type ConcourseAttachOutcome =
  | { outcome: 'applied'; runnerId: string }
  | { outcome: 'draining'; runnerId: string }
  | { outcome: 'noop'; reason: 'already-attached'; runnerId: string }
  | {
      outcome: 'refused'
      reason: 'unknown-session' | 'terminal-immutable' | 'attached-elsewhere' | 'no-kill-channel'
      detail?: string
    }

export function attachYieldConcourseSession(
  sessionId: string,
  by: string,
  roster: { kill(short: string): boolean } | undefined,
  dir?: string,
): ConcourseAttachOutcome {
  let out: ConcourseAttachOutcome = { outcome: 'refused', reason: 'unknown-session' }
  updateConcourseWorkers(workers => {
    const rec = Object.values(workers).find(
      r => r.sessionId === sessionId && r.endedAt === undefined,
    )
    if (!rec) return
    if (rec.attachedAt !== undefined) {
      const recordedPid = /^operator:(\d+)$/.exec(rec.attachedBy ?? '')?.[1]
      const callerMatches = rec.attachedBy === undefined || rec.attachedBy === 'operator' || rec.attachedBy === by
      const holderDead = recordedPid !== undefined && !isProcessAlive(Number(recordedPid))
      if (!callerMatches && !holderDead) {
        out = {
          outcome: 'refused',
          reason: 'attached-elsewhere',
          detail: 'this session is open in another terminal — leave it there, then ↵ here',
        }
        return
      }
      rec.attachedBy = by
      rec.lastAttachGrantAt = Date.now()
      out = { outcome: 'noop', reason: 'already-attached', runnerId: rec.runnerId }
      return
    }
    if (rec.attachRequestedAt === undefined) {
      rec.attachRequestedAt = Date.now()
      rec.attachRequestedBy = by
    }
    const alive = workerPidAlive(rec)
    const turnInFlight =
      alive &&
      rec.lastDeliveryAt !== undefined &&
      (rec.lastTurnSettledAt === undefined || rec.lastTurnSettledAt < rec.lastDeliveryAt)
    if (turnInFlight) {
      out = { outcome: 'draining', runnerId: rec.runnerId }
      return
    }
    if (alive) {
      const killed = roster !== undefined && roster.kill(rec.runnerId)
      if (!killed) {
        out = {
          outcome: 'refused',
          reason: 'no-kill-channel',
          detail: `worker ${rec.runnerId} has a live child (pid ${rec.pid}) and no kill channel — enter refused`,
        }
        return
      }
    }
    rec.attachedAt = Date.now()
    rec.attachedBy = by
    rec.lastAttachGrantAt = Date.now()
    delete rec.attachRequestedAt
    delete rec.attachRequestedBy
    delete rec.crash
    rec.lastLiveAt = Date.now()
    migrateTranscriptHomeToLaw(rec)
    out = { outcome: 'applied', runnerId: rec.runnerId }
  }, dir)
  return out
}

export type ConcourseDetachOutcome =
  | { outcome: 'applied'; runnerId: string; pid?: number }
  | { outcome: 'noop'; reason: 'not-attached' }
  | {
      outcome: 'refused'
      reason: 'unknown-session' | 'respawn-failed' | 'superseded-by-reattach'
      detail?: string
    }

export function detachRespawnConcourseSession(
  sessionId: string,
  by: string,
  roster:
    | {
        kill(short: string): boolean
        has(short: string): { present: boolean }
        registerLongLived(
          short: string,
          spec: StreamJsonChildSpec,
        ): { ok: boolean; pid?: number; error?: string }
      }
    | undefined,
  dir?: string,
  opts?: { mintedAtMs?: number },
): ConcourseDetachOutcome {
  void by
  const rec = Object.values(readSessionWorkers(dir)).find(
    r => r.sessionId === sessionId && r.endedAt === undefined,
  )
  if (!rec) return { outcome: 'refused', reason: 'unknown-session' }
  if (rec.attachedAt === undefined) return { outcome: 'noop', reason: 'not-attached' }
  if (
    opts?.mintedAtMs !== undefined &&
    rec.lastAttachGrantAt !== undefined &&
    rec.lastAttachGrantAt > opts.mintedAtMs
  ) {
    return {
      outcome: 'refused',
      reason: 'superseded-by-reattach',
      detail: 'the session was re-entered after this hand-back was queued — nothing to do',
    }
  }
  if (!roster)
    return { outcome: 'refused', reason: 'respawn-failed', detail: 'daemon roster not ready' }
  const spec = buildConcourseWorkerSpec({
    runnerId: rec.runnerId,
    sessionId: rec.sessionId,
    workspaceId: rec.workspaceId,
    modelKey: rec.modelKey,
    ...(rec.effort !== undefined ? { effort: rec.effort } : {}),
    ...(rec.title !== undefined ? { title: rec.title } : {}),
    ...(rec.runnerArgv !== undefined ? { runnerArgv: rec.runnerArgv } : {}),
    ...(rec.kit !== undefined ? { kit: rec.kit } : {}),
    resume: true,
    cwd: rec.worktreePath ?? rec.workspaceId,
  })
  let reg = roster.registerLongLived(rec.runnerId, spec)
  if (!reg.ok && roster.has(rec.runnerId).present) {
    roster.kill(rec.runnerId)
    reg = roster.registerLongLived(rec.runnerId, spec)
  }
  if (!reg.ok) {
    updateConcourseWorkers(workers => {
      const w = workers[rec.runnerId]
      if (w) {
        delete w.attachedAt
        delete w.attachedBy
        delete w.attachRequestedAt
        delete w.attachRequestedBy
      }
    }, dir)
    return {
      outcome: 'refused',
      reason: 'respawn-failed',
      ...(reg.error !== undefined ? { detail: reg.error } : {}),
    }
  }
  updateConcourseWorkers(workers => {
    const w = workers[rec.runnerId]
    if (!w) return
    delete w.attachedAt
    delete w.attachedBy
    delete w.attachRequestedAt
    delete w.attachRequestedBy
    delete w.pausedAt
    delete w.pausedBy
    w.lastLiveAt = Date.now()
    if (reg.pid !== undefined) Object.assign(w, pidFieldsOf(reg.pid))
  }, dir)
  return {
    outcome: 'applied',
    runnerId: rec.runnerId,
    ...(reg.pid !== undefined ? { pid: reg.pid } : {}),
  }
}

export type ConcourseReviveOutcome =
  | { outcome: 'applied'; runnerId: string; pid?: number }
  | { outcome: 'noop'; reason: 'already-live' }
  | {
      outcome: 'refused'
      reason: 'unknown-session' | 'attached' | 'stopped' | 'respawn-failed'
      detail?: string
    }

export function reviveConcourseWorker(
  sessionId: string,
  by: string,
  roster:
    | {
        kill(short: string): boolean
        has(short: string): { present: boolean }
        registerLongLived(
          short: string,
          spec: StreamJsonChildSpec,
        ): { ok: boolean; pid?: number; error?: string }
      }
    | undefined,
  opts?: {
    allowStopped?: boolean
    clearCrash?: boolean
    kitOverride?: SessionKitV1
  },
  dir?: string,
): ConcourseReviveOutcome {
  void by
  const rec = Object.values(readSessionWorkers(dir)).find(
    r => r.sessionId === sessionId && r.endedAt === undefined,
  )
  if (!rec) return { outcome: 'refused', reason: 'unknown-session' }
  if (rec.attachedAt !== undefined)
    return { outcome: 'refused', reason: 'attached', detail: 'the session is with the operator' }
  if (rec.stoppedAt !== undefined && opts?.allowStopped !== true)
    return {
      outcome: 'refused',
      reason: 'stopped',
      detail: 'stopped — the session was stopped on purpose; resume it to bring it back',
    }
  if (workerPidAlive(rec)) return { outcome: 'noop', reason: 'already-live' }
  if (!roster)
    return { outcome: 'refused', reason: 'respawn-failed', detail: 'daemon roster not ready' }
  const reviveKit = opts?.kitOverride ?? rec.kit
  const spec = buildConcourseWorkerSpec({
    runnerId: rec.runnerId,
    sessionId: rec.sessionId,
    workspaceId: rec.workspaceId,
    modelKey: rec.modelKey,
    ...(rec.effort !== undefined ? { effort: rec.effort } : {}),
    ...(rec.title !== undefined ? { title: rec.title } : {}),
    ...(rec.runnerArgv !== undefined ? { runnerArgv: rec.runnerArgv } : {}),
    ...(reviveKit !== undefined ? { kit: reviveKit } : {}),
    resume: true,
    cwd: rec.worktreePath ?? rec.workspaceId,
  })
  let reg = roster.registerLongLived(rec.runnerId, spec)
  if (!reg.ok && roster.has(rec.runnerId).present) {
    roster.kill(rec.runnerId)
    reg = roster.registerLongLived(rec.runnerId, spec)
  }
  if (!reg.ok)
    return {
      outcome: 'refused',
      reason: 'respawn-failed',
      ...(reg.error !== undefined ? { detail: reg.error } : {}),
    }
  updateConcourseWorkers(workers => {
    const w = workers[rec.runnerId]
    if (!w) return
    delete w.stoppedAt
    delete w.stoppedBy
    delete w.retired
    clearParkedFields(w)
    if (opts?.clearCrash === true) delete w.crash
    w.lastLiveAt = Date.now()
    if (reg.pid !== undefined) Object.assign(w, pidFieldsOf(reg.pid))
  }, dir)
  return {
    outcome: 'applied',
    runnerId: rec.runnerId,
    ...(reg.pid !== undefined ? { pid: reg.pid } : {}),
  }
}


function clearReactivatedFields(rec: ConcourseWorkerRecordV1): void {
  clearParkedFields(rec)
  delete rec.stoppedAt
  delete rec.stoppedBy
  delete rec.retired
  delete rec.crash
  delete rec.pausedAt
  delete rec.pausedBy
  delete rec.attachRequestedAt
  delete rec.attachRequestedBy
}

function refuseReactivate(
  rec: ConcourseWorkerRecordV1,
  code: ConcourseRefusalCode,
  error: string,
  dir?: string,
  moves?: ConcourseMoveV1[],
): ConcourseAdmitResult {
  updateConcourseWorkers(workers => {
    const w = workers[rec.runnerId]
    if (!w || w.endedAt !== undefined) return
    if (w.parkedAt === undefined) stampParked(w, 'daemon:reactivate', error)
    else w.parkReason = error
  }, dir)
  return { ok: false, code, error, ...(moves !== undefined ? { moves } : {}) }
}

export async function reactivateConcourseSession(
  rec: ConcourseWorkerRecordV1,
  args: {
    modelKey: string
    modelDisplayName?: string
    keyless?: true
    effort?: string
    permissionMode?: PermissionMode
    kit?: SessionKitV1
    preset?: { name: string; kit: SessionKitV1; note?: string }
    by: string
  },
  live: ReadonlyArray<{ workspaceId: string; isolation?: WorkspaceIsolation }>,
  deps: ConcourseAdmitDeps,
): Promise<ConcourseAdmitResult> {
  const roster = deps.roster()
  if (!roster) return refuseReactivate(rec, 'not-ready', 'parked — the daemon roster is not ready · ↵ again retries', deps.dir)
  const display = args.modelDisplayName !== undefined ? { modelDisplayName: args.modelDisplayName } : {}
  const alive = workerPidAlive(rec)
  if (alive || rec.attachedAt !== undefined) {
    if (rec.parkRequestedAt !== undefined) {
      updateConcourseWorkers(workers => {
        const w = workers[rec.runnerId]
        if (!w) return
        delete w.parkRequestedAt
        delete w.parkRequestedBy
      }, deps.dir)
    }
    return {
      ok: true,
      runnerId: rec.runnerId,
      sessionId: rec.sessionId,
      workspaceId: rec.workspaceId,
      modelId: rec.modelKey,
      ...(rec.effort !== undefined ? { effort: rec.effort } : {}),
      ...display,
      ...(rec.pid !== undefined ? { pid: rec.pid } : {}),
      liveHop: true,
    }
  }
  const claimIsolation: WorkspaceIsolation =
    (rec.isolation ?? 'exclusive') === 'exclusive' && rec.worktreePath === undefined ? 'shared' : rec.isolation
  const decision = evaluateConcourseAdmission(live, { workspaceId: rec.workspaceId, isolation: claimIsolation })
  if (!decision.admit) {
    return refuseReactivate(rec, decision.code, `parked — ${decision.reason} · ↵ again retries`, deps.dir, decision.moves)
  }
  const isolationDrift = claimIsolation !== (rec.isolation ?? 'exclusive')
  const effort = args.effort ?? rec.effort ?? 'high'
  const kit = args.kit ?? args.preset?.kit ?? deriveSessionKitForWorkspace(rec.workspaceId)
  const kitSource: KitStampSource = args.kit !== undefined ? 'carried' : args.preset !== undefined ? 'preset' : 'derived'
  if (
    deps.claimWarm !== undefined &&
    ((rec.isolation ?? 'exclusive') === 'exclusive' || rec.isolation === 'shared') &&
    rec.worktreePath === undefined &&
    (rec.runnerArgv === undefined || rec.runnerArgv.length === 0)
  ) {
    const claimStartedAt = Date.now()
    const claimed = await deps.claimWarm({
      workspaceId: rec.workspaceId,
      sessionId: rec.sessionId,
      modelKey: args.modelKey,
      effort,
      permissionMode: seatInitialPermissionMode(args.permissionMode),
      kit,
      resume: true,
    })
    if (claimed.claimed) {
      // eslint-disable-next-line no-console
      console.error(`[daemon] warm claim acked in ${Date.now() - claimStartedAt}ms: ${claimed.short} takes back session ${rec.sessionId} (${rec.runnerId} reactivated in place)`)
      const short = claimed.short
      updateConcourseWorkers(workers => {
        const current = workers[rec.runnerId]
        if (!current || current.endedAt !== undefined) return
        if (short !== rec.runnerId) delete workers[rec.runnerId]
        const next: ConcourseWorkerRecordV1 = { ...current, runnerId: short, modelKey: args.modelKey, effort, lastLiveAt: Date.now() }
        if (args.keyless === true) next.keyless = true
        else delete next.keyless
        if (claimed.pid !== undefined) next.pid = claimed.pid
        else delete next.pid
        if (isolationDrift) next.isolation = claimIsolation
        clearReactivatedFields(next)
        restampSessionKit(next, kit, kitSource, args.by)
        workers[short] = next
      }, deps.dir)
      deps.onSpawned?.(short, claimed.spec, claimed.pid)
      if (deps.ensureWarm !== undefined) {
        const rewarm = setTimeout(() => deps.ensureWarm!(rec.workspaceId, kit), 0)
        rewarm.unref?.()
      }
      return {
        ok: true,
        runnerId: short,
        sessionId: rec.sessionId,
        workspaceId: rec.workspaceId,
        modelId: args.modelKey,
        effort,
        kitSource,
        ...(args.preset !== undefined ? { presetName: args.preset.name, ...(args.preset.note !== undefined ? { presetNote: args.preset.note } : {}) } : {}),
        ...display,
        ...(claimed.pid !== undefined ? { pid: claimed.pid } : {}),
      }
    }
    logForDebugging(`[daemon] warm claim declined for the reactivate of ${rec.sessionId} (${claimed.reason}) — respawning cold`)
    if (deps.ensureWarm !== undefined) {
      const rewarm = setTimeout(() => deps.ensureWarm!(rec.workspaceId, kit), 0)
      rewarm.unref?.()
    }
  }
  const keylessDrift = (args.keyless === true) !== (rec.keyless === true)
  if (args.modelKey !== rec.modelKey || effort !== rec.effort || isolationDrift || keylessDrift) {
    updateConcourseWorkers(workers => {
      const w = workers[rec.runnerId]
      if (!w || w.endedAt !== undefined) return
      w.modelKey = args.modelKey
      w.effort = effort
      if (args.keyless === true) w.keyless = true
      else delete w.keyless
      if (isolationDrift) w.isolation = claimIsolation
    }, deps.dir)
  }
  const reviveRoster = {
    kill: (short: string): boolean => roster.kill?.(short) ?? false,
    has: (short: string): { present: boolean } => roster.has(short),
    registerLongLived: (short: string, spec: StreamJsonChildSpec): { ok: boolean; pid?: number; error?: string } => roster.registerLongLived(short, spec),
  }
  const revived = reviveConcourseWorker(rec.sessionId, args.by, reviveRoster, { allowStopped: true, clearCrash: true, kitOverride: kit }, deps.dir)
  if (revived.outcome === 'refused') {
    return refuseReactivate(rec, 'spawn-failed', `parked — ${revived.detail ?? revived.reason} · ↵ again retries`, deps.dir)
  }
  if (revived.outcome === 'applied') {
    updateConcourseWorkers(workers => {
      const w = workers[rec.runnerId]
      if (!w || w.endedAt !== undefined) return
      restampSessionKit(w, kit, kitSource, args.by)
    }, deps.dir)
  }
  const pid = revived.outcome === 'applied' ? revived.pid : rec.pid
  deps.onSpawned?.(
    rec.runnerId,
    buildConcourseWorkerSpec({
      runnerId: rec.runnerId,
      sessionId: rec.sessionId,
      workspaceId: rec.workspaceId,
      modelKey: args.modelKey,
      ...(args.keyless ? { keyless: true } : {}),
      effort,
      kit,
      ...(rec.title !== undefined ? { title: rec.title } : {}),
      ...(rec.runnerArgv !== undefined ? { runnerArgv: rec.runnerArgv } : {}),
      ...(args.permissionMode !== undefined ? { permissionMode: args.permissionMode } : {}),
      resume: true,
      cwd: rec.worktreePath ?? rec.workspaceId,
    }),
    pid,
  )
  return {
    ok: true,
    runnerId: rec.runnerId,
    sessionId: rec.sessionId,
    workspaceId: rec.workspaceId,
    modelId: args.modelKey,
    effort,
    ...(revived.outcome === 'applied' ? { kitSource } : {}),
    ...(revived.outcome === 'applied' && args.preset !== undefined ? { presetName: args.preset.name, ...(args.preset.note !== undefined ? { presetNote: args.preset.note } : {}) } : {}),
    ...display,
    ...(pid !== undefined ? { pid } : {}),
  }
}

export type ConcourseStopOutcome =
  | {
      outcome: 'applied'
      runnerId: string
      acknowledged: boolean
    }
  | { outcome: 'noop'; reason: 'already-stopped' }
  | { outcome: 'refused'; reason: 'unknown-session' | 'no-kill-channel'; detail?: string }

function stampStopped(rec: ConcourseWorkerRecordV1, by: string, retired?: ConcourseWorkerRecordV1['retired']): void {
  rec.stoppedAt = Date.now()
  rec.stoppedBy = by
  if (retired !== undefined) rec.retired = retired
  delete rec.stopRequestedAt
  delete rec.stopRequestedBy
  delete rec.stopRequestedRetired
  delete rec.crash
}

export function stopConcourseSession(
  sessionId: string,
  by: string,
  roster: { kill(short: string): boolean } | undefined,
  dir?: string,
  retired?: ConcourseWorkerRecordV1['retired'],
): ConcourseStopOutcome {
  let out: ConcourseStopOutcome = { outcome: 'refused', reason: 'unknown-session' }
  updateConcourseWorkers(workers => {
    const rec = Object.values(workers).find(
      r => r.sessionId === sessionId && r.endedAt === undefined,
    )
    if (!rec) return
    if (rec.stoppedAt !== undefined || rec.parkedAt !== undefined) {
      out = { outcome: 'noop', reason: 'already-stopped' }
      return
    }
    if (workerPidAlive(rec)) {
      const killed = roster !== undefined && roster.kill(rec.runnerId)
      if (!killed) {
        out = {
          outcome: 'refused',
          reason: 'no-kill-channel',
          detail: `worker ${rec.runnerId} has a live child (pid ${rec.pid}) and no kill channel — record left live`,
        }
        return
      }
      if (rec.stopRequestedAt === undefined) {
        rec.stopRequestedAt = Date.now()
        rec.stopRequestedBy = by
        if (retired !== undefined) rec.stopRequestedRetired = retired
      }
      out = { outcome: 'applied', runnerId: rec.runnerId, acknowledged: false }
      return
    }
    stampStopped(rec, by, retired)
    out = { outcome: 'applied', runnerId: rec.runnerId, acknowledged: true }
  }, dir)
  return out
}

export function completeRequestedStop(runnerId: string, dir?: string): boolean {
  const standing = readSessionWorkers(dir)[runnerId]
  if (!standing || standing.endedAt !== undefined || standing.stoppedAt !== undefined || standing.stopRequestedAt === undefined) return false
  let completed = false
  updateConcourseWorkers(workers => {
    const rec = workers[runnerId]
    if (!rec || rec.endedAt !== undefined || rec.stoppedAt !== undefined || rec.stopRequestedAt === undefined) return
    if (workerPidAlive(rec)) return
    stampStopped(rec, rec.stopRequestedBy ?? 'daemon', rec.stopRequestedRetired)
    completed = true
  }, dir)
  return completed
}


function stampParked(rec: ConcourseWorkerRecordV1, by: string, reason?: string): void {
  rec.parkedAt = Date.now()
  rec.parkedBy = by
  if (reason !== undefined) rec.parkReason = reason
  else delete rec.parkReason
  delete rec.parkRequestedAt
  delete rec.parkRequestedBy
  delete rec.stoppedAt
  delete rec.stoppedBy
  delete rec.retired
  delete rec.pausedAt
  delete rec.pausedBy
  delete rec.attachRequestedAt
  delete rec.attachRequestedBy
  delete rec.crash
  delete rec.focusedAt
  delete rec.focusedBy
  try {
    writeSessionCloseReceipts(getProjectDir(rec.workspaceId), rec.sessionId, 'park', rec.agentName)
  } catch {
  }
}

function clearParkedFields(rec: ConcourseWorkerRecordV1): void {
  delete rec.parkedAt
  delete rec.parkedBy
  delete rec.parkReason
  delete rec.parkRequestedAt
  delete rec.parkRequestedBy
}

export const PARK_DRAIN_CUT_REASON = 'parked — turn cut at the drain ceiling'

export type ConcourseParkOutcome =
  | { outcome: 'applied'; runnerId: string; released: boolean }
  | { outcome: 'draining'; runnerId: string }
  | { outcome: 'noop'; reason: 'already-parked' }
  | { outcome: 'refused'; reason: 'unknown-session' | 'no-kill-channel'; detail?: string }

export function parkConcourseSession(
  sessionId: string,
  by: string,
  roster: { kill(short: string): boolean } | undefined,
  dir?: string,
  opts?: { reason?: string; afterTurn?: boolean },
): ConcourseParkOutcome {
  let out: ConcourseParkOutcome = { outcome: 'refused', reason: 'unknown-session' }
  let releaseNewborn: string | undefined
  updateConcourseWorkers(workers => {
    const rec = Object.values(workers).find(r => r.sessionId === sessionId && r.endedAt === undefined)
    if (!rec) return
    if (rec.parkedAt !== undefined) {
      out = { outcome: 'noop', reason: 'already-parked' }
      return
    }
    const alive = workerPidAlive(rec)
    if (alive && !isNewbornRecord(rec) && turnInFlightOf(rec) && opts?.afterTurn !== false) {
      if (rec.parkRequestedAt === undefined) {
        rec.parkRequestedAt = Date.now()
        rec.parkRequestedBy = by
      }
      out = { outcome: 'draining', runnerId: rec.runnerId }
      return
    }
    if (alive) {
      const killed = roster !== undefined && roster.kill(rec.runnerId)
      if (!killed) {
        out = {
          outcome: 'refused',
          reason: 'no-kill-channel',
          detail: `worker ${rec.runnerId} has a live child (pid ${rec.pid}) and no kill channel — record left live`,
        }
        return
      }
    }
    if (isNewbornRecord(rec)) {
      releaseNewborn = rec.runnerId
      out = { outcome: 'applied', runnerId: rec.runnerId, released: true }
      return
    }
    stampParked(rec, by, opts?.reason)
    out = { outcome: 'applied', runnerId: rec.runnerId, released: false }
  }, dir)
  if (releaseNewborn !== undefined) settleConcourseWorker(releaseNewborn, dir)
  return out
}

export function completeRequestedPark(
  runnerId: string,
  roster: { kill(short: string): boolean } | undefined,
  dir?: string,
): boolean {
  const standing = readSessionWorkers(dir)[runnerId]
  if (!standing || standing.endedAt !== undefined || standing.parkedAt !== undefined || standing.parkRequestedAt === undefined) return false
  let completed = false
  updateConcourseWorkers(workers => {
    const rec = workers[runnerId]
    if (!rec || rec.endedAt !== undefined || rec.parkedAt !== undefined || rec.parkRequestedAt === undefined) return
    const alive = workerPidAlive(rec)
    if (alive && turnInFlightOf(rec)) return
    if (alive && !(roster !== undefined && roster.kill(rec.runnerId))) return
    stampParked(rec, rec.parkRequestedBy ?? 'daemon')
    completed = true
  }, dir)
  return completed
}

export function pendingParkRequests(dir?: string): string[] {
  return Object.values(readSessionWorkers(dir))
    .filter(r => r.endedAt === undefined && r.parkedAt === undefined && r.parkRequestedAt !== undefined && workerPidAlive(r))
    .map(r => r.runnerId)
}

export interface ConcourseParkAllReceipt {
  parked: string[]
  draining: string[]
  released: string[]
  skipped: string[]
  refused: string[]
}

export function parkAllConcourseSessions(
  by: string,
  roster: { kill(short: string): boolean } | undefined,
  dir?: string,
  opts?: { reason?: string; exceptFocusedByLiveTerminal?: boolean },
): ConcourseParkAllReceipt {
  const receipt: ConcourseParkAllReceipt = { parked: [], draining: [], released: [], skipped: [], refused: [] }
  for (const rec of Object.values(readSessionWorkers(dir))) {
    if (rec.endedAt !== undefined || rec.parkedAt !== undefined) continue
    if (rec.stoppedAt !== undefined || rec.attachedAt !== undefined) {
      receipt.skipped.push(rec.runnerId)
      continue
    }
    if (opts?.exceptFocusedByLiveTerminal === true && rec.focusedAt !== undefined && rec.focusedBy !== by) {
      const seatPid = stampedTerminalPid(rec.focusedBy)
      if (seatPid !== undefined && isProcessAlive(seatPid)) {
        receipt.skipped.push(rec.runnerId)
        continue
      }
    }
    const out = parkConcourseSession(rec.sessionId, by, roster, dir, opts?.reason !== undefined ? { reason: opts.reason } : undefined)
    if (out.outcome === 'applied') (out.released ? receipt.released : receipt.parked).push(rec.runnerId)
    else if (out.outcome === 'draining') receipt.draining.push(rec.runnerId)
    else if (out.outcome === 'refused') receipt.refused.push(rec.runnerId)
  }
  return receipt
}

export type ConcourseTagOutcome =
  | { outcome: 'applied' }
  | { outcome: 'noop'; reason: 'already-granted' | 'not-granted' }
  | { outcome: 'refused'; reason: 'unknown-session' | 'cap-one'; detail?: string }

export function grantConcourseWorkflows(
  sessionId: string,
  by: string,
  dir?: string,
): ConcourseTagOutcome {
  let out: ConcourseTagOutcome = { outcome: 'refused', reason: 'unknown-session' }
  updateConcourseWorkers(workers => {
    const rec = Object.values(workers).find(
      r => r.sessionId === sessionId && r.endedAt === undefined,
    )
    if (!rec) return
    if (rec.workflowsAllowed === true) {
      out = { outcome: 'noop', reason: 'already-granted' }
      return
    }
    const holder = Object.values(workers).find(
      r => r.endedAt === undefined && r.workflowsAllowed === true,
    )
    if (holder) {
      out = {
        outcome: 'refused',
        reason: 'cap-one',
        detail: `"${holder.title ?? holder.runnerId}" already holds workflows-allowed — one tagged session at a time; revoke it first`,
      }
      return
    }
    rec.workflowsAllowed = true
    rec.workflowsGrantedBy = by
    rec.workflowsGrantedAt = Date.now()
    out = { outcome: 'applied' }
  }, dir)
  return out
}

export function revokeConcourseWorkflows(
  sessionId: string,
  by: string,
  dir?: string,
): ConcourseTagOutcome {
  void by
  let out: ConcourseTagOutcome = { outcome: 'refused', reason: 'unknown-session' }
  updateConcourseWorkers(workers => {
    const rec = Object.values(workers).find(
      r => r.sessionId === sessionId && r.endedAt === undefined,
    )
    if (!rec) return
    if (rec.workflowsAllowed !== true) {
      out = { outcome: 'noop', reason: 'not-granted' }
      return
    }
    delete rec.workflowsAllowed
    delete rec.workflowsGrantedBy
    delete rec.workflowsGrantedAt
    out = { outcome: 'applied' }
  }, dir)
  return out
}


export type ConcourseFocusOutcome =
  | { outcome: 'applied'; runnerId: string; cleared: string[] }
  | { outcome: 'noop'; reason: 'already-focused' | 'not-focused' }
  | { outcome: 'refused'; reason: 'unknown-session' }

export function stampedTerminalPid(by: string | undefined): number | undefined {
  const pid = /^operator:(\d+)$/.exec(by ?? '')?.[1]
  return pid === undefined ? undefined : Number(pid)
}

export function focusConcourseSession(sessionId: string, by: string, dir?: string): ConcourseFocusOutcome {
  let out: ConcourseFocusOutcome = { outcome: 'refused', reason: 'unknown-session' }
  updateConcourseWorkers(workers => {
    const rec = Object.values(workers).find(r => r.sessionId === sessionId && r.endedAt === undefined)
    if (!rec) return
    const cleared: string[] = []
    for (const other of Object.values(workers)) {
      if (other === rec || other.endedAt !== undefined || other.focusedBy !== by) continue
      delete other.focusedAt
      delete other.focusedBy
      cleared.push(other.runnerId)
    }
    if (rec.focusedAt !== undefined && rec.focusedBy === by && cleared.length === 0) {
      out = { outcome: 'noop', reason: 'already-focused' }
      return
    }
    rec.focusedAt = Date.now()
    rec.focusedBy = by
    out = { outcome: 'applied', runnerId: rec.runnerId, cleared }
  }, dir)
  return out
}

export function blurConcourseSession(sessionId: string, by: string, dir?: string): ConcourseFocusOutcome {
  let out: ConcourseFocusOutcome = { outcome: 'refused', reason: 'unknown-session' }
  updateConcourseWorkers(workers => {
    const rec = Object.values(workers).find(r => r.sessionId === sessionId && r.endedAt === undefined)
    if (!rec) return
    if (rec.focusedAt === undefined || rec.focusedBy !== by) {
      out = { outcome: 'noop', reason: 'not-focused' }
      return
    }
    delete rec.focusedAt
    delete rec.focusedBy
    out = { outcome: 'applied', runnerId: rec.runnerId, cleared: [rec.runnerId] }
  }, dir)
  return out
}

export function setConcourseSessionTitle(
  sessionId: string,
  rawTitle: string,
  by: string,
  source: 'operator' | 'minted',
  dir?: string,
): { outcome: 'applied' | 'noop' | 'refused'; detail?: string } {
  void by
  const title = rawTitle.replace(/\s+/g, ' ').trim().slice(0, 200)
  if (title.length === 0) return { outcome: 'refused', detail: 'a title needs words' }
  let out: { outcome: 'applied' | 'noop' | 'refused'; detail?: string } = {
    outcome: 'refused',
    detail: 'unknown-session: no live worker record owns this session',
  }
  updateConcourseWorkers(workers => {
    const rec = Object.values(workers).find(r => r.sessionId === sessionId && r.endedAt === undefined)
    if (!rec) return
    if (source === 'minted') {
      if (rec.titleMintedAt !== undefined) {
        out = { outcome: 'noop', detail: 'minted once already — the mint never runs twice' }
        return
      }
      if ((rec.title ?? '').trim().length > 0) {
        out = { outcome: 'noop', detail: 'a title already stands — the mint fills empty titles only' }
        return
      }
      rec.titleMintedAt = Date.now()
    }
    rec.title = title
    rec.titleSource = source
    out = { outcome: 'applied' }
  }, dir)
  return out
}

export function sessionOwnedByLiveWorker(sessionId: string, dir?: string): string | null {
  for (const rec of Object.values(readSessionWorkers(dir))) {
    if (rec.endedAt !== undefined) continue
    if (rec.sessionId !== sessionId) continue
    if (rec.attachedAt !== undefined) return rec.runnerId
    if (workerPidAlive(rec)) return rec.runnerId
  }
  return null
}

export function boardHomedSessionIds(dir?: string): Set<string> {
  const out = new Set<string>()
  for (const rec of Object.values(readSessionWorkers(dir))) {
    if (rec.endedAt === undefined && rec.parkedAt === undefined) out.add(rec.sessionId)
  }
  return out
}

export function countLiveConcourseWorkers(dir?: string): number {
  let n = 0
  for (const rec of Object.values(readSessionWorkers(dir))) {
    if (rec.endedAt === undefined && workerPidAlive(rec)) n++
  }
  return n
}
