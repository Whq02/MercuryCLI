import { randomUUID } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { durableAtomicPublish } from '../../substrate/durablePublish.js'
import { resolveWatchRoot } from '../../utils/watchRoot.js'
import { readRunClaim, readRunManifest, type RunClaim } from './runManifest.js'

export const WORKFLOW_CONTROL_DIRNAME = 'control'
export const WORKFLOW_CONTROL_VERSION = 1
export const WORKFLOW_CONTROL_ANSWER_MS = 5_000

export type WorkflowControlAction =
  | 'stop'
  | 'pause'
  | 'resume'
  | 'kill-agent'
  | 'pause-agent'
  | 'resume-agent'
  | 'skip-agent'
  | 'retry-agent'
  | 'message-agent'

export type WorkflowControlOutcome =
  | { outcome: 'applied'; detail: string }
  | { outcome: 'refused'; reason: string }

export type WorkflowControlResult =
  | WorkflowControlOutcome
  | { outcome: 'pending'; reason: string; requestId: string }

export type WorkflowControlRequest = {
  version: typeof WORKFLOW_CONTROL_VERSION
  id: string
  instanceId: string
  epoch: number
  action: WorkflowControlAction
  by: string
  at: number
  agentId?: string
  message?: string
}

export type WorkflowControlAnswer = {
  id: string
  instanceId: string
  epoch: number
  result: WorkflowControlOutcome
  at: number
}

export type WorkflowControlJournalRow =
  | { type: 'control-request'; request: WorkflowControlRequest; at: number }
  | {
      type: 'control-result'
      requestId: string
      action: WorkflowControlAction
      by: string
      agentId?: string
      result: WorkflowControlOutcome
      at: number
    }

export const WORKFLOW_CONTROL_ACTIONS: ReadonlySet<WorkflowControlAction> = new Set<WorkflowControlAction>([
  'stop',
  'pause',
  'resume',
  'kill-agent',
  'pause-agent',
  'resume-agent',
  'skip-agent',
  'retry-agent',
  'message-agent',
])

const REQUEST_ID = /^[a-f0-9-]{36}$/
const REQUEST_SUFFIX = '.request.json'
const ANSWER_SUFFIX = '.response.json'
const MAX_REQUEST_BYTES = 65_536
const MAX_BY_CHARS = 256
const MAX_AGENT_ID_CHARS = 256
const MAX_MESSAGE_CHARS = 32_768

export function workflowControlDir(runDir: string): string {
  return path.join(runDir, WORKFLOW_CONTROL_DIRNAME)
}
const requestPath = (runDir: string, id: string): string => path.join(workflowControlDir(runDir), `${id}${REQUEST_SUFFIX}`)
const answerPath = (runDir: string, id: string): string => path.join(workflowControlDir(runDir), `${id}${ANSWER_SUFFIX}`)

const sameClaim = (a: Pick<RunClaim, 'instanceId' | 'epoch'> | undefined, b: Pick<RunClaim, 'instanceId' | 'epoch'>): boolean =>
  a !== undefined && a.instanceId === b.instanceId && a.epoch === b.epoch

export function isAgentAction(action: WorkflowControlAction): boolean {
  return action.endsWith('-agent')
}

