
import { adoptiveProjectPath } from '../../utils/projectStoreAdoption.js'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { durableAtomicPublish } from '../../substrate/durablePublish.js'
import * as lockfile from '../../utils/lockfile.js'
import type {
  WorkflowPhase,
  WorkflowProgressEvent,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'

export const RUN_MANIFEST_FILENAME = 'run.json'

export const RUN_MANIFEST_VERSION = 1

export const RUN_MANIFEST_HEARTBEAT_MS = 15_000

export const RUN_MANIFEST_STALE_MS = 45_000

export const RUN_MANIFEST_WRITE_THROTTLE_MS = 2_000

const MAX_EMBEDDED_ARGS_JSON = 16_384
const ARGS_PREVIEW_CHARS = 400
const LOGS_TAIL_COUNT = 20

export type WorkflowRunAgentSummary = {
  agentId?: string
  index: number
  label: string
  state: 'start' | 'progress' | 'done' | 'error' | 'stopped' | 'skipped'
  phaseIndex?: number
  phaseTitle?: string
  model?: string
  agentType?: string
  effort?: string
  tokens?: number
  toolCalls?: number
  durationMs?: number
  startedAt?: number
  queuedAt?: number
  attempt?: number
  waiting?: 'prefill' | 'provider-backoff' | 'usage-window' | 'seat'
  waitWords?: string
  waitBudgetMs?: number
  waitSinceMs?: number
  retryInMs?: number
  recoveryTimeoutMs?: number
  retryAttempt?: number
  lastAttemptReason?: string
  lastProgressAt?: number
  lastToolName?: string
  lastToolSummary?: string
  promptPreview?: string
  resultPreview?: string
  error?: string
  cached?: boolean
}

export type WorkflowRunManifest = {
  version: number
  runId: string
  workflowName?: string
  title?: string
  description?: string
  phases?: WorkflowPhase[]
  scriptPath?: string
  scriptDigest?: string
  args?: unknown
  argsPreview?: string
  sessionId?: string
  transcriptDir?: string
  runDir: string
  startTime: number
  endTime?: number
  status: 'running' | 'completed' | 'completed_with_failures' | 'failed' | 'killed' | 'paused'
  origin?: { cwd: string; repoRoot?: string }
  owner?: { instanceId: string; epoch: number }
  transcriptDirs?: string[]
  ownerPid: number
  agentCount: number
  totalTokens: number
  totalToolCalls: number
  error?: string
  logsTail?: string[]
  agents: WorkflowRunAgentSummary[]
}

export function buildAgentSummaries(
  events: readonly WorkflowProgressEvent[],
): WorkflowRunAgentSummary[] {
  const out: WorkflowRunAgentSummary[] = []
  for (const ev of events) {
    if (ev.type !== 'workflow_agent') continue
    const str = (v: unknown): string | undefined =>
      typeof v === 'string' ? v : undefined
    const num = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) ? v : undefined
    out.push({
      agentId: str(ev['agentId']),
      index: ev.index,
      label: ev.label,
      state: ev.state,
      phaseIndex: ev.phaseIndex,
      phaseTitle: ev.phaseTitle,
      model: str(ev['model']),
      agentType: str(ev['agentType']),
      effort: str(ev['effort']),
      tokens: ev.tokens,
      toolCalls: ev.toolCalls,
      durationMs: ev.durationMs,
      startedAt: num(ev['startedAt']),
      queuedAt: num(ev['queuedAt']),
      attempt: num(ev['attempt']),
      waiting:
        ev['waiting'] === 'prefill' || ev['waiting'] === 'provider-backoff' || ev['waiting'] === 'usage-window' || ev['waiting'] === 'seat'
          ? ev['waiting']
          : undefined,
      waitWords: str(ev['waitWords']),
      waitBudgetMs: num(ev['waitBudgetMs']),
      waitSinceMs: num(ev['waitSinceMs']),
      retryInMs: num(ev['retryInMs']),
      recoveryTimeoutMs: num(ev['recoveryTimeoutMs']),
      retryAttempt: num(ev['retryAttempt']),
      lastAttemptReason: str(ev['lastAttemptReason']),
      lastProgressAt: num(ev['lastProgressAt']),
      lastToolName: str(ev['lastToolName']),
      lastToolSummary: str(ev['lastToolSummary']),
      promptPreview: str(ev['promptPreview']),
      resultPreview: str(ev['resultPreview']),
      error: ev.error,
      cached: ev.cached,
    })
  }
  return out.sort((a, b) => a.index - b.index)
}

