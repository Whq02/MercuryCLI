// ============================================================================
//  services/concourse/coordinatorBoard — the coordinator's WORLD-STATE view:
//  the ONE projection of the switchboard board the model reads. Every turn's
//  input block and the list_sessions tool both call coordinatorBoardView(),
//  so the model's board IS the operator's board (buildConcourseSnapshot —
//  the same rows, states, ages and NOW cells the screen paints), joined with
//  the worker records for what a row does not carry (model · effort ·
//  worktree path · who paused/stopped it) and with each fork's commit state
//  (concourseWorktrees — the reap decision's own read).
//
//  Why a full snapshot every turn (provider prompting best practices, read
//  live: "use structured formats for state data"; the Fable-5
//  guide: "audit each claim against a tool result"): a coordinator that must
//  discover the board piecemeal guesses about it — the live transcript that
//  motivated this owner said "1 live" over three sessions because two were
//  WITH YOU and the state word reached the model unexplained. Every row now
//  carries its state AND what the state means in the operator's words.
//
//  Bounded: one snapshot build + one records read + one ≤8KB head read per
//  row (the brief) + git metadata probes under one budget of 8 (a fork's
//  ahead-count + dirt, a main checkout's dirt). Fail-soft: a projection
//  failure yields an empty board with `degraded` named — never a fabricated
//  row.
// ============================================================================

import type { ConcourseRowV1 } from '../../components/concourse/contracts.js'
import { concourseWaitCopy } from '../../components/concourse/contracts.js'
import type { ConcourseWorkerRecordV1 } from '../../daemon/concourseSupervisor.js'
import { OLDER_CHATS_ROW_PREFIX } from './concourseSnapshot.js'

/** One board row as the model sees it. `state` is the board's own lifecycle
 *  word; `means` says it in the operator's words. Optional facts are present
 *  exactly when the owners know them. */
export interface CoordinatorBoardSessionV1 {
  sessionId: string
  title: string
  state: string
  means: string
  /** Why it runs: the head of its first message (its brief). */
  brief?: string
  /** What it is doing right now (its transcript tail), and how long ago. */
  now?: string
  lastSpokeAgo?: string
  age?: string
  /** Absolute project folder the session works in. */
  project?: string
  /** A fork's branch, worktree path and commit state (forks only). */
  branch?: string
  worktree?: string
  commits?: string
  model?: string
  effort?: string
  workflowsAllowed?: true
  /** An open question on this row; permissionRef is the answerable ref
   *  (permission:<requestId>) when the question is a parked permission ask. */
  question?: string
  obligationId?: string
  permissionRef?: string
  /** Queued rows: why the launch waits, in plain words. */
  waits?: string
  pausedBy?: string
  stoppedBy?: string
  /** This terminal's own parked main session (the host row). */
  ownTerminal?: true
  /** The ★ carry-over: the focused chat belongs to THIS other project and
   *  rides the board only because the operator is inside it. */
  carriedFrom?: string
}

export interface CoordinatorFinishedForkV1 {
  title: string
  branch: string
  project: string
  worktree?: string
  commits?: string
  age?: string
}

/** A source a new session must gather work from — a fork (branch +
 *  worktree) or a session on the main checkout (no branch; its uncommitted
 *  work lives only in that checkout). */
export interface CoordinatorSourceV1 {
  title: string
  project: string
  branch?: string
  worktree?: string
  commits?: string
  age?: string
}

export interface CoordinatorBoardV1 {
  /** The repo the coordinator sits on (the harness ground). */
  ground?: string
  clock?: string
  counts: Record<string, number | string>
  sessions: CoordinatorBoardSessionV1[]
  /** The OTHER projects with activity (cross-project awareness, law 4):
   *  their sessions keep running and are not rows here — the coordinator
   *  can say "3 running in foo — switch to see them". */
  elsewhere?: Array<{ project: string; name: string; running: number; needsYou: number; finished: number }>
  /** Finished forks awaiting their merge (retained branch evidence). */
  finishedForks?: CoordinatorFinishedForkV1[]
  openObligations: Array<{
    obligationId: string
    sessionId: string
    question: string
    revision: number
    ref?: string
  }>
  /** Named when the projection could not be built whole. */
  degraded?: string
}

