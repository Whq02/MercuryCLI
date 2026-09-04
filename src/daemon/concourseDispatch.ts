import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { durableAtomicPublishSync } from '../substrate/durablePublish.js'
import { logForDebugging } from '../utils/debug.js'
import { daemonDir } from './controlSocket.js'
import { isProcessAlive } from './ownerWatch.js'
import { decideTransition, type ConcourseSessionState } from './concourseLifecycle.js'
import {
  canonicalWorkspaceId,
  resolveDefaultedAdmission,
  readSessionWorkers,
  recordCollisionEvidence,
  type ConcourseAdmitRequest,
  type ConcourseAdmitResult,
  type ConcourseMoveV1,
} from './concourseSupervisor.js'
import { workspaceKindOf } from './concourseWorktrees.js'
import { isolationAwarenessNote } from './isolationNote.js'

export interface ConcourseDispatchRecordV1 {
  schema: 1
  clientMessageId: string
  promptDigest: string
  envelopeDigest?: string
  state: ConcourseSessionState
  stateRevision: number
  acceptedAt: number
  workerId?: string
  sessionId?: string
  reason?: string
  deliveredAt?: number
  heldReason?: string
  heldByTitle?: string
  title?: string
  workspaceId?: string
  by?: string
  heldOp?: HeldOpEnvelopeV1
}

export interface HeldOpEnvelopeV1 {
  prompt: string
  workspaceDir: string
  isolation?: string
  modelKey?: string
  effort?: string
  title?: string
  agentName?: string
  seatsMax?: 1 | 2
  resumeSessionId?: string
  by?: string
  permissionMode?: string
  runnerArgv?: string[]
  kitPreset?: string
}

interface DispatchFileV1 {
  version: 1
  dispatches: Record<string, ConcourseDispatchRecordV1>
}

export function concourseDispatchesPath(dir: string = daemonDir()): string {
  return join(dir, 'concourse-dispatches.json')
}

export type ConcourseHoldReason =
  | 'seat'
  | 'repo-held'
  | 'session-paused'
  | 'session-with-you'
  | 'no-repository'
  | 'git-unavailable'
  | 'unborn-head'

export function normalizeHoldReason(raw: string | undefined): ConcourseHoldReason | undefined {
  if (raw === undefined) return undefined
  if (raw === 'runtime-ceiling' || raw === 'seat') return 'seat'
  if (raw === 'workspace-collision' || raw === 'repo-held') return 'repo-held'
  if (
    raw === 'session-paused' ||
    raw === 'session-with-you' ||
    raw === 'no-repository' ||
    raw === 'git-unavailable' ||
    raw === 'unborn-head'
  )
    return raw
  return 'seat'
}

interface LedgerMemo {
  stamp: string
  map: Record<string, ConcourseDispatchRecordV1>
}
const ledgerMemo = new Map<string, LedgerMemo>()

function ledgerStamp(path: string): string | null {
  try {
    const st = statSync(path)
    return `${st.ino}:${st.mtimeMs}:${st.size}`
  } catch {
    return null
  }
}

export function readConcourseDispatches(dir?: string): Record<string, ConcourseDispatchRecordV1> {
  const path = concourseDispatchesPath(dir)
  const stamp = ledgerStamp(path)
  if (stamp === null) {
    ledgerMemo.delete(path)
    return {}
  }
  const memo = ledgerMemo.get(path)
  if (memo !== undefined && memo.stamp === stamp) return memo.map
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as DispatchFileV1
    if (!raw || raw.version !== 1 || typeof raw.dispatches !== 'object') {
      ledgerMemo.delete(path)
      return {}
    }
    for (const rec of Object.values(raw.dispatches)) {
      const n = normalizeHoldReason(rec.heldReason)
      if (n !== undefined && rec.heldReason !== n) rec.heldReason = n
    }
    ledgerMemo.set(path, { stamp, map: raw.dispatches })
    return raw.dispatches
  } catch {
    ledgerMemo.delete(path)
    return {}
  }
}

interface DeferredPublish {
  map: Record<string, ConcourseDispatchRecordV1>
  done: Promise<void>
}
const deferredPublish = new Map<string, DeferredPublish>()

function publishDispatchesAfterReply(dispatches: Record<string, ConcourseDispatchRecordV1>, dir?: string): void {
  const path = concourseDispatchesPath(dir)
  const pending = deferredPublish.get(path)
  if (pending !== undefined && pending.map === dispatches) return
  const entry: DeferredPublish = { map: dispatches, done: Promise.resolve() }
  entry.done = new Promise<void>(resolve => {
    setImmediate(() => {
      if (deferredPublish.get(path) === entry) {
        deferredPublish.delete(path)
        try {
          publishDispatches(dispatches, dir)
        } catch (err) {
          logForDebugging(`[concourse/dispatch] deferred ledger publish failed for ${path}: ${err}`)
        }
      }
      resolve()
    })
  })
  deferredPublish.set(path, entry)
}