export type WorkflowPhaseEventLite = { index: number; title: string }

export type PhaseBucketOf<A> = {
  index: number
  title: string
  detail?: string
  model?: string
  planned: boolean
  agents: A[]
}

export const UNPHASED_INDEX = -1

export function groupAgentsByPhase<
  A extends { index: number; phaseIndex?: number; phaseTitle?: string },
>(
  planned: readonly WorkflowPhase[] | undefined,
  phaseEvents: readonly WorkflowPhaseEventLite[],
  agents: readonly A[],
): PhaseBucketOf<A>[] {
  const buckets: PhaseBucketOf<A>[] = []
  const byTitle = new Map<string, PhaseBucketOf<A>>()
  const byIndex = new Map<number, PhaseBucketOf<A>>()
  let nextIndex = 0
  const add = (b: PhaseBucketOf<A>): PhaseBucketOf<A> => {
    buckets.push(b)
    byIndex.set(b.index, b)
    if (!byTitle.has(b.title)) byTitle.set(b.title, b)
    nextIndex = Math.max(nextIndex, b.index + 1)
    return b
  }
  const addLive = (index: number, title: string): PhaseBucketOf<A> =>
    add({
      index: byIndex.has(index) ? nextIndex : index,
      title,
      planned: false,
      agents: [],
    })

  ;(planned ?? []).forEach((p, i) => {
    if (byTitle.has(p.title)) return
    add({ index: i, title: p.title, detail: p.detail, model: p.model, planned: true, agents: [] })
  })
  for (const ev of phaseEvents) {
    const t = byTitle.get(ev.title)
    if (t) {
      t.planned = false
      continue
    }
    addLive(ev.index, ev.title)
  }
  for (const a of agents) {
    let b =
      (a.phaseTitle != null ? byTitle.get(a.phaseTitle) : undefined) ??
      (typeof a.phaseIndex === 'number' ? byIndex.get(a.phaseIndex) : undefined)
    if (!b) {
      b =
        a.phaseTitle != null
          ? addLive(a.phaseIndex ?? nextIndex, a.phaseTitle)
          : (byIndex.get(UNPHASED_INDEX) ??
            add({ index: UNPHASED_INDEX, title: 'Agents', planned: false, agents: [] }))
    }
    if (b.planned) b.planned = false
    b.agents.push(a)
  }
  return buckets
    .sort((a, b) => a.index - b.index)
    .map(g => ({ ...g, agents: [...g.agents].sort((x, y) => x.index - y.index) }))
}

export function embedArgs(
  args: unknown,
): Pick<WorkflowRunManifest, 'args' | 'argsPreview'> {
  if (args === undefined) return {}
  let json: string
  try {
    json = JSON.stringify(args) ?? 'null'
  } catch {
    return { argsPreview: '<unserializable args>' }
  }
  if (json.length <= MAX_EMBEDDED_ARGS_JSON) return { args }
  return { argsPreview: json.slice(0, ARGS_PREVIEW_CHARS) }
}

export function logsTail(logs: readonly string[]): string[] {
  return logs.slice(-LOGS_TAIL_COUNT)
}


