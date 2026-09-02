// =============================================================================
// WorkflowTool/runManifest.ts — the per-run MANIFEST (run.json).
//
// A small, atomically-written snapshot
// of a workflow run's identity + live rollup, co-located with journal.jsonl in
// <cwd>/.mercury/workflows/runs/<runId>/run.json. It exists so the /workflows
// management board can:
//   • list PAST runs after a harness restart (AppState.tasks is in-memory only),
//   • join a run to its per-agent transcripts (transcriptDir is recorded
//     ABSOLUTE here — the transcripts live under the session tree, a DIFFERENT
//     root than the run dir; see sessionStorage.getAgentTranscriptPath),
//   • tell a genuinely-running run from an ORPHANED one (ownerPid + the
//     heartbeat mtime: the writer re-stamps while running, so a 'running'
//     manifest with a stale mtime and a dead pid is stale, never a spinner).
//
// This module is deliberately LEAF + bun-loadable (node builtins + type-only
// imports) so proof scripts can import it directly; the caller (WorkflowTool)
// supplies every harness-derived value (transcriptDir, session id, task state).
// =============================================================================

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

/** Manifest schema version (bump on shape change; readers skip newer majors). */
export const RUN_MANIFEST_VERSION = 1

/** While running, the writer re-stamps the manifest at least this often. */
export const RUN_MANIFEST_HEARTBEAT_MS = 15_000

/** A 'running' manifest whose mtime is older than this is orphan-suspect. */
export const RUN_MANIFEST_STALE_MS = 45_000

/** Progress-frame writes are throttled to at most one manifest write per this. */
export const RUN_MANIFEST_WRITE_THROTTLE_MS = 2_000

// args are embedded only when their JSON stays small; larger args keep a
// preview so the board can still show "what was this run asked to do".
const MAX_EMBEDDED_ARGS_JSON = 16_384
const ARGS_PREVIEW_CHARS = 400
const LOGS_TAIL_COUNT = 20

/** One agent's coalesced rollup, derived from its last workflow_agent frame. */
export type WorkflowRunAgentSummary = {
  agentId?: string
  index: number
  label: string
  /** 'stopped' = parent settled mid-flight; 'skipped' = operator skip. */
  state: 'start' | 'progress' | 'done' | 'error' | 'stopped' | 'skipped'
  phaseIndex?: number
  phaseTitle?: string
  model?: string
  agentType?: string
  effort?: string
  tokens?: number
  toolCalls?: number
  durationMs?: number
  /** Wall-clock the current attempt started (live-runtime seed while running). */
  startedAt?: number
  /** Wall-clock the agent() call was dispatched (queued-wait seed). */
  queuedAt?: number
  attempt?: number
  /** The producer's liveness fields — carried, never dropped:
   *  a no-tool state is only honestly "thinking" when none of these say
   *  otherwise, and a stale lastProgressAt demotes the last tool line from
   *  "current" to history. One derivation reads them: livePulse.agentPulse. */
  waiting?: 'prefill' | 'provider-backoff'
  retryInMs?: number
  /** /H-01: a blocking recovery call's ceiling — distinct from a real
   *  scheduled retry delay (livePulse renders each honestly). */
  recoveryTimeoutMs?: number
  retryAttempt?: number
  lastAttemptReason?: string
  lastProgressAt?: number
  lastToolName?: string
  /** `Tool(firstArg…)` — the last tool call's input summary (live activity). */
  lastToolSummary?: string
  promptPreview?: string
  /** Clipped preview of the agent's returned result (done frames carry it). */
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
  /** sha256 of the launched script — disk resume verifies the recovered
   *  source against it (additive; pre-WS3 manifests simply lack it). */
  scriptDigest?: string
  /** Embedded verbatim only while small — otherwise argsPreview carries a clip. */
  args?: unknown
  argsPreview?: string
  sessionId?: string
  /** ABSOLUTE dir holding agent-<agentId>.jsonl transcripts for this run. */
  transcriptDir?: string
  /** The run dir itself (journal.jsonl + workflow.js + this file). */
  runDir: string
  startTime: number
  endTime?: number
  status: 'running' | 'completed' | 'completed_with_failures' | 'failed' | 'killed' | 'paused'
  /** Execution origin captured ONCE at launch (Q14 — ADDITIVE, no
   *  version bump: readers forward-reject only on a newer major). Every
   *  descendant of the run executes under origin.cwd via runWithCwdOverride;
   *  resume resolves from it or refuses. */
  origin?: { cwd: string; repoRoot?: string }
  /** Run ownership: the claim's random instance id +
   *  monotonic epoch. Owner identity is NEVER a bare pid — a recycled pid
   *  must not read as a live owner, and a woken stale owner's writes are
   *  recognizable by their older epoch. */
  owner?: { instanceId: string; epoch: number }
  /** Every session-tree directory this run's agent transcripts have been
   *  written under: /clear or a
   *  cross-session resume moves the live destination — readers fall back
   *  across ALL of them instead of losing the chain. transcriptDir stays
   *  the CURRENT destination. */
  transcriptDirs?: string[]
  ownerPid: number
  agentCount: number
  totalTokens: number
  totalToolCalls: number
  error?: string
  logsTail?: string[]
  agents: WorkflowRunAgentSummary[]
}