export async function flushDeferredDispatchPublishes(): Promise<void> {
  await Promise.all([...deferredPublish.values()].map(e => e.done))
}

function publishDispatches(dispatches: Record<string, ConcourseDispatchRecordV1>, dir?: string): void {
  const settled = Object.values(dispatches)
    .filter(r => (r.state === 'failed' || r.state === 'working') && r.heldReason === undefined)
    .sort((a, b) => b.acceptedAt - a.acceptedAt)
  for (const stale of settled.slice(200)) delete dispatches[stale.clientMessageId]
  const path = concourseDispatchesPath(dir)
  try {
    durableAtomicPublishSync(
      path,
      `${JSON.stringify({ version: 1, dispatches } satisfies DispatchFileV1, null, 1)}\n`,
    )
  } catch (err) {
    ledgerMemo.delete(path)
    throw err
  }
  const stamp = ledgerStamp(path)
  if (stamp !== null) ledgerMemo.set(path, { stamp, map: dispatches })
  else ledgerMemo.delete(path)
  const pending = deferredPublish.get(path)
  if (pending !== undefined && pending.map === dispatches) deferredPublish.delete(path)
}

export function withdrawConcourseDispatch(clientMessageId: string, dir?: string): boolean {
  const dispatches = readConcourseDispatches(dir)
  const rec = dispatches[clientMessageId]
  if (!rec || rec.sessionId !== undefined) return false
  if (rec.state !== 'queued' && rec.heldReason === undefined) return false
  rec.state = 'failed'
  delete rec.heldReason
  delete rec.heldOp
  rec.reason = 'withdrawn by the operator (x on the queued row)'
  publishDispatches(dispatches, dir)
  return true
}

export function failWorkingDispatchesForRunner(runnerId: string, reason: string, dir?: string): number {
  const dispatches = readConcourseDispatches(dir)
  let moved = 0
  for (const rec of Object.values(dispatches)) {
    if (rec.state !== 'working' || rec.workerId !== runnerId) continue
    advance(rec, 'failed', { reason })
    if (settledFailed(rec)) moved++
  }
  if (moved > 0) publishDispatches(dispatches, dir)
  return moved
}

function settledFailed(rec: ConcourseDispatchRecordV1): boolean {
  return rec.state === 'failed'
}

export function reconcileWorkingDispatches(
  dir?: string,
  workersRead: (d?: string) => Record<string, { endedAt?: number }> = readSessionWorkers,
): number {
  const dispatches = readConcourseDispatches(dir)
  const workers = workersRead(dir)
  let moved = 0
  for (const rec of Object.values(dispatches)) {
    if (rec.state !== 'working' || rec.workerId === undefined) continue
    const worker = workers[rec.workerId]
    if (worker === undefined || worker.endedAt === undefined) continue
    advance(rec, 'failed', { reason: 'the worker ended without settling its dispatch — settled at boot reconcile' })
    if (settledFailed(rec)) moved++
  }
  if (moved > 0) publishDispatches(dispatches, dir)
  return moved
}

export function promptDigestOf(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex')
}


export interface ConcourseControlOpRecordV1 {
  clientOpId: string
  action: string
  sessionId: string
  outcome: 'applied' | 'noop' | 'refused'
  detail?: string
  atMs: number
}

export function concourseControlOpsPath(dir: string = daemonDir()): string {
  return join(dir, 'concourse-control-ops.json')
}

export function readConcourseControlOps(dir?: string): Record<string, ConcourseControlOpRecordV1> {
  try {
    const raw = JSON.parse(readFileSync(concourseControlOpsPath(dir), 'utf8')) as {
      version: 1
      ops: Record<string, ConcourseControlOpRecordV1>
    }
    if (!raw || raw.version !== 1 || typeof raw.ops !== 'object') return {}
    return raw.ops
  } catch {
    return {}
  }
}

export function recordConcourseControlOp(rec: ConcourseControlOpRecordV1, dir?: string): void {
  const ops = readConcourseControlOps(dir)
  ops[rec.clientOpId] = rec
  const stale = Object.values(ops).sort((a, b) => b.atMs - a.atMs).slice(200)
  for (const s of stale) delete ops[s.clientOpId]
  durableAtomicPublishSync(concourseControlOpsPath(dir), `${JSON.stringify({ version: 1, ops }, null, 1)}\n`)
}

export function envelopeDigestOf(req: ConcourseDispatchRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        prompt: req.prompt,
        workspaceDir: canonicalWorkspaceId(req.workspaceDir),
        targetSessionId: req.targetSessionId ?? null,
        isolation: req.isolation ?? null,
        modelKey: req.modelKey ?? null,
        effort: req.effort ?? null,
        title: req.title ?? null,
        agentName: req.agentName ?? null,
        seatsMax: req.seatsMax ?? null,
        resumeSessionId: req.resumeSessionId ?? null,
        mode: req.mode ?? null,
        agentId: req.agentId ?? null,
        priority: req.priority ?? null,
        content: req.content ?? null,
        permissionMode: req.permissionMode ?? null,
        runnerArgv: req.runnerArgv ?? null,
      }),
      'utf8',
    )
    .digest('hex')
}