export function createManifestWriteChain(
  publish: (m: WorkflowRunManifest) => Promise<void>,
  logFailure: (e: unknown) => void,
  opts?: {
    stillOwner?: () => Promise<boolean>
    onFenced?: () => void
  },
): {
  finalized: () => boolean
  write: (snapshot: WorkflowRunManifest, final: boolean) => Promise<boolean>
} {
  let finalized = false
  let fencedReported = false
  let chain: Promise<unknown> = Promise.resolve()
  return {
    finalized: () => finalized,
    write(snapshot: WorkflowRunManifest, final: boolean): Promise<boolean> {
      if (finalized) return Promise.resolve(true)
      if (final) finalized = true
      const attempt = (): Promise<boolean> =>
        publish(snapshot).then(
          () => true,
          e => {
            logFailure(e)
            return false
          },
        )
      const thisWrite = chain.then(async () => {
        if (opts?.stillOwner) {
          let owned = true
          try {
            owned = await opts.stillOwner()
          } catch {
            owned = true
          }
          if (!owned) {
            if (final) finalized = false
            if (!fencedReported) {
              fencedReported = true
              try {
                opts.onFenced?.()
              } catch {
              }
            }
            return false
          }
        }
        let ok = await attempt()
        if (!ok && final) ok = await attempt()
        if (!ok && final) finalized = false
        return ok
      })
      chain = thisWrite
      return thisWrite
    },
  }
}

export async function writeRunManifest(
  manifest: WorkflowRunManifest,
): Promise<void> {
  const file = path.join(manifest.runDir, RUN_MANIFEST_FILENAME)
  await durableAtomicPublish(file, JSON.stringify(manifest))
}

export async function readRunManifest(
  runDir: string,
): Promise<(WorkflowRunManifest & { mtimeMs: number }) | undefined> {
  const file = path.join(runDir, RUN_MANIFEST_FILENAME)
  try {
    const [raw, st] = await Promise.all([readFile(file, 'utf8'), stat(file)])
    const parsed = JSON.parse(raw) as WorkflowRunManifest
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.runId !== 'string' ||
      typeof parsed.version !== 'number' ||
      parsed.version > RUN_MANIFEST_VERSION
    ) {
      return undefined
    }
    return { ...parsed, runDir, mtimeMs: st.mtimeMs }
  } catch {
    return undefined
  }
}

export function workflowsDir(cwd: string): string {
  return adoptiveProjectPath(cwd, 'workflows')
}

export function workflowRunsRoot(cwd: string): string {
  return path.join(workflowsDir(cwd), 'runs')
}

const manifestParseCache = new Map<
  string,
  WorkflowRunManifest & { mtimeMs: number }
>()

const LIST_CONCURRENCY_DEFAULT = 32

async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        const i = next++
        if (i >= items.length) return
        out[i] = await fn(items[i]!)
      }
    },
  )
  await Promise.all(workers)
  return out
}

const isEnoent = (e: unknown): boolean =>
  (e as { code?: string } | undefined)?.code === 'ENOENT'

function parseListedManifest(
  raw: string,
  runDir: string,
  mtimeMs: number,
): (WorkflowRunManifest & { mtimeMs: number }) | undefined {
  try {
    const parsed = JSON.parse(raw) as WorkflowRunManifest
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.runId !== 'string' ||
      typeof parsed.version !== 'number' ||
      parsed.version > RUN_MANIFEST_VERSION
    ) {
      return undefined
    }
    return { ...parsed, runDir, mtimeMs }
  } catch {
    return undefined
  }
}

export type WorkflowRunListing = {
  rows: Array<WorkflowRunManifest & { mtimeMs: number }>
  unreadable: number
}