/** The state → plain-words table (the persona quotes these, never the
 *  lifecycle words themselves). One home: the coordinator input and the
 *  list_sessions tool both speak through it. */
export function describeSessionState(
  row: Pick<ConcourseRowV1, 'state' | 'nowLabel' | 'waitReason' | 'waitDetail'>,
  extras: { pausedBy?: string; stoppedBy?: string; ownTerminal?: boolean; retainedFork?: boolean; carriedFrom?: string } = {},
): string {
  if (extras.ownTerminal === true) return 'your own main session, with you in the terminal — not a background session; nothing to send here'
  // The ★ carry-over leads: the row is here because the operator is inside
  // it, not because it belongs to this project.
  const lead = extras.carriedFrom !== undefined ? `the focused chat, carried over from ${extras.carriedFrom} — ` : ''
  return lead + describeSessionStateBase(row, extras)
}

function describeSessionStateBase(
  row: Pick<ConcourseRowV1, 'state' | 'nowLabel' | 'waitReason' | 'waitDetail'>,
  extras: { pausedBy?: string; stoppedBy?: string; retainedFork?: boolean },
): string {
  switch (row.state) {
    case 'attached':
      return 'with you in the terminal, alive — you are inside it; a message to it holds until you leave it'
    case 'working':
      return 'working — mid-turn, alive'
    case 'ready-to-review':
      return extras.retainedFork === true
        ? 'finished fork, ready to merge — its runner is gone; the branch holds the work'
        : 'finished its last turn and is idle, alive — waiting on the next message'
    case 'needs-you':
      return 'waiting on you — an open question or permission ask blocks it'
    case 'starting':
      return 'no live runner right now — still spawning, or its runner died; a message or resume revives it in place'
    case 'queued':
      return `queued, not started — ${concourseWaitCopy(row.waitReason, row.waitDetail)}`
    case 'paused':
      return `paused${extras.pausedBy !== undefined ? ` by ${extras.pausedBy}` : ''} — alive; deliveries hold until resume`
    case 'stopped':
      return `stopped${extras.stoppedBy !== undefined ? ` by ${extras.stoppedBy}` : ''} — its runner ended on purpose; resume brings it back with its chat intact`
    case 'parked':
      return 'a parked chat of this project — no runner, not running, nothing to send here; the operator entering it brings it back with its chat intact'
    case 'elsewhere':
      return "another project's running count — a door on the board, not a session; nothing to send here"
    default:
      return row.state
  }
}

export interface CoordinatorBoardViewOpts {
  crewDir?: string
  recordsDir?: string
  nowMs?: number
  /** Proof seam: the ground without touching the seed store. */
  ground?: string
}

const MAX_FORK_PROBES = 8