export function buildConcoursePromptFrame(prompt: string, extras?: ConcoursePromptExtras, groundNote?: string): string {
  const note = groundNote !== undefined && groundNote.length > 0 && extras?.mode !== 'bash' ? groundNote : undefined
  const content =
    extras?.content !== undefined
      ? note !== undefined
        ? [{ type: 'text', text: note }, ...extras.content]
        : extras.content
      : note !== undefined
        ? `${note}\n\n${prompt}`
        : prompt
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
    uuid:
      extras?.identity !== undefined && UUID_SHAPE.test(extras.identity)
        ? extras.identity
        : randomUUID(),
    ...(extras?.priority !== undefined ? { priority: extras.priority } : {}),
    ...(extras?.mode === 'bash' ? { mode: 'bash' } : {}),
    ...(extras?.mode === 'task-notification' && extras.agentId !== undefined
      ? { mode: 'task-notification', agentId: extras.agentId }
      : {}),
  })
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ConcoursePromptExtras {
  mode?: 'prompt' | 'bash' | 'task-notification'
  agentId?: string
  priority?: 'now' | 'next' | 'later'
  content?: unknown[]
  identity?: string
}

function promptExtrasOf(req: Pick<ConcourseDispatchRequest, 'mode' | 'priority' | 'content' | 'agentId'>): ConcoursePromptExtras | undefined {
  if (req.mode === undefined && req.priority === undefined && req.content === undefined) return undefined
  return {
    ...(req.mode !== undefined ? { mode: req.mode } : {}),
    ...(req.agentId !== undefined ? { agentId: req.agentId } : {}),
    ...(req.priority !== undefined ? { priority: req.priority } : {}),
    ...(req.content !== undefined ? { content: req.content } : {}),
  }
}

function emitStarted(rec: ConcourseDispatchRecordV1, runnerId: string, sessionId: string): void {
  void import('../services/notificationPolicy.js')
    .then(policy =>
      policy.journalConcourseSignal({
        kind: 'started',
        targetId: runnerId,
        revision: rec.stateRevision,
        title: 'session started',
        detail: `worker ${runnerId} took the prompt`,
        deepLink: { sessionId },
        obligationBacked: false,
      }),
    )
    .catch(err => {
      logForDebugging(`[concourse/dispatch] started-signal journal failed for ${rec.clientMessageId}: ${err}`)
    })
}

function advance(
  rec: ConcourseDispatchRecordV1,
  to: ConcourseSessionState,
  patch?: Partial<ConcourseDispatchRecordV1>,
): void {
  const d = decideTransition(rec.state, to)
  if (d.legal !== true) {
    if (d.reason !== 'idempotent-noop') {
      logForDebugging(`[concourse/dispatch] refused ${rec.state}→${to} (${d.reason}) for ${rec.clientMessageId}`)
    }
    return
  }
  rec.state = to
  rec.stateRevision += 1
  Object.assign(rec, patch)
}


export interface ConcoursePreflightRefusal {
  code: 'invalid-workspace' | 'invalid-model' | 'invalid-effort' | 'no-repository' | 'runtime-ceiling' | 'workspace-collision'
  reason: string
  moves?: ConcourseMoveV1[]
}

export type ConcoursePreflightResult = { ok: true } | { ok: false; refusals: ConcoursePreflightRefusal[] }