export async function listWorkflowRunsDetailed(
  cwd: string,
  opts?: { limit?: number; concurrency?: number },
): Promise<WorkflowRunListing> {
  const root = workflowRunsRoot(cwd)
  let entries: string[]
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter(e => e.isDirectory())
      .map(e => e.name)
  } catch {
    return { rows: [], unreadable: 0 }
  }
  const concurrency = opts?.concurrency ?? LIST_CONCURRENCY_DEFAULT
  let unreadable = 0

  type Candidate = { runDir: string; mtimeMs: number }
  const statted = await mapBounded(entries, concurrency, async name => {
    const runDir = path.join(root, name)
    try {
      const st = await stat(path.join(runDir, RUN_MANIFEST_FILENAME))
      return { runDir, mtimeMs: st.mtimeMs } as Candidate
    } catch (e) {
      manifestParseCache.delete(runDir)
      if (!isEnoent(e)) unreadable++
      return null
    }
  })
  let candidates = statted.filter((s): s is Candidate => s !== null)
  if (opts?.limit !== undefined) {
    candidates = [...candidates]
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, Math.max(0, opts.limit))
  }

  const rows: Array<WorkflowRunManifest & { mtimeMs: number }> = []
  await mapBounded(candidates, concurrency, async c => {
    const hit = manifestParseCache.get(c.runDir)
    if (hit && hit.mtimeMs === c.mtimeMs) {
      rows.push({ ...hit })
      return
    }
    let raw: string
    try {
      raw = await readFile(path.join(c.runDir, RUN_MANIFEST_FILENAME), 'utf8')
    } catch (e) {
      manifestParseCache.delete(c.runDir)
      if (!isEnoent(e)) unreadable++
      return
    }
    const fresh = parseListedManifest(raw, c.runDir, c.mtimeMs)
    if (fresh) {
      manifestParseCache.set(c.runDir, fresh)
      rows.push({ ...fresh })
    } else {
      manifestParseCache.delete(c.runDir)
    }
  })
  rows.sort((a, b) => b.startTime - a.startTime)
  return { rows, unreadable }
}

export async function listWorkflowRuns(
  cwd: string,
  opts?: { limit?: number; concurrency?: number },
): Promise<Array<WorkflowRunManifest & { mtimeMs: number }>> {
  return (await listWorkflowRunsDetailed(cwd, opts)).rows
}

export type RunLiveness = 'live' | 'wedged' | 'orphaned'

export function runLiveness(
  manifest: Pick<WorkflowRunManifest, 'status' | 'ownerPid'>,
  mtimeMs: number,
  nowMs: number,
  pidAlive: (pid: number) => boolean,
): RunLiveness {
  if (manifest.status !== 'running') return 'live'
  if (nowMs - mtimeMs <= RUN_MANIFEST_STALE_MS) return 'live'
  try {
    return pidAlive(manifest.ownerPid) ? 'wedged' : 'orphaned'
  } catch {
    return 'orphaned'
  }
}

export function isRunOrphaned(
  manifest: Pick<WorkflowRunManifest, 'status' | 'ownerPid'>,
  mtimeMs: number,
  nowMs: number,
  pidAlive: (pid: number) => boolean,
): boolean {
  return runLiveness(manifest, mtimeMs, nowMs, pidAlive) === 'orphaned'
}


export const RUN_CLAIM_FILENAME = 'claim.json'

export type RunClaim = { instanceId: string; epoch: number; pid: number; claimedAt: number }

export async function readRunClaim(runDir: string): Promise<RunClaim | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(path.join(runDir, RUN_CLAIM_FILENAME), 'utf8'),
    ) as RunClaim
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.instanceId !== 'string' ||
      typeof parsed.epoch !== 'number'
    ) {
      return undefined
    }
    return parsed
  } catch {
    return undefined
  }
}

export async function claimRun(runDir: string): Promise<RunClaim> {
  await mkdir(runDir, { recursive: true })
  const claimPath = path.join(runDir, RUN_CLAIM_FILENAME)
  try {
    await stat(claimPath)
  } catch {
    await writeFile(claimPath, '{}', { flag: 'wx' }).catch(() => {})
  }
  let release: (() => Promise<void>) | undefined
  try {
    release = await lockfile.lock(claimPath, { retries: { retries: 5, minTimeout: 40, maxTimeout: 300 } })
    const prior = await readRunClaim(runDir)
    const claim: RunClaim = {
      instanceId: randomUUID(),
      epoch: (prior?.epoch ?? 0) + 1,
      pid: process.pid,
      claimedAt: Date.now(),
    }
    await durableAtomicPublish(claimPath, JSON.stringify(claim))
    return claim
  } finally {
    await release?.()
  }
}

export function recordedOwnerAlive(
  manifest: Pick<WorkflowRunManifest, 'status'>,
  mtimeMs: number,
  nowMs: number,
): boolean {
  return manifest.status === 'running' && nowMs - mtimeMs <= RUN_MANIFEST_STALE_MS
}