/**
 * Derive per-agent rollups from a task's coalesced workflowProgress. The task
 * layer already upserts workflow_agent events last-write-wins by `index`
 * (LocalWorkflowTask.tsx), so each index appears at most once here; this is a
 * projection, not a second reducer. The rich fields (agentId, model, attempt…)
 * ride the event's open index signature — read defensively, never fabricated.
 */
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
        ev['waiting'] === 'prefill' || ev['waiting'] === 'provider-backoff'
          ? ev['waiting']
          : undefined,
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

// ── the ONE phase-grouping projector ───────────────────
// Both /workflows projectors (WorkflowDetailDialog.buildTree for a LIVE event
// stream, RunDetailPane.groupByPhase for a disk manifest) would otherwise seed planned
// phases at 0-based array positions while the executor's resolvePhase allocated
// 1-based ids — so every run rendered its planned phase EMPTY ("Audit (0)")
// beside a duplicate live phase carrying the agents ("Audit (1)"), and the
// selected-by-default first section showed an empty agents table while agents
// ran. The executor is 0-based now (agentHooks.ts), and this shared projector
// ALSO merges buckets by TITLE — titles are phase identity (resolvePhase keys
// on them) — which heals manifests persisted by the 1-based era and any future
// index drift. Lives here because this module is the deliberately bun-loadable
// leaf: the proof exercises the real function.
export type WorkflowPhaseEventLite = { index: number; title: string }

export type PhaseBucketOf<A> = {
  index: number
  title: string
  detail?: string
  model?: string
  /** True while the phase exists only in the planned structure (no live
   *  workflow_phase event and no agent has reported under it). */
  planned: boolean
  agents: A[]
}

/** Agents with no phase land in this synthetic bucket (sorts first). */
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
    // First occurrence owns the title (duplicate titles merge into it).
    if (!byTitle.has(b.title)) byTitle.set(b.title, b)
    nextIndex = Math.max(nextIndex, b.index + 1)
    return b
  }
  /** Allocate a bucket for a live title: its own index when free, else the
   *  next free slot (an index collision with a DIFFERENT title must never
   *  overwrite a planned bucket — the 1-based-era manifests hit this). */
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
      t.planned = false // the live event flips a planned phase active
      continue
    }
    addLive(ev.index, ev.title)
  }
  for (const a of agents) {
    // Title is phase identity — resolve by it first; a bare phaseIndex (an
    // agent can only carry one via a resolved title today) is the fallback.
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
    if (b.planned) b.planned = false // first agent to report flips it active
    b.agents.push(a)
  }
  return buckets
    .sort((a, b) => a.index - b.index)
    .map(g => ({ ...g, agents: [...g.agents].sort((x, y) => x.index - y.index) }))
}

/** Embed args verbatim only when small; otherwise keep an honest preview. */
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

/** Trim a run's logs to the tail the manifest carries. */
export function logsTail(logs: readonly string[]): string[] {
  return logs.slice(-LOGS_TAIL_COUNT)
}