export async function preflightConcourseDispatch(
  req: ConcourseAdmitRequest,
  dir?: string,
): Promise<ConcoursePreflightResult> {
  const refusals: ConcoursePreflightRefusal[] = []
  let workspaceOk = false
  try {
    workspaceOk = statSync(req.workspaceDir).isDirectory()
  } catch {
  }
  if (!workspaceOk) {
    refusals.push({ code: 'invalid-workspace', reason: `project folder not found: ${req.workspaceDir} — pick an existing folder` })
  }
  ;(await import('./signInView.js')).refreshSignInReads(true)
  const modelValidated = await (await import('../services/concourse/workerModels.js')).validateWorkerModelChoice(req.modelKey, 'session')
  if (req.effort !== undefined) {
    const { normalizeEffortLevelString, EFFORT_LEVELS } = await import('../utils/effort.js')
    if (normalizeEffortLevelString(req.effort) === undefined) {
      refusals.push({ code: 'invalid-effort', reason: `effort '${req.effort}' is not on the ladder — the levels are ${EFFORT_LEVELS.join(' | ')}` })
    }
  }
  if (!modelValidated.ok) {
    refusals.push({
      code: 'invalid-model',
      reason: `model unavailable (${modelValidated.reason})${modelValidated.detail !== undefined ? ` — ${modelValidated.detail}` : ''}${modelValidated.action !== undefined ? ` · ${modelValidated.action}` : ''}`,
    })
  }
  if (workspaceOk) {
    const workspaceId = canonicalWorkspaceId(req.workspaceDir)
    if ((req.isolation ?? 'exclusive') === 'worktree-isolated' && workspaceKindOf(workspaceId) === 'plain-folder') {
      refusals.push({
        code: 'no-repository',
        reason: 'forking needs a git repository — this folder has none yet',
        moves: [{ verb: 'init-git', label: 'say yes to the git offer — then sessions can fork here' }],
      })
    }
    const live = Object.values(readSessionWorkers(dir)).filter(
      r =>
        r.endedAt === undefined &&
        ((r.pid !== undefined && isProcessAlive(r.pid)) || r.attachedAt !== undefined),
    )
    const resolution = resolveDefaultedAdmission(
      live.map(r => ({ workspaceId: r.workspaceId, isolation: r.isolation })),
      { workspaceId, ...(req.isolation !== undefined ? { isolation: req.isolation } : {}) },
    )
    if (resolution.kind === 'git-offer') {
      refusals.push({ code: resolution.code, reason: resolution.error, moves: resolution.moves })
    } else if (!resolution.decision.admit) {
      refusals.push({
        code: resolution.decision.code,
        reason: resolution.decision.reason,
        ...(resolution.decision.moves !== undefined ? { moves: resolution.decision.moves } : {}),
      })
    }
  }
  return refusals.length === 0 ? { ok: true } : { ok: false, refusals }
}

export interface ConcourseDispatchRequest extends ConcourseAdmitRequest {
  clientMessageId: string
  prompt: string
  by?: string
  targetSessionId?: string
  mode?: 'prompt' | 'bash' | 'task-notification'
  agentId?: string
  priority?: 'now' | 'next' | 'later'
  content?: unknown[]
}

export type ConcourseDispatchResult = {
  ok: boolean
  clientMessageId: string
  state: ConcourseSessionState
  stateRevision: number
  runnerId?: string
  sessionId?: string
  error?: string
  replay?: 'replayed' | 'edited-replay'
  heldReason?: string
  heldByTitle?: string
  moves?: ConcourseMoveV1[]
  branchName?: string
  mainHolderTitle?: string
  modelId?: string
  modelDisplayName?: string
  effort?: string
  kitSource?: 'carried' | 'derived' | 'preset'
  presetName?: string
  presetNote?: string
}

export interface ConcourseDispatchDeps {
  admit: (req: ConcourseAdmitRequest) => Promise<ConcourseAdmitResult>
  deliver: (runnerId: string, prompt: string) => Promise<boolean>
  revive?: (sessionId: string) => Promise<{ ok: boolean; error?: string }>
  dir?: string
}

export interface ConcourseDispatchHandler {
  (req: ConcourseDispatchRequest): Promise<ConcourseDispatchResult>
  withdraw(clientMessageId: string): Promise<boolean>
}