export type DiskResumability =
  | { ok: true; scriptPath: string; args: unknown }
  | { ok: false; reason: string }

export function diskResumability(
  m: Pick<
    WorkflowRunManifest,
    'status' | 'ownerPid' | 'runDir' | 'scriptPath' | 'scriptDigest' | 'args' | 'argsPreview'
  > & { mtimeMs?: number },
  deps: {
    pidAlive: (pid: number) => boolean
    fileExists: (p: string) => boolean
    readFileText: (p: string) => string | undefined
    sha256: (text: string) => string
    nowMs?: number
  },
): DiskResumability {
  if (m.status === 'completed' || m.status === 'completed_with_failures') {
    return { ok: false, reason: 'completed — S saves the script; rerun it as a NEW run by name' }
  }
  if (m.status === 'running') {
    if (m.mtimeMs !== undefined && deps.nowMs !== undefined) {
      if (recordedOwnerAlive(m, m.mtimeMs, deps.nowMs)) {
        return { ok: false, reason: 'the recorded owner is alive (heartbeat fresh) — never resume under a healthy owner' }
      }
    } else {
      let ownerAlive = false
      try {
        ownerAlive = deps.pidAlive(m.ownerPid)
      } catch {
        ownerAlive = false
      }
      if (ownerAlive) {
        return { ok: false, reason: `still owned by live pid ${m.ownerPid} — never resume under a healthy owner` }
      }
    }
  }
  const candidates = [
    path.join(m.runDir, 'workflow.js'),
    ...(m.scriptPath ? [m.scriptPath] : []),
  ]
  let scriptPath: string | undefined
  let sourceText: string | undefined
  for (const c of candidates) {
    if (!deps.fileExists(c)) continue
    const text = deps.readFileText(c)
    if (text === undefined) continue
    scriptPath = c
    sourceText = text
    break
  }
  if (!scriptPath || sourceText === undefined) {
    return {
      ok: false,
      reason: `source missing — neither ${path.join(m.runDir, 'workflow.js')} nor the recorded scriptPath is readable`,
    }
  }
  if (m.scriptDigest && deps.sha256(sourceText) !== m.scriptDigest) {
    return {
      ok: false,
      reason: 'source digest mismatch — the script changed since this run; S save + rerun as new',
    }
  }
  const argsPath = path.join(m.runDir, 'args.json')
  if (deps.fileExists(argsPath)) {
    const raw = deps.readFileText(argsPath)
    if (raw !== undefined) {
      try {
        return { ok: true, scriptPath, args: JSON.parse(raw) }
      } catch {
        return { ok: false, reason: 'args.json is corrupt — resume would run with wrong inputs' }
      }
    }
  }
  if (m.args !== undefined) return { ok: true, scriptPath, args: m.args }
  if (m.argsPreview) {
    return {
      ok: false,
      reason: 'args too large to recover exactly (pre-args.json run) — rerun as new with explicit args',
    }
  }
  return { ok: true, scriptPath, args: undefined }
}

export function partitionDiskRuns<
  T extends Pick<WorkflowRunManifest, 'status' | 'ownerPid' | 'runId'> & {
    mtimeMs: number
  },
>(
  manifests: readonly T[],
  localRunIds: ReadonlySet<string>,
  nowMs: number,
  pidAlive: (pid: number) => boolean,
): { external: Array<T & { liveness: 'live' | 'wedged' }>; past: T[] } {
  const external: Array<T & { liveness: 'live' | 'wedged' }> = []
  const past: T[] = []
  for (const m of manifests) {
    if (localRunIds.has(m.runId)) continue
    const claimsRunning = m.status === 'running'
    const liveness = runLiveness(m, m.mtimeMs, nowMs, pidAlive)
    if (claimsRunning && (liveness === 'live' || liveness === 'wedged')) {
      external.push({ ...m, liveness })
    } else {
      past.push(m)
    }
  }
  return { external, past }
}