export function parseWorkflowControlRequest(raw: string, id: string): WorkflowControlRequest | null {
  if (raw.length > MAX_REQUEST_BYTES) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const r = parsed as Record<string, unknown>
  if (r.version !== WORKFLOW_CONTROL_VERSION) return null
  if (r.id !== id || !REQUEST_ID.test(id)) return null
  if (typeof r.action !== 'string' || !WORKFLOW_CONTROL_ACTIONS.has(r.action as WorkflowControlAction)) return null
  if (typeof r.instanceId !== 'string' || r.instanceId === '') return null
  if (typeof r.epoch !== 'number' || !Number.isSafeInteger(r.epoch)) return null
  if (typeof r.by !== 'string' || r.by === '' || r.by.length > MAX_BY_CHARS) return null
  if (typeof r.at !== 'number' || !Number.isFinite(r.at)) return null
  const action = r.action as WorkflowControlAction
  if (isAgentAction(action)) {
    if (typeof r.agentId !== 'string' || r.agentId === '' || r.agentId.length > MAX_AGENT_ID_CHARS) return null
  } else if (r.agentId !== undefined) return null
  if (action === 'message-agent') {
    if (typeof r.message !== 'string' || r.message === '' || r.message.length > MAX_MESSAGE_CHARS) return null
  } else if (r.message !== undefined) return null
  return {
    version: WORKFLOW_CONTROL_VERSION,
    id,
    instanceId: r.instanceId,
    epoch: r.epoch,
    action,
    by: r.by,
    at: r.at,
    ...(typeof r.agentId === 'string' ? { agentId: r.agentId } : {}),
    ...(typeof r.message === 'string' ? { message: r.message } : {}),
  }
}

function parseAnswer(raw: string): WorkflowControlAnswer | null {
  try {
    const a = JSON.parse(raw) as WorkflowControlAnswer
    if (typeof a !== 'object' || a === null || typeof a.id !== 'string' || typeof a.instanceId !== 'string' || typeof a.epoch !== 'number') return null
    const result = a.result as { outcome?: unknown } | undefined
    if (result?.outcome !== 'applied' && result?.outcome !== 'refused') return null
    return a
  } catch {
    return null
  }
}

export async function readWorkflowControlAnswer(runDir: string, id: string): Promise<WorkflowControlAnswer | null> {
  try {
    return parseAnswer(await readFile(answerPath(runDir, id), 'utf8'))
  } catch {
    return null
  }
}

export type WorkflowControlInput = {
  action: WorkflowControlAction
  by: string
  agentId?: string
  message?: string
}

export async function requestWorkflowControl(
  runDir: string,
  input: WorkflowControlInput,
  opts?: { answerMs?: number },
): Promise<WorkflowControlResult> {
  const manifest = await readRunManifest(runDir)
  if (manifest === undefined) return { outcome: 'refused', reason: 'no run record — nothing to control' }
  if (manifest.status !== 'running') return { outcome: 'refused', reason: `already ${manifest.status === 'paused' ? 'paused on disk' : 'settled'} — nothing to ${verbOf(input.action)}` }
  if (manifest.controlVersion !== WORKFLOW_CONTROL_VERSION) {
    return { outcome: 'refused', reason: 'this run predates the persistent control channel — only its launching process can act on it' }
  }
  const claim = await readRunClaim(runDir)
  if (claim === undefined || !sameClaim(claim, manifest.owner ?? { instanceId: '', epoch: -1 })) {
    return { outcome: 'refused', reason: 'the run changed hands — reopen the view before acting' }
  }
  const id = randomUUID()
  const request: WorkflowControlRequest = {
    version: WORKFLOW_CONTROL_VERSION,
    id,
    instanceId: claim.instanceId,
    epoch: claim.epoch,
    action: input.action,
    by: input.by,
    at: Date.now(),
    ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
    ...(input.message !== undefined ? { message: input.message } : {}),
  }
  const wire = JSON.stringify(request)
  if (parseWorkflowControlRequest(wire, id) === null) return { outcome: 'refused', reason: 'the request could not be spelled — nothing sent' }
  const answerMs = opts?.answerMs ?? WORKFLOW_CONTROL_ANSWER_MS
  const dir = workflowControlDir(runDir)
  await mkdir(dir, { recursive: true })

  let watcher: FSWatcher | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let poll: ReturnType<typeof setInterval> | undefined
  let done = false
  let settle: (result: WorkflowControlResult) => void = () => {}
  const waiting = new Promise<WorkflowControlResult>(resolve => {
    settle = result => {
      if (done) return
      done = true
      watcher?.close()
      if (timer !== undefined) clearTimeout(timer)
      if (poll !== undefined) clearInterval(poll)
      resolve(result)
    }
  })
  const readAnswer = async (): Promise<void> => {
    const answer = await readWorkflowControlAnswer(runDir, id)
    if (answer === null) return
    if (answer.id !== id || answer.instanceId !== claim.instanceId || answer.epoch !== claim.epoch) return
    settle(answer.result)
  }
  try {
    watcher = watch(resolveWatchRoot(dir), () => void readAnswer())
    watcher.on('error', () => void readAnswer())
    await durableAtomicPublish(requestPath(runDir, id), wire)
    timer = setTimeout(
      () => settle({ outcome: 'pending', reason: `the run has not answered within ${Math.round(answerMs / 1000)}s — the request stands; the run acts on it when it reads it`, requestId: id }),
      answerMs,
    )
    poll = setInterval(() => void readAnswer(), 250)
    poll.unref?.()
    await readAnswer()
    return await waiting
  } catch (error) {
    settle({ outcome: 'refused', reason: `the request could not be written: ${error instanceof Error ? error.message : String(error)}` })
    return waiting
  }
}