// Per-write tmp uniqueness: two writeManifest() calls for the SAME run can be
// in flight at once (a throttled progress flush racing the terminal write) —
// the durable primitive's pid+random temp name keeps every writer distinct.
// (Ordering of the two RENAMEs is handled by the serialized write chain —
// createManifestWriteChain below, used by WorkflowTool.tsx's writeManifest.)

/**
 * The serialized manifest write chain. Owns the ordering + the
 * finalized latch + the terminal-write retry, so the laws are provable at
 * this seam with an injected publisher:
 *   • writes land in CALL order (a throttled pre-terminal flush enqueued
 *     before the terminal write can never rename after it);
 *   • after a SUCCESSFUL final write, later writes are swallowed (a
 *     straggling heartbeat cannot overwrite the terminal snapshot);
 *   • a FAILED final write retries once, and if both attempts fail the
 *     latch RESETS — the old shape latched `finalized` before the write
 *     landed, so one transient failure left run.json claiming 'running'
 *     forever while every later attempt returned true unexecuted.
 */
export function createManifestWriteChain(
  publish: (m: WorkflowRunManifest) => Promise<void>,
  logFailure: (e: unknown) => void,
  opts?: {
    /** Ownership fence: checked inside the chain before every
     *  publish. A stale owner that wakes after a takeover (its run was
     *  re-claimed under a newer epoch) must not clobber the new owner's
     *  manifest — its writes are SKIPPED (resolved false) and reported once
     *  through onFenced. */
    stillOwner?: () => Promise<boolean>
    onFenced?: () => void
  },
): {
  /** True once a final snapshot has LANDED (or is in flight un-failed). */
  finalized: () => boolean
  /** Enqueue one snapshot; resolves true when ITS write landed. */
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
            owned = true // an unreadable claim must not silence a healthy run
          }
          if (!owned) {
            if (final) finalized = false
            if (!fencedReported) {
              fencedReported = true
              try {
                opts.onFenced?.()
              } catch {
                /* surface must never break the chain */
              }
            }
            return false
          }
        }
        let ok = await attempt()
        if (!ok && final) ok = await attempt() // one bounded terminal retry
        if (!ok && final) finalized = false // never swallow later attempts
        return ok
      })
      chain = thisWrite
      return thisWrite
    },
  }
}

/**
 * Atomic write through the one durable publication primitive, so a reader
 * never sees a torn manifest and the file's mtime doubles as the liveness
 * heartbeat.
 */
export async function writeRunManifest(
  manifest: WorkflowRunManifest,
): Promise<void> {
  const file = path.join(manifest.runDir, RUN_MANIFEST_FILENAME)
  await durableAtomicPublish(file, JSON.stringify(manifest))
}

/** Read one run dir's manifest; undefined on missing/unparseable/newer-major. */
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

/** The ONE workflows store root for a cwd — sticky at the STORE ROOT
 *  (P3: an existing home's workflows stay in place; fresh projects
 *  create under .mercury). Every consumer (run dirs, the install target, the
 *  board, resume) derives from THIS so a new runId can never fork homes. */
export function workflowsDir(cwd: string): string {
  return adoptiveProjectPath(cwd, 'workflows')
}

/** The runs root for a cwd (mirrors WorkflowTool.workflowRunDir's parent). */
export function workflowRunsRoot(cwd: string): string {
  return path.join(workflowsDir(cwd), 'runs')
}

// mtime parse-cache for the LISTING path: the writer's heartbeat
// re-stamp IS the invalidation signal, so an unchanged run.json is not
// re-read or re-parsed on every board poll. Each hit still returns a FRESH
// top-level clone: boardDiskResumability keys its probe WeakMap
// on manifest object identity with zero invalidation logic, and an orphan
// transition (owner died ⇒ mtime frozen) must keep re-probing per poll.
// Single-manifest readers (resume, the workflow ref) stay on the uncached
// readRunManifest — always-fresh is right for one-shot reads.
const manifestParseCache = new Map<
  string,
  WorkflowRunManifest & { mtimeMs: number }