export async function coordinatorBoardView(opts: CoordinatorBoardViewOpts = {}): Promise<CoordinatorBoardV1> {
  const nowMs = opts.nowMs ?? Date.now()
  const snap = await import('./concourseSnapshot.js')
  const ground = opts.ground ?? (await snap.resolveHarnessGround().catch(() => undefined))
  // THE ONE GROUND (the scoped-board law): the view's own ground IS the
  // board's project — un-forwarded, the snapshot re-resolved its own
  // (currentProject of the live cwd), so a view built for any OTHER ground
  // read zero rows: the project filter dropped every record as foreign
  // (the coordinator-blindness class; the board provers' exact red).
  let project: import('../../utils/bootCardFacts.js').ProjectIdentity | undefined
  if (ground !== undefined) {
    try {
      project = (await import('../../utils/bootCardFacts.js')).projectIdentity(ground)
    } catch {
      // an unreadable ground scopes nothing extra — the snapshot's own door decides
    }
  }
  let snapshot: Awaited<ReturnType<typeof snap.buildConcourseSnapshot>>
  try {
    snapshot = await snap.buildConcourseSnapshot({
      ...(opts.crewDir !== undefined ? { crewDir: opts.crewDir } : {}),
      ...(opts.recordsDir !== undefined ? { recordsDir: opts.recordsDir } : {}),
      ...(project !== undefined ? { project } : {}),
      nowMs,
    })
  } catch (err) {
    return {
      ...(ground !== undefined ? { ground } : {}),
      counts: {},
      sessions: [],
      openObligations: [],
      degraded: `the board could not be read — ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  let records: Record<string, ConcourseWorkerRecordV1> = {}
  try {
    const sup = await import('../../daemon/concourseSupervisor.js')
    records = sup.readSessionWorkers(opts.recordsDir)
  } catch {
    /* records are a projection — rows still speak */
  }
  const recordBySession = new Map<string, ConcourseWorkerRecordV1>()
  for (const rec of Object.values(records)) {
    if (rec.endedAt === undefined || !recordBySession.has(rec.sessionId)) recordBySession.set(rec.sessionId, rec)
  }
  // Commit-state probes share one bounded budget: a fork answers "N commits
  // ahead of main · dirt"; a main-checkout session answers its checkout's
  // dirt (its uncommitted work lives only there — a consolidator forked off
  // main cannot see it, so the brief must say so).
  let forkState: ((workspaceId: string, branch: string, worktree?: string) => string | undefined) | undefined
  let mainState: ((workspaceId: string) => string | undefined) | undefined
  try {
    const wt = await import('../../daemon/concourseWorktrees.js')
    let probes = 0
    const mainCache = new Map<string, string | undefined>()
    forkState = (workspaceId, branch, worktree) => {
      if (probes >= MAX_FORK_PROBES) return undefined
      probes += 1
      try {
        return wt.describeForkCommitState(wt.forkCommitState(workspaceId, branch, worktree))
      } catch {
        return undefined
      }
    }
    mainState = workspaceId => {
      if (mainCache.has(workspaceId)) return mainCache.get(workspaceId)
      let words: string | undefined
      if (probes < MAX_FORK_PROBES) {
        probes += 1
        try {
          if (wt.workspaceKindOf(workspaceId) === 'git') {
            const dirt = wt.classifyWorktreeDirt(workspaceId)
            words =
              dirt.kind === 'authored'
                ? `on the main checkout · uncommitted changes in ${dirt.files.length} file${dirt.files.length === 1 ? '' : 's'} there`
                : 'on the main checkout · working tree clean'
          } else {
            words = 'plain folder (no git)'
          }
        } catch {
          words = undefined
        }
      }
      mainCache.set(workspaceId, words)
      return words
    }
  } catch {
    forkState = undefined
    mainState = undefined
  }
  const questionBySession = new Map<string, (typeof snapshot.needsYou)[number]>()
  for (const q of snapshot.needsYou) if (!questionBySession.has(q.sessionId)) questionBySession.set(q.sessionId, q)
  // The obligations owner's own rows carry the revision the answer verbs
  // key on; the snapshot's needsYou is the painted projection of the same.
  let openObligations: CoordinatorBoardV1['openObligations'] = []
  let settledCount = 0
  try {
    const obligations = await import('../crew/obligations.js')
    const scope = { scope: 'switchboard' as const, ...(opts.crewDir !== undefined ? { dir: opts.crewDir } : {}) }
    const open = await obligations.openObligations(scope)
    const all = await obligations.listObligations(scope)
    settledCount = Math.max(0, all.length - open.length)
    openObligations = open.map(o => ({
      obligationId: o.obligationId,
      sessionId: o.sessionId,
      question: o.question,
      revision: o.revision,
      ...(o.ref !== undefined ? { ref: o.ref } : {}),
    }))
  } catch {
    openObligations = snapshot.needsYou.map(q => ({
      obligationId: q.obligationId,
      sessionId: q.sessionId,
      question: q.question,
      revision: 0,
      ...(q.ref !== undefined ? { ref: q.ref } : {}),
    }))
  }

  let hostSessionId: string | undefined
  try {
    const state = await import('../../bootstrap/state.js')
    hostSessionId = String(state.getSessionId())
  } catch {
    hostSessionId = undefined
  }
  // WHO acted, in the operator's words: the coordinator's own crew seat id
  // (cw-…) is an internal noun — it reads "the coordinator"; 'operator'
  // reads "you"; any other named seat stays as spoken.
  let coordinatorSeat: string | undefined
  try {
    const { coordinatorAgentId } = await import('./coordinatorIdentity.js')
    coordinatorSeat = await coordinatorAgentId(opts.crewDir !== undefined ? { dir: opts.crewDir } : undefined)
  } catch {
    coordinatorSeat = undefined
  }
  const whoOf = (by: string | undefined): string | undefined =>
    by === undefined ? undefined : by === coordinatorSeat || by === 'coordinator' ? 'the coordinator' : by === 'operator' ? 'you' : by

  const sessions: CoordinatorBoardSessionV1[] = []
  const finishedForks: CoordinatorFinishedForkV1[] = []
  const counts: Record<string, number> = {
    sessions: 0,
    live: 0,
    withYou: 0,
    working: 0,
    readyToReview: 0,
    needsYou: 0,
    starting: 0,
    queued: 0,
    paused: 0,
    stopped: 0,
    finishedForks: 0,
  }
  for (const group of snapshot.groups) {
    for (const row of group.rows) {
      // The "N older chats" line is a door on the board, never a session —
      // the coordinator's world holds sessions; the count rides beside them.
      if (row.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX)) {
        counts.olderChats = (counts.olderChats ?? 0) + (Number.parseInt(row.title, 10) || 0)
        continue
      }
      // A door row (another project's running count) is not a session —
      // it speaks through `elsewhere` below, never as a row to send to.
      if (row.door !== undefined) continue
      // A settled record still knows a retained fork's worktree, branch and
      // model; only liveness facts (activity, ownership) need a live one.
      const rec = recordBySession.get(row.sessionId)
      const liveRec = rec !== undefined && rec.endedAt === undefined ? rec : undefined
      const ownTerminal = hostSessionId !== undefined && row.sessionId === hostSessionId && liveRec === undefined
      const retainedFork = row.state === 'ready-to-review' && row.nowLabel === 'ready to merge' && liveRec === undefined
      const question = questionBySession.get(row.sessionId)
      const activity = liveRec !== undefined ? snap.tailActivity(liveRec) : null
      const brief = rec !== undefined ? snap.headBriefLabel(rec) : null
      const worktree = rec?.worktreePath
      const branch = row.worktreeBranch ?? rec?.branchName
      const project = row.workspaceDir ?? rec?.workspaceId
      const commits =
        branch !== undefined && project !== undefined && forkState !== undefined
          ? forkState(project, branch, worktree)
          : branch === undefined && project !== undefined && liveRec !== undefined && !ownTerminal && mainState !== undefined
            ? mainState(project)
            : undefined
      // A retained fork's board row is titled by its branch; the settled
      // record still knows the operator's title for it.
      const title = retainedFork && rec?.title !== undefined && rec.title.length > 0 ? rec.title : row.title
      const pausedBy = whoOf(rec?.pausedBy)
      const stoppedBy = whoOf(rec?.stoppedBy)
      const session: CoordinatorBoardSessionV1 = {
        sessionId: row.sessionId,
        title,
        state: row.state,
        means: describeSessionState(row, {
          ...(pausedBy !== undefined ? { pausedBy } : {}),
          ...(stoppedBy !== undefined ? { stoppedBy } : {}),
          ownTerminal,
          retainedFork,
          ...(row.foreignProject !== undefined ? { carriedFrom: row.foreignProject } : {}),
        }),
        ...(row.foreignProject !== undefined ? { carriedFrom: row.foreignProject } : {}),
        ...(brief !== null ? { brief } : {}),
        ...(activity !== null ? { now: activity.label } : row.nowLabel ? { now: row.nowLabel } : {}),
        ...(activity?.at !== undefined ? { lastSpokeAgo: snap.ageLabelOf(nowMs, activity.at) } : {}),
        ...(row.ageLabel !== null ? { age: row.ageLabel } : {}),
        ...(project !== undefined ? { project } : {}),
        ...(branch !== undefined ? { branch } : {}),
        ...(worktree !== undefined ? { worktree } : {}),
        ...(commits !== undefined ? { commits } : {}),
        ...(rec?.modelKey !== undefined ? { model: rec.modelKey } : {}),
        ...(rec?.effort !== undefined ? { effort: rec.effort } : {}),
        ...(row.workflowsAllowed === true ? { workflowsAllowed: true as const } : {}),
        ...(question !== undefined
          ? {
              question: question.question,
              obligationId: question.obligationId,
              ...(question.ref !== undefined && question.ref.startsWith('permission:') ? { permissionRef: question.ref } : {}),
            }
          : {}),
        ...(row.state === 'queued' ? { waits: concourseWaitCopy(row.waitReason, row.waitDetail) } : {}),
        ...(pausedBy !== undefined && row.state === 'paused' ? { pausedBy } : {}),
        ...(stoppedBy !== undefined && row.state === 'stopped' ? { stoppedBy } : {}),
        ...(ownTerminal ? { ownTerminal: true as const } : {}),
      }
      sessions.push(session)
      counts.sessions = (counts.sessions ?? 0) + 1
      switch (row.state) {
        case 'attached':
          counts.withYou = (counts.withYou ?? 0) + 1
          counts.live = (counts.live ?? 0) + 1
          break
        case 'working':
          counts.working = (counts.working ?? 0) + 1
          counts.live = (counts.live ?? 0) + 1
          break
        case 'ready-to-review':
          if (retainedFork) {
            counts.finishedForks = (counts.finishedForks ?? 0) + 1
            finishedForks.push({
              title,
              branch: branch ?? row.title,
              project: project ?? row.projectLabel,
              ...(worktree !== undefined ? { worktree } : {}),
              ...(commits !== undefined ? { commits } : {}),
              ...(row.ageLabel !== null ? { age: row.ageLabel } : {}),
            })
          } else {
            counts.readyToReview = (counts.readyToReview ?? 0) + 1
            counts.live = (counts.live ?? 0) + 1
          }
          break
        case 'needs-you':
          counts.needsYou = (counts.needsYou ?? 0) + 1
          counts.live = (counts.live ?? 0) + 1
          break
        case 'starting':
          counts.starting = (counts.starting ?? 0) + 1
          break
        case 'queued':
          counts.queued = (counts.queued ?? 0) + 1
          break
        case 'paused':
          counts.paused = (counts.paused ?? 0) + 1
          counts.live = (counts.live ?? 0) + 1
          break
        case 'stopped':
          counts.stopped = (counts.stopped ?? 0) + 1
          break
        case 'parked':
          counts.parked = (counts.parked ?? 0) + 1
          break
        default:
          break
      }
    }
  }
  counts.open = openObligations.length
  counts.settled = settledCount
  const elsewhere = (snapshot.elsewhere ?? []).map(p => ({ project: p.dir, name: p.name, running: p.running, needsYou: p.needsYou, finished: p.finished }))
  return {
    ...(ground !== undefined ? { ground } : {}),
    clock: snapshot.clock,
    counts,
    sessions,
    ...(elsewhere.length > 0 ? { elsewhere } : {}),
    ...(finishedForks.length > 0 ? { finishedForks } : {}),
    openObligations,
  }
}

/** Resolve a spoken source ("the parser session", a branch name, a session
 *  id, a title fragment) to board rows whose work a new session must be
 *  told about — used by launch_session's `sources` to name every branch,
 *  worktree and commit state in the brief (a session cannot see the board;
 *  what the brief does not name, it cannot find). */
export function resolveBoardSources(
  board: CoordinatorBoardV1,
  spoken: readonly string[],
): { named: CoordinatorSourceV1[]; unknown: string[] } {
  const named: CoordinatorSourceV1[] = []
  const unknown: string[] = []
  const seen = new Set<string>()
  const push = (f: CoordinatorSourceV1): void => {
    const key = `${f.project}::${f.branch ?? ''}::${f.worktree ?? ''}::${f.title}`
    if (seen.has(key)) return
    seen.add(key)
    named.push(f)
  }
  for (const raw of spoken) {
    const s = raw.trim().toLowerCase()
    if (s.length === 0) continue
    let hit = false
    for (const row of board.sessions) {
      if (row.ownTerminal === true) continue
      const matches =
        row.sessionId.toLowerCase() === s ||
        row.sessionId.toLowerCase().startsWith(s) ||
        row.title.toLowerCase() === s ||
        (s.length >= 4 && row.title.toLowerCase().includes(s)) ||
        (row.branch !== undefined && (row.branch.toLowerCase() === s || row.branch.toLowerCase().endsWith(`/${s}`)))
      if (!matches) continue
      hit = true
      push({
        title: row.title,
        project: row.project ?? '(project unknown)',
        ...(row.branch !== undefined ? { branch: row.branch } : {}),
        ...(row.worktree !== undefined ? { worktree: row.worktree } : {}),
        ...(row.commits !== undefined ? { commits: row.commits } : {}),
        ...(row.age !== undefined ? { age: row.age } : {}),
      })
    }
    for (const fork of board.finishedForks ?? []) {
      const matches =
        fork.branch.toLowerCase() === s ||
        fork.branch.toLowerCase().endsWith(`/${s}`) ||
        fork.title.toLowerCase() === s ||
        (s.length >= 4 && fork.title.toLowerCase().includes(s))
      if (!matches) continue
      hit = true
      push(fork)
    }
    if (!hit) unknown.push(raw)
  }
  return { named, unknown }
}

/** The consolidation appendix a launch brief carries when the operator
 *  asks a session to gather other sessions' work — plain, complete, and
 *  spelled from the board so the new session can find every branch, and
 *  honest about main-checkout work it cannot see from a fork. */
export function sourcesBriefBlock(named: readonly CoordinatorSourceV1[]): string {
  const lines = named.map(f => {
    const parts =
      f.branch !== undefined
        ? [`"${f.title}" — branch ${f.branch} in ${f.project}`, ...(f.worktree !== undefined ? [`worktree ${f.worktree}`] : [])]
        : [`"${f.title}" — works directly on the main checkout at ${f.project} (no stamp branch; its uncommitted changes live only in that checkout)`]
    if (f.commits !== undefined) parts.push(f.commits)
    return `- ${parts.join(' · ')}`
  })
  const anyMain = named.some(f => f.branch === undefined)
  return [
    'Work to consolidate (from the switchboard board — these are the exact branches and worktrees; the sessions that made them are not in your chat):',
    ...lines,
    `Uncommitted changes live only in the named worktree; committed work is on the named branch.${anyMain ? ' Work on the main checkout is visible only in that checkout — read it by absolute path, or ask for it to be committed first.' : ''} Merge into this checkout’s main line, verify before merging, resolve conflicts thoughtfully.`,
  ].join('\n')
}