export function makeConcourseDispatchHandler(
  deps: ConcourseDispatchDeps,
): ConcourseDispatchHandler {
  const attemptRedirectDelivery = async (
    rec: ConcourseDispatchRecordV1,
    dispatches: Record<string, ConcourseDispatchRecordV1>,
    target: string,
    prompt: string,
    extras?: ConcoursePromptExtras,
  ): Promise<ConcourseDispatchResult> => {
    const workers = readSessionWorkers(deps.dir)
    let targetRec = Object.values(workers).find(w => w.sessionId === target && w.endedAt === undefined)
    if (targetRec && (targetRec.attachedAt !== undefined || targetRec.attachRequestedAt !== undefined)) {
      rec.heldReason = 'session-with-you'
      rec.sessionId = target
      rec.workerId = targetRec.runnerId
      publishDispatches(dispatches, deps.dir)
      return {
        ok: false,
        clientMessageId: rec.clientMessageId,
        state: rec.state,
        stateRevision: rec.stateRevision,
        runnerId: targetRec.runnerId,
        sessionId: target,
        heldReason: 'session-with-you',
        error:
          'this session is with you in the terminal — say it there, or leave it and this message delivers on its own',
        moves: [{ verb: 'queue', label: 'it delivers on its own after you leave the session' }],
      }
    }
    if (targetRec && targetRec.pausedAt !== undefined) {
      rec.heldReason = 'session-paused'
      rec.sessionId = target
      rec.workerId = targetRec.runnerId
      publishDispatches(dispatches, deps.dir)
      return {
        ok: false,
        clientMessageId: rec.clientMessageId,
        state: rec.state,
        stateRevision: rec.stateRevision,
        runnerId: targetRec.runnerId,
        sessionId: target,
        heldReason: 'session-paused',
        error: `paused by ${targetRec.pausedBy ?? 'operator'} — resume the session and this message delivers on its own`,
        moves: [{ verb: 'retry', label: 'resume the session — the message delivers on its own' }],
      }
    }
    if (
      targetRec &&
      (targetRec.pid === undefined || !isProcessAlive(targetRec.pid)) &&
      targetRec.stoppedAt === undefined &&
      targetRec.attachedAt === undefined &&
      deps.revive !== undefined
    ) {
      const rev = await deps.revive(target)
      if (rev.ok) {
        const refreshed = Object.values(readSessionWorkers(deps.dir)).find(
          w => w.sessionId === target && w.endedAt === undefined,
        )
        if (refreshed) targetRec = refreshed
      }
    }
    if (!targetRec || targetRec.pid === undefined || !isProcessAlive(targetRec.pid)) {
      const stopped = targetRec?.stoppedAt !== undefined
      const why = stopped
        ? 'stopped — the session was stopped on purpose; resume it to bring it back'
        : 'the session has no live runner — a replay revives it and delivers into the same chat'
      delete rec.heldReason
      delete rec.heldOp
      advance(rec, 'failed', { reason: why })
      publishDispatches(dispatches, deps.dir)
      return {
        ok: false,
        clientMessageId: rec.clientMessageId,
        state: rec.state,
        stateRevision: rec.stateRevision,
        error: why,
        moves: [
          stopped
            ? { verb: 'revive', label: 'resume the session — it comes back around its untouched chat' }
            : { verb: 'revive', label: '↵ replays — it revives the runner and delivers' },
        ],
      }
    }
    delete rec.heldReason
    delete rec.heldOp
    advance(rec, 'starting', { workerId: targetRec.runnerId, sessionId: target })
    if (rec.state !== 'starting') {
      publishDispatches(dispatches, deps.dir)
      return {
        ok: false,
        clientMessageId: rec.clientMessageId,
        state: rec.state,
        stateRevision: rec.stateRevision,
        error: `replay refused: the message already settled '${rec.state}' — a terminal row never re-delivers`,
      }
    }
    publishDispatches(dispatches, deps.dir)
    const delivered = await deps.deliver(
      targetRec.runnerId,
      buildConcoursePromptFrame(prompt, { ...extras, identity: rec.clientMessageId }),
    )
    if (delivered) {
      advance(rec, 'working', { deliveredAt: Date.now() })
      emitStarted(rec, targetRec.runnerId, target)
    } else {
      advance(rec, 'failed', { reason: 'instruction delivery failed (stdin unavailable)' })
    }
    publishDispatchesAfterReply(dispatches, deps.dir)
    return {
      ok: delivered,
      clientMessageId: rec.clientMessageId,
      state: rec.state,
      stateRevision: rec.stateRevision,
      runnerId: targetRec.runnerId,
      sessionId: target,
      ...(delivered ? {} : { error: 'instruction delivery failed (stdin unavailable)' }),
    }
  }

  let tail: Promise<unknown> = Promise.resolve()
  const run = async (req: ConcourseDispatchRequest): Promise<ConcourseDispatchResult> => {
    const digest = promptDigestOf(req.prompt)
    const envDigest = envelopeDigestOf(req)
    const dispatches = readConcourseDispatches(deps.dir)
    const existing = dispatches[req.clientMessageId]
    if (existing) {
      const edited =
        existing.envelopeDigest !== undefined
          ? existing.envelopeDigest !== envDigest
          : existing.promptDigest !== digest
      if (edited) {
        return {
          ok: false,
          clientMessageId: req.clientMessageId,
          state: existing.state,
          stateRevision: existing.stateRevision,
          replay: 'edited-replay',
          error: 'same clientMessageId with different content — a material edit needs a NEW message identity (the draft is preserved)',
        }
      }
      if (existing.heldReason !== undefined && existing.sessionId !== undefined) {
        return attemptRedirectDelivery(existing, dispatches, existing.sessionId, req.prompt, promptExtrasOf(req))
      }
      if (existing.heldReason === undefined || existing.sessionId !== undefined) return {
        ok: existing.state !== 'failed',
        clientMessageId: req.clientMessageId,
        state: existing.state,
        stateRevision: existing.stateRevision,
        ...(existing.workerId !== undefined ? { runnerId: existing.workerId } : {}),
        ...(existing.sessionId !== undefined ? { sessionId: existing.sessionId } : {}),
        ...(existing.reason !== undefined ? { error: existing.reason } : {}),
        replay: 'replayed',
      }
    }

    const held = existing !== undefined && existing.heldReason !== undefined && existing.sessionId === undefined
    const rec: ConcourseDispatchRecordV1 = held
      ? existing
      : {
          schema: 1,
          clientMessageId: req.clientMessageId,
          promptDigest: digest,
          envelopeDigest: envDigest,
          state: 'queued',
          stateRevision: 1,
          acceptedAt: Date.now(),
        }
    delete rec.heldReason
    delete rec.heldOp
    if (req.title !== undefined && req.title.length > 0) rec.title = req.title.slice(0, 120)
    rec.workspaceId = canonicalWorkspaceId(req.workspaceDir)
    if (req.by !== undefined && req.by.length > 0) rec.by = req.by.slice(0, 64)
    dispatches[req.clientMessageId] = rec
    publishDispatches(dispatches, deps.dir)

    if (req.targetSessionId !== undefined) {
      return attemptRedirectDelivery(rec, dispatches, req.targetSessionId, req.prompt, promptExtrasOf(req))
    }

    const { clientMessageId: _id, prompt, targetSessionId: _target, ...admitReq } = req
    const admitted = await deps.admit(admitReq)
    if (!admitted.ok) {
      const retryable =
        admitted.code === 'runtime-ceiling' ||
        admitted.code === 'workspace-collision' ||
        admitted.code === 'no-repository' ||
        admitted.code === 'git-unavailable' ||
        admitted.code === 'unborn-head'
      if (retryable) {
        rec.heldReason = normalizeHoldReason(admitted.code) ?? 'seat'
        if (rec.heldReason === 'repo-held') {
          const holder = Object.values(readSessionWorkers(deps.dir)).find(
            w =>
              w.endedAt === undefined &&
              w.workspaceId === rec.workspaceId &&
              ['exclusive', 'shared'].includes(w.isolation ?? 'exclusive'),
          )
          if (holder?.title !== undefined) rec.heldByTitle = holder.title.slice(0, 60)
          else delete rec.heldByTitle
        }
        rec.reason = admitted.error
        rec.heldOp = {
          prompt: req.prompt,
          workspaceDir: req.workspaceDir,
          ...(req.isolation !== undefined ? { isolation: req.isolation } : {}),
          ...(req.modelKey !== undefined ? { modelKey: req.modelKey } : {}),
          ...(req.effort !== undefined ? { effort: req.effort } : {}),
          ...(req.title !== undefined ? { title: req.title } : {}),
          ...(req.agentName !== undefined ? { agentName: req.agentName } : {}),
          ...(req.seatsMax !== undefined ? { seatsMax: req.seatsMax } : {}),
          ...(req.resumeSessionId !== undefined ? { resumeSessionId: req.resumeSessionId } : {}),
          ...(req.by !== undefined ? { by: req.by } : {}),
          ...(req.permissionMode !== undefined ? { permissionMode: req.permissionMode } : {}),
          ...(req.runnerArgv !== undefined ? { runnerArgv: [...req.runnerArgv] } : {}),
          ...(req.kitPreset !== undefined ? { kitPreset: req.kitPreset } : {}),
        }
        publishDispatches(dispatches, deps.dir)
        if ((rec.heldReason === 'no-repository' || rec.heldReason === 'unborn-head') && rec.workspaceId !== undefined) {
          const folder = rec.workspaceId
          void import('./permissionAsks.js')
            .then(p => p.mintGitInitAsk(folder))
            .catch(err => logForDebugging(`[concourse/dispatch] git-init ask mint failed: ${err}`))
        }
        return {
          ok: false,
          clientMessageId: rec.clientMessageId,
          state: rec.state,
          stateRevision: rec.stateRevision,
          error: admitted.error,
          heldReason: rec.heldReason,
          ...(rec.heldByTitle !== undefined ? { heldByTitle: rec.heldByTitle } : {}),
          ...(admitted.moves !== undefined ? { moves: admitted.moves } : {}),
        }
      }
      advance(rec, 'failed', { reason: admitted.error })
      publishDispatches(dispatches, deps.dir)
      if (admitted.code === 'workspace-collision') {
        try {
          const wsId = canonicalWorkspaceId(req.workspaceDir)
          const holders = Object.values(readSessionWorkers(deps.dir))
            .filter(r => r.endedAt === undefined && r.workspaceId === wsId)
            .map(r => ({ workerId: r.runnerId, sessionId: r.sessionId, isolation: r.isolation }))
          recordCollisionEvidence(
            {
              schema: 1,
              kind: 'exclusive-overlap',
              workspaceId: wsId,
              holders,
              observedAt: Date.now(),
              refusedClientMessageId: req.clientMessageId,
              detail: admitted.error,
            },
            deps.dir,
          )
        } catch (err) {
          logForDebugging(`[concourse/dispatch] collision-evidence record failed for ${req.clientMessageId}: ${err}`)
        }
      }
      void import('../services/concourse/coordinatorKernel.js')
        .then(k =>
          k.runCoordinatorKernel({
            kind: 'dispatch-refused',
            clientMessageId: req.clientMessageId,
            reason: admitted.error,
            workspaceDir: req.workspaceDir,
            promptPreview: prompt,
            ...(req.by !== undefined ? { by: req.by } : {}),
          }),
        )
        .catch(err => {
          logForDebugging(`[concourse/dispatch] R1 kernel ride failed for ${req.clientMessageId}: ${err}`)
        })
      return {
        ok: false,
        clientMessageId: req.clientMessageId,
        state: rec.state,
        stateRevision: rec.stateRevision,
        error: admitted.error,
        ...(admitted.moves !== undefined ? { moves: admitted.moves } : {}),
      }
    }
    advance(rec, 'starting', { workerId: admitted.runnerId, sessionId: admitted.sessionId })
    for (const other of Object.values(dispatches)) {
      if (other === rec) continue
      if (other.heldReason === undefined || other.sessionId !== undefined) continue
      if (other.promptDigest !== rec.promptDigest || other.workspaceId !== rec.workspaceId) continue
      delete other.heldReason
      delete other.heldOp
      advance(other, 'failed', { reason: `superseded — the same instruction admitted as ${rec.clientMessageId}` })
    }
    publishDispatches(dispatches, deps.dir)

    const admittedRec = readSessionWorkers(deps.dir)[admitted.runnerId]
    const groundNote =
      admittedRec !== undefined
        ? isolationAwarenessNote({
            isolation: admittedRec.isolation ?? 'exclusive',
            workspaceId: admittedRec.workspaceId,
            ...(admittedRec.branchName !== undefined ? { branchName: admittedRec.branchName } : {}),
          })
        : undefined
    const delivered = await deps.deliver(
      admitted.runnerId,
      buildConcoursePromptFrame(prompt, { ...promptExtrasOf(req), identity: req.clientMessageId }, groundNote),
    )
    if (delivered) {
      advance(rec, 'working', { deliveredAt: Date.now() })
      emitStarted(rec, admitted.runnerId, admitted.sessionId)
    } else {
      advance(rec, 'failed', { reason: 'worker start delivery failed (stdin unavailable)' })
    }
    publishDispatchesAfterReply(dispatches, deps.dir)
    return {
      ok: delivered,
      clientMessageId: req.clientMessageId,
      state: rec.state,
      stateRevision: rec.stateRevision,
      runnerId: admitted.runnerId,
      sessionId: admitted.sessionId,
      ...(admitted.branchName !== undefined ? { branchName: admitted.branchName } : {}),
      ...(admitted.mainHolderTitle !== undefined ? { mainHolderTitle: admitted.mainHolderTitle } : {}),
      ...(admitted.modelId !== undefined ? { modelId: admitted.modelId } : {}),
      ...(admitted.modelDisplayName !== undefined ? { modelDisplayName: admitted.modelDisplayName } : {}),
      ...(admitted.effort !== undefined ? { effort: admitted.effort } : {}),
      ...(admitted.kitSource !== undefined ? { kitSource: admitted.kitSource } : {}),
      ...(admitted.presetName !== undefined ? { presetName: admitted.presetName } : {}),
      ...(admitted.presetNote !== undefined ? { presetNote: admitted.presetNote } : {}),
      ...(delivered ? {} : { error: 'worker start delivery failed (stdin unavailable)' }),
    }
  }
  const handler = ((req: ConcourseDispatchRequest) => {
    const next = tail.then(
      () => run(req),
      () => run(req),
    )
    tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }) as ConcourseDispatchHandler
  handler.withdraw = clientMessageId => {
    const next = tail.then(
      () => withdrawConcourseDispatch(clientMessageId, deps.dir),
      () => withdrawConcourseDispatch(clientMessageId, deps.dir),
    )
    tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
  return handler
}

export function heldGitLaunchesFor(
  folder: string,
  dir?: string,
): ReadonlyArray<{ clientMessageId: string; title?: string }> {
  const canonical = canonicalWorkspaceId(folder)
  return Object.values(readConcourseDispatches(dir))
    .filter(r => {
      const hold = normalizeHoldReason(r.heldReason)
      return (
        r.sessionId === undefined &&
        r.heldOp !== undefined &&
        r.workspaceId === canonical &&
        (hold === 'no-repository' || hold === 'unborn-head' || hold === 'git-unavailable')
      )
    })
    .sort((a, b) => a.acceptedAt - b.acceptedAt)
    .map(r => ({ clientMessageId: r.clientMessageId, ...(r.title !== undefined ? { title: r.title } : {}) }))
}

export async function replayGitBlockedDispatches(
  folder: string,
  dispatch: (req: ConcourseDispatchRequest) => Promise<ConcourseDispatchResult>,
  dir?: string,
): Promise<ReadonlyArray<{ clientMessageId: string; title?: string; ok: boolean; sessionId?: string; branchName?: string; error?: string }>> {
  const canonical = canonicalWorkspaceId(folder)
  const dispatches = readConcourseDispatches(dir)
  const held = Object.values(dispatches)
    .filter(r => {
      const hold = normalizeHoldReason(r.heldReason)
      return (
        r.sessionId === undefined &&
        r.heldOp !== undefined &&
        r.workspaceId === canonical &&
        (hold === 'no-repository' || hold === 'unborn-head' || hold === 'git-unavailable')
      )
    })
    .sort((a, b) => a.acceptedAt - b.acceptedAt)
  const out: Array<{ clientMessageId: string; title?: string; ok: boolean; sessionId?: string; branchName?: string; error?: string }> = []
  for (const rec of held) {
    if (rec.heldOp === undefined) continue
    out.push(await replayHeldRecord(rec, dispatch))
  }
  return out
}

async function replayHeldRecord(
  rec: ConcourseDispatchRecordV1,
  dispatch: (req: ConcourseDispatchRequest) => Promise<ConcourseDispatchResult>,
): Promise<{ clientMessageId: string; title?: string; ok: boolean; sessionId?: string; branchName?: string; error?: string }> {
  const op = rec.heldOp!
  try {
    const res = await dispatch({
      clientMessageId: rec.clientMessageId,
      prompt: op.prompt,
      workspaceDir: op.workspaceDir,
      ...(op.isolation !== undefined ? { isolation: op.isolation as ConcourseAdmitRequest['isolation'] } : {}),
      ...(op.modelKey !== undefined ? { modelKey: op.modelKey } : {}),
      ...(op.effort !== undefined ? { effort: op.effort } : {}),
      ...(op.title !== undefined ? { title: op.title } : {}),
      ...(op.agentName !== undefined ? { agentName: op.agentName } : {}),
      ...(op.seatsMax !== undefined ? { seatsMax: op.seatsMax } : {}),
      ...(op.resumeSessionId !== undefined ? { resumeSessionId: op.resumeSessionId } : {}),
      ...(op.by !== undefined ? { by: op.by } : {}),
      ...(op.permissionMode !== undefined ? { permissionMode: op.permissionMode as ConcourseAdmitRequest['permissionMode'] } : {}),
      ...(op.runnerArgv !== undefined ? { runnerArgv: op.runnerArgv } : {}),
      ...(op.kitPreset !== undefined ? { kitPreset: op.kitPreset } : {}),
    })
    return {
      clientMessageId: rec.clientMessageId,
      ...(rec.title !== undefined ? { title: rec.title } : {}),
      ok: res.ok,
      ...(res.sessionId !== undefined ? { sessionId: res.sessionId } : {}),
      ...(res.branchName !== undefined ? { branchName: res.branchName } : {}),
      ...(res.error !== undefined ? { error: res.error } : {}),
    }
  } catch (err) {
    logForDebugging(`[concourse/dispatch] held replay failed for ${rec.clientMessageId}: ${err}`)
    return {
      clientMessageId: rec.clientMessageId,
      ...(rec.title !== undefined ? { title: rec.title } : {}),
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export function folderClaimHeld(folder: string, dir?: string): boolean {
  const canonical = canonicalWorkspaceId(folder)
  return Object.values(readSessionWorkers(dir)).some(
    r =>
      r.endedAt === undefined &&
      r.parkedAt === undefined &&
      r.workspaceId === canonical &&
      ((r.pid !== undefined && isProcessAlive(r.pid)) || r.attachedAt !== undefined),
  )
}

export function denyProceedLaunchesFor(
  folder: string,
  dir?: string,
): ReadonlyArray<{ clientMessageId: string; title?: string }> {
  if (folderClaimHeld(folder, dir)) return []
  const canonical = canonicalWorkspaceId(folder)
  return Object.values(readConcourseDispatches(dir))
    .filter(r => {
      const hold = normalizeHoldReason(r.heldReason)
      return (
        r.sessionId === undefined &&
        r.heldOp !== undefined &&
        r.heldOp.isolation === undefined &&
        r.workspaceId === canonical &&
        (hold === 'no-repository' || hold === 'unborn-head' || hold === 'git-unavailable')
      )
    })
    .sort((a, b) => a.acceptedAt - b.acceptedAt)
    .slice(0, 1)
    .map(r => ({ clientMessageId: r.clientMessageId, ...(r.title !== undefined ? { title: r.title } : {}) }))
}

export async function replayDenyProceedDispatches(
  folder: string,
  dispatch: (req: ConcourseDispatchRequest) => Promise<ConcourseDispatchResult>,
  dir?: string,
): Promise<ReadonlyArray<{ clientMessageId: string; title?: string; ok: boolean; sessionId?: string; branchName?: string; error?: string }>> {
  const rows = denyProceedLaunchesFor(folder, dir)
  const dispatches = readConcourseDispatches(dir)
  const out: Array<{ clientMessageId: string; title?: string; ok: boolean; sessionId?: string; branchName?: string; error?: string }> = []
  for (const row of rows) {
    const rec = dispatches[row.clientMessageId]
    if (rec?.heldOp === undefined) continue
    out.push(await replayHeldRecord(rec, dispatch))
  }
  return out
}