>()

/** Bounded fan-out: the old unbounded Promise.all held one
 *  open descriptor per HISTORICAL run for the sweep's duration — at 10k runs
 *  that is 10k simultaneous fds, and past the process limit every EMFILE was
 *  swallowed as "no manifest". */
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

/** Shared validation for a listed manifest body (the readRunManifest rules). */
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

/**
 * The honest listing shape: `unreadable` counts run dirs whose
 * manifest could not be READ for an I/O reason (fd exhaustion, permissions,
 * transient locks) — absence and unparseable bodies keep their historical
 * skip semantics. A non-zero value means the listing is PARTIAL, and a
 * consumer that counts or partitions runs must say so instead of presenting
 * the remainder as the whole.
 */
export type WorkflowRunListing = {
  rows: Array<WorkflowRunManifest & { mtimeMs: number }>
  unreadable: number
}

/**
 * List run manifests under <cwd>'s workflows store, newest-first by
 * startTime. Dirs without a run.json (pre-manifest runs) are skipped.
 *
 * cost scales with REQUESTED data — `limit` selects the
 * newest-N candidates by run.json mtime (the writer's heartbeat/terminal
 * stamp; the startTime sort key lives inside the body, so mtime is the
 * ordering proxy that avoids reading everything) and only those are read;
 * the fan-out is bounded (`concurrency`, default 32) so descriptors no
 * longer scale with lifetime history.
 */
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

/** The historical array facade — every row of listWorkflowRunsDetailed. */
export async function listWorkflowRuns(
  cwd: string,
  opts?: { limit?: number; concurrency?: number },
): Promise<Array<WorkflowRunManifest & { mtimeMs: number }>> {
  return (await listWorkflowRunsDetailed(cwd, opts)).rows
}

/**
 * Liveness tri-state (pure): what a claims-running manifest's heartbeat + pid
 * actually prove. `pidAlive` is injected (process.kill(pid, 0) at the call
 * site) so this stays side-effect-free and provable.
 *   'live'     — settled manifest, or heartbeat fresh (the writer re-stamps
 *                every RUN_MANIFEST_HEARTBEAT_MS while running).
 *   'wedged'   — heartbeat stale but the owning pid is STILL ALIVE: a hung
 *                engine. Before this word existed, a wedged run impersonated
 *                a healthy one forever (isRunOrphaned demands a dead pid).
 *   'orphaned' — heartbeat stale and the owner is absent: render stale, never
 *                spin.
 */
export type RunLiveness = 'live' | 'wedged' | 'orphaned'

export function runLiveness(
  manifest: Pick<WorkflowRunManifest, 'status' | 'ownerPid'>,
  mtimeMs: number,
  nowMs: number,
  pidAlive: (pid: number) => boolean,
): RunLiveness {
  // 'paused' is SETTLED on disk: a deliberately suspended
  // run has nothing executing and no heartbeat by design — treating it as
  // claims-running rendered every honestly-paused manifest 'stale'/'wedged'
  // the moment its owner exited. It files under Past with the AMBER paused
  // word (statusTone) and resumes from its run id.
  if (manifest.status !== 'running') return 'live'
  if (nowMs - mtimeMs <= RUN_MANIFEST_STALE_MS) return 'live'
  try {
    return pidAlive(manifest.ownerPid) ? 'wedged' : 'orphaned'
  } catch {
    return 'orphaned'
  }
}

/**
 * Orphan check (pure) — the original predicate, now a view over runLiveness
 * so the two can never disagree.
 */
export function isRunOrphaned(
  manifest: Pick<WorkflowRunManifest, 'status' | 'ownerPid'>,
  mtimeMs: number,
  nowMs: number,
  pidAlive: (pid: number) => boolean,
): boolean {
  return runLiveness(manifest, mtimeMs, nowMs, pidAlive) === 'orphaned'
}