function verbOf(action: WorkflowControlAction): string {
  switch (action) {
    case 'stop':
      return 'stop'
    case 'pause':
    case 'pause-agent':
      return 'pause'
    case 'resume':
    case 'resume-agent':
      return 'resume'
    case 'kill-agent':
      return 'kill'
    case 'skip-agent':
      return 'skip'
    case 'retry-agent':
      return 'retry'
    case 'message-agent':
      return 'message'
  }
}

export type WorkflowControlJournal = {
  append(row: WorkflowControlJournalRow): Promise<void>
}

export async function serveWorkflowControl(opts: {
  runDir: string
  claim: Pick<RunClaim, 'instanceId' | 'epoch'>
  journal: WorkflowControlJournal
  apply(request: WorkflowControlRequest): Promise<WorkflowControlOutcome>
  onError(error: unknown): void
}): Promise<() => void> {
  const dir = workflowControlDir(opts.runDir)
  await mkdir(dir, { recursive: true })
  let closed = false
  let draining = false
  let again = false
  const handled = new Set<string>()

  const serveOne = async (id: string): Promise<void> => {
    if (handled.has(id)) return
    try {
      await readFile(answerPath(opts.runDir, id), 'utf8')
      handled.add(id)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    let raw: string
    try {
      raw = await readFile(requestPath(opts.runDir, id), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const request = parseWorkflowControlRequest(raw, id)
    if (request === null) {
      handled.add(id)
      return
    }
    let result: WorkflowControlOutcome
    const targetsThisClaim = request.instanceId === opts.claim.instanceId && request.epoch === opts.claim.epoch
    if (!targetsThisClaim || !sameClaim(await readRunClaim(opts.runDir), opts.claim)) {
      result = { outcome: 'refused', reason: 'the run changed hands — reopen the view before acting' }
    } else {
      await opts.journal.append({ type: 'control-request', request, at: Date.now() })
      handled.add(id)
      if (!sameClaim(await readRunClaim(opts.runDir), opts.claim)) {
        result = { outcome: 'refused', reason: 'the run changed hands before the action landed' }
      } else {
        try {
          result = await opts.apply(request)
        } catch (error) {
          result = { outcome: 'refused', reason: `the action failed: ${error instanceof Error ? error.message : String(error)}` }
        }
      }
      await opts.journal.append({
        type: 'control-result',
        requestId: id,
        action: request.action,
        by: request.by,
        ...(request.agentId !== undefined ? { agentId: request.agentId } : {}),
        result,
        at: Date.now(),
      })
    }
    handled.add(id)
    const answer: WorkflowControlAnswer = { id, instanceId: request.instanceId, epoch: request.epoch, result, at: Date.now() }
    await durableAtomicPublish(answerPath(opts.runDir, id), JSON.stringify(answer))
  }

  const drain = async (): Promise<void> => {
    if (closed) return
    if (draining) {
      again = true
      return
    }
    draining = true
    try {
      do {
        again = false
        const names = (await readdir(dir)).filter(n => n.endsWith(REQUEST_SUFFIX)).sort()
        for (const name of names) {
          if (closed) break
          const id = name.slice(0, -REQUEST_SUFFIX.length)
          if (REQUEST_ID.test(id)) await serveOne(id)
        }
      } while (again && !closed)
    } catch (error) {
      opts.onError(error)
    } finally {
      draining = false
    }
  }

  const watcher = watch(resolveWatchRoot(dir), () => void drain())
  watcher.on('error', opts.onError)
  const sweep = setInterval(() => void drain(), 1_000)
  sweep.unref?.()
  void drain()
  return () => {
    closed = true
    clearInterval(sweep)
    watcher.close()
  }
}

export class WorkflowExecutionPause {
  private runPausedBy: string | undefined
  private readonly agents = new Map<string, { by?: string; listeners: Set<() => void> }>()

  register(agentId: string): () => void {
    const entry = { listeners: new Set<() => void>() }
    this.agents.set(agentId, entry)
    return () => {
      this.agents.delete(agentId)
      for (const listener of entry.listeners) listener()
    }
  }

  change(paused: boolean, by: string, agentId?: string): WorkflowControlOutcome {
    if (agentId !== undefined) {
      const entry = this.agents.get(agentId)
      if (entry === undefined) return { outcome: 'refused', reason: 'the agent is not in flight — nothing to pause or resume' }
      if (paused && entry.by !== undefined) return { outcome: 'refused', reason: `already paused by ${entry.by}` }
      if (!paused && entry.by === undefined && this.runPausedBy === undefined) return { outcome: 'refused', reason: 'the agent is not paused — nothing to resume' }
      if (!paused && this.runPausedBy !== undefined) {
        for (const [otherId, other] of this.agents) {
          if (otherId !== agentId && other.by === undefined) other.by = this.runPausedBy
        }
        this.runPausedBy = undefined
      }
      entry.by = paused ? by : undefined
      for (const listener of entry.listeners) listener()
    } else {
      if (paused && this.runPausedBy !== undefined) return { outcome: 'refused', reason: `already paused by ${this.runPausedBy}` }
      if (!paused && this.runPausedBy === undefined && ![...this.agents.values()].some(a => a.by !== undefined)) {
        return { outcome: 'refused', reason: 'the run is not paused — nothing to resume' }
      }
      this.runPausedBy = paused ? by : undefined
      for (const entry of this.agents.values()) {
        if (!paused) entry.by = undefined
        for (const listener of entry.listeners) listener()
      }
    }
    return {
      outcome: 'applied',
      detail: paused
        ? `paused by ${by} — the ${agentId === undefined ? 'agents park' : 'agent parks'} before the next model call; work in flight finishes first`
        : `resumed by ${by} — the same ${agentId === undefined ? 'agents continue' : 'agent continues'}`,
    }
  }

  pausedBy(agentId?: string): string | undefined {
    if (this.runPausedBy !== undefined) return this.runPausedBy
    return agentId === undefined ? undefined : this.agents.get(agentId)?.by
  }

  runPaused(): boolean {
    return this.runPausedBy !== undefined
  }

  wait(agentId: string, signal: AbortSignal, onState: (by: string | undefined) => void): Promise<void> | undefined {
    const by = this.pausedBy(agentId)
    if (by === undefined) return undefined
    const entry = this.agents.get(agentId)
    if (entry === undefined) return undefined
    onState(by)
    return new Promise<void>((resolve, reject) => {
      const changed = (): void => {
        if (!signal.aborted && this.agents.has(agentId) && this.pausedBy(agentId) !== undefined) return
        entry.listeners.delete(changed)
        signal.removeEventListener('abort', changed)
        onState(undefined)
        if (signal.aborted) reject(new Error('Workflow aborted'))
        else resolve()
      }
      entry.listeners.add(changed)
      signal.addEventListener('abort', changed, { once: true })
      changed()
    })
  }
}

export function workflowControlBy(sessionId: string | undefined, pid: number): string {
  return sessionId !== undefined && sessionId !== '' ? `session ${sessionId.slice(0, 8)}` : `process ${pid}`
}