// ── the run claim ────────────────────────────────────────────────
// Ownership of a run is a CLAIM FILE beside the manifest — a random
// owner-instance id plus a monotonic epoch — never a bare pid (pids recycle).
// Launch claims epoch 1; every resume re-claims under the run lockfile and
// bumps the epoch. The manifest snapshot and every journal row carry the
// claim, so a stale owner that wakes after a takeover is recognizable: its
// manifest writes are skipped by the write chain's stillOwner guard and its
// journal rows are filtered at load (any row whose epoch precedes one
// already seen landed after a takeover).

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

/** Claim (or re-claim) a run: epoch = prior + 1, fresh random instance id.
 *  Serialized under the run's claim lockfile so two concurrent resumes
 *  cannot mint the same epoch. */
export async function claimRun(runDir: string): Promise<RunClaim> {
  await mkdir(runDir, { recursive: true })
  const claimPath = path.join(runDir, RUN_CLAIM_FILENAME)
  // proper-lockfile needs an existing target — seed an empty claim once.
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

/** Is the RECORDED owner alive? The heartbeat (manifest mtime re-stamped
 *  every RUN_MANIFEST_HEARTBEAT_MS while running) is the owner-liveness
 *  signal — never `pidAlive` alone, which answers "someone holds this pid"
 *  (a recycled pid held a crashed run unresumable forever). */
export function recordedOwnerAlive(
  manifest: Pick<WorkflowRunManifest, 'status'>,
  mtimeMs: number,
  nowMs: number,
): boolean {
  return manifest.status === 'running' && nowMs - mtimeMs <= RUN_MANIFEST_STALE_MS
}

// ── disk resume (Sol 5.6 WS3) ────────────────────────────────────────────────
// Whether a DISK-BACKED run can be resumed safely from its persisted
// artifacts alone, and with exactly what. The board's `R` arms only on
// ok:true; ok:false carries the exact reason the
// detail pane shows. Rules:
//   • a run this/another process is EXECUTING is never offered (the board's
//     partition keeps external rows out of Past — this function additionally
//     refuses a claims-running manifest whose owner is still alive).
//   • completed runs are not "resumable" (a full-cache replay adds nothing);
//     they surface S save → rerun by name instead.
//   • the source must be recoverable: <runDir>/workflow.js first, the
//     manifest's scriptPath second; when the manifest recorded a
//     scriptDigest, the recovered source must MATCH it.
//   • args must be exact: args.json (written at launch since WS3) first,
//     the manifest's small-embedded args second; a big-args run from before
//     args.json refuses honestly rather than resuming with wrong inputs.
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
    /** Injected clock for the heartbeat rule (side-effect-free, provable). */
    nowMs?: number
  },
): DiskResumability {
  if (m.status === 'completed' || m.status === 'completed_with_failures') {
    return { ok: false, reason: 'completed — S saves the script; rerun it as a NEW run by name' }
  }
  if (m.status === 'running') {
    // Owner liveness: when the manifest's heartbeat is available
    // it IS the owner-alive signal — `pidAlive` alone answers "someone holds
    // this pid", and a recycled pid held a crashed run unresumable forever.
    // A stale-heartbeat run is recoverable regardless of the pid; the epoch
    // claim makes a woken stale owner's late writes recognizable. Callers
    // without an mtime (legacy pure matrix) keep the pid rule.
    if (m.mtimeMs !== undefined && deps.nowMs !== undefined) {
      if (recordedOwnerAlive(m, m.mtimeMs, deps.nowMs)) {
        return { ok: false, reason: 'the recorded owner is alive (heartbeat fresh) — never resume under a healthy owner' }
      }
      // stale heartbeat ⇒ the recorded owner is absent (or wedged past the
      // window — the resume claim's epoch bump fences its late writes):
      // recoverable below.
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
    // dead owner ⇒ orphaned: recoverable below.
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

/**
 * Partition disk manifests for the board (pure): runs this process already
 * tracks in AppState are dropped (the live task row is the truth for them);
 * a claims-running manifest whose owner is another process files under
 * EXTERNAL — running elsewhere ('live') or hung elsewhere ('wedged') — so a
 * daemon-side or second-session run can never impersonate history; everything
 * else (settled or orphaned) is honestly PAST.
 */
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
    // paused = settled (see runLiveness) — a paused manifest files under Past.
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
