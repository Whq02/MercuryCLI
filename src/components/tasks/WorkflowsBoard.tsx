// WorkflowsBoard — the /workflows LIVE run board (board → run → agent).
//
// Three sections: Active (AppState local_workflow tasks, status running) ·
// Recent (same source, any other status — terminal-ish, not yet evicted) ·
// Past (run.json manifests under <cwd>/.mercury/workflows/runs/, deduped
// against Active/Recent by runId). Each view — board/run/agent — FULLY
// REPLACES the previous one (the SpecimenGallery `open !== null → <C/>`
// pattern) rather than nesting, so only ONE useNavigablePanes instance is ever
// live at a time (see RunDetailPane.tsx's header comment).
//
// SURFACE (operator directive — the compat dynamic-workflows floor,
// elevated in the warm-ink language):
//   · the run list carries a per-run PHASE-DOT strip (settled ● TEAL ·
//     in-flight ◐ AMBER · error ✕ · pending ○) + settled/total, agents
//     done/total, a `◈ 29.7k` compact token rollup (GLYPH.tokens vocabulary)
//     and an honest right-aligned Time column (running → ticking elapsed ·
//     settled → total runtime · stale/wedged → LAST-KNOWN runtime from the
//     manifest heartbeat, never a forever-growing fabrication);
//   · genuinely-running-HERE rows rotate their status glyph (WorkingGlyph —
//     the one motion grammar; captures pin MERCURY_LIVE_GLYPHS=0 ⇒ static ◐);
//     external/wedged rows stay static AMBER ⦿ — motion is never lent to work
//     this process can't attest;
//   · a STANDING side info pane (NavigablePanes' additive sideInfo slot —
//     the drilled detail can never render here because onActivate replaces
//     the view) mirrors the run shell's header grammar: name in bold accent,
//     description, state + runtime, fact grid, then a numbered "Phases" rail
//     (❯ cursor on the in-flight phase) with per-agent machine-head chips
//     (✧ tinted agentHeadAt(index).hue — each agent keeps a stable hue);
//   · the header row right-aligns a LIVE rollup (`◐ 1 running · 0/3 agents ·
//     28s`) while anything runs — workflowRollup.ts owns that grammar, shared
//     with the inline WorkflowRunningIndicator rows.
//
// Controls: kill/pause only ever render on an AppState-tracked ACTIVE row —
// a Past (disk-only) row has no in-process AbortController to signal and no
// notified-latch to re-arm, so `x`/`p` never appear there (by design;
// skip/retry live one level down, in RunDetailPane, gated the same way).
// `R` resume-queue covers Recent AND recoverable disk rows (paused rows land
// there); `S` save arms only when the run's script is actually recoverable
// (live task.script, or the run dir's persisted workflow.js on disk) and
// writes it into <cwd>/.mercury/workflows/ for by-name reuse — never
// overwriting an existing file (the no-data-loss floor).

import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DeepImmutable } from 'src/types/utils.js'
import { Box, Text } from '../../ink.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import {
  buildResumePrompt,
  isLocalWorkflowTask,
  killWorkflowTask,
  pauseWorkflowTask,
  type LocalWorkflowTaskState,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import {
  diskResumability,
  isRunOrphaned,
  listWorkflowRunsDetailed,
  partitionDiskRuns,
  type WorkflowRunManifest,
} from '../../tools/WorkflowTool/runManifest.js'
import { saveWorkflowSourceToProject } from '../../tools/WorkflowTool/registry.js'
import type { WorkRowV1 } from '../../services/engine-connector/types.js'
import {
  focusedRunnerPresence,
  focusedSessionIdOrNull,
  otherSessionRunnerPids,
  useFocusedWorkRoster,
} from './useFocusedWork.js'
import { useFocusedWorkspaceCwd } from '../../hooks/useFocusedWorkspaceCwd.js'
import { formatDuration, formatTokens } from '../../utils/format.js'
import { mintIntentId, submitDispatch } from '../../services/attention/actions.js'
import {
  KeyValueGrid,
  SectionHeader,
  StateBadge,
  useNowTick,
  type KVRow,
} from '../mercury-ui/components.js'
import { GLYPH, truncateToWidth } from '../mercury-ui/glyphs.js'
import { WorkingGlyph } from '../mercury-ui/LiveGlyphs.js'
import {
  NavigablePanes,
  type ColumnDef,
  type SectionDef,
} from '../mercury-ui/NavigablePanes.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { STATE_STYLE, type SnapshotState } from '../mercury-ui/theme.js'
import { agentHeadAt } from '../../utils/cockpit/agentHeadData.js'
import { AgentInspectorPane } from './AgentInspectorPane.js'
import { RunDetailPane } from './RunDetailPane.js'
import { groupByPhase, pidAlive, settledCount } from './RunDetailPane.js'
import { agentSnapshotState, buildTree, statusTone } from './WorkflowDetailDialog.js'
import type { AgentNode } from './WorkflowDetailDialog.js'
import { agentsDoneOf, phaseTone, workflowRollupLine } from './workflowRollup.js'

// Disk manifests are re-listed on this cadence while the board is open (a
// plain readdir + small JSON reads — cheap — so a run that finished in
// another process, or evicted out of THIS process's AppState, appears in
// Past without requiring the operator to close and reopen /workflows).
const PAST_POLL_MS = 5_000

/** Unchanged-sweep equality: the poll re-lists every 5s, and a
 *  directory nothing touched must produce NO state write — runId + mtimeMs
 *  (the writer's change signal) + status identify a row's content. Exported
 *  for the production-seam prover. */
export function sameRunListing(
  prev: ReadonlyArray<Pick<WorkflowRunManifest, 'runId' | 'status'> & { mtimeMs: number }>,
  next: ReadonlyArray<Pick<WorkflowRunManifest, 'runId' | 'status'> & { mtimeMs: number }>,
): boolean {
  if (prev.length !== next.length) return false
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i]!
    const b = next[i]!
    if (a.runId !== b.runId || a.mtimeMs !== b.mtimeMs || a.status !== b.status) {
      return false
    }
  }
  return true
}

/**
 * The guarded Past-runs loader. The bare 5s interval would otherwise fire
 * listWorkflowRuns unguarded: a slow scan could overlap the next tick and
 * resolve AFTER a newer one, replacing fresher state with staler state.
 * Single-flight (an in-flight scan skips the tick) plus a generation stamp
 * (belt-and-braces should single-flight ever be relaxed) plus a dispose
 * guard (no apply after unmount). Exported for the production-seam prover.
 */
export function createPastRunsLoader<T>(deps: {
  list: () => Promise<T>
  apply: (result: T) => void
}): { load: () => void; dispose: () => void } {
  let alive = true
  let generation = 0
  let inFlight = false
  return {
    load(): void {
      if (!alive || inFlight) return
      inFlight = true
      const gen = ++generation
      deps.list().then(
        result => {
          inFlight = false
          if (!alive || gen !== generation) return
          deps.apply(result)
        },
        () => {
          inFlight = false
        },
      )
    },
    dispose(): void {
      alive = false
    },
  }
}

// St column abbreviations (width 8: glyph + space + word must fit). Every
// other status word (done/paused/failed/killed/stale) is already <=6 chars
// and fits; only 'running'/'pending' need shortening to avoid a mid-word clip.
const SHORT_STATE_WORD: Record<string, string> = { running: 'run', pending: 'wait' }

// Phase-dot strip cap: ≤4 phases render one dot each; more collapse to the
// settled/total count alone (the strip must fit the fixed Phases column).
const MAX_PHASE_DOTS = 4
// Side-pane rail caps (the pane scrolls, but a fanned-out phase should fold).
const MAX_INFO_AGENTS_PER_PHASE = 3

function headerStateFor(status: string, orphaned: boolean): SnapshotState {
  if (orphaned) return 'failed'
  switch (status) {
    case 'completed':
      return 'live'
    case 'failed':
    case 'killed':
      return 'failed'
    case 'running':
      return 'gated'
    default:
      return 'off'
  }
}

type RunSection = 'active' | 'recent' | 'external' | 'past'

/** The minimal phase→agents projection the board's strip + rail render from
 *  (both buildTree's AgentNode and the manifest's agent summaries satisfy it). */
type InfoPhase = {
  title: string
  planned: boolean
  agents: { index: number; label: string; state: AgentNode['state'] }[]
}

type RunFacts = {
  name: string
  state: SnapshotState
  word: string
  phaseSettled: number
  phaseTotal: number
  groups: InfoPhase[]
  agentCount: number
  agentsDone: number
  totalTokens: number
  startTime: number
  /** Honest runtime clock end: endTime when settled; the manifest heartbeat
   *  (mtime) when stale/wedged — a dead run's clock must not keep growing. */
  clockEnd?: number
  desc?: string
  model?: string
  error?: string
  scriptPath?: string
  args?: unknown
  /** Live rows only: the in-memory script source (the `S save` primary path). */
  script?: string
  /** Disk rows only: the run dir (S falls back to its persisted workflow.js). */
  runDir?: string
  /** External rows only: the owning process + its liveness word. */
  owner?: { pid: number; word: string }
  /** Roster rows only: permission asks parked on the run in its runner. */
  pendingAsks?: number
}

type RunRow = {
  runId: string
  section: RunSection
  taskId?: string
  task?: DeepImmutable<LocalWorkflowTaskState>
  manifest?: WorkflowRunManifest & { mtimeMs: number }
  facts: RunFacts
}

function factsForTask(t: DeepImmutable<LocalWorkflowTaskState>): RunFacts {
  const tree = buildTree(t)
  const tone = statusTone(t.status)
  const name = t.workflowName ?? t.title ?? t.summary ?? t.description ?? 'Dynamic workflow'
  const d = t.summary ?? t.description
  return {
    name,
    state: headerStateFor(t.status, false),
    word: SHORT_STATE_WORD[tone.word] ?? tone.word,
    phaseSettled: settledCount(tree),
    phaseTotal: tree.length,
    groups: tree.map(g => ({
      title: g.title,
      planned: g.planned,
      agents: g.agents.map(a => ({ index: a.index, label: a.label, state: a.state })),
    })),
    agentCount: t.agentCount,
    agentsDone: agentsDoneOf(tree.flatMap(g => g.agents)),
    totalTokens: t.totalTokens,
    startTime: t.startTime,
    clockEnd: t.endTime,
    desc: d && d !== name ? d : undefined,
    model: t.defaultModel,
    error: t.error,
    scriptPath: t.scriptPath,
    args: t.args,
    script: t.script,
  }
}

/** The wire state's total narrowing — a newer runner's unknown word mutes
 *  (never impersonates in-flight). */
function narrowAgentState(state: string): AgentNode['state'] {
  switch (state) {
    case 'start':
    case 'progress':
    case 'done':
    case 'error':
    case 'stopped':
    case 'skipped':
      return state
    default:
      return 'stopped'
  }
}

/**
 * Facts for a FOCUSED-SESSION roster row (the session's runner's own work,
 * fed over the connector). The run's disk manifest, when the sweep has it,
 * lends the recovery fields (runDir for S save, the resume probe's target)
 * — the render facts themselves come from the roster. A row whose runner
 * is not live any more never claims motion: its word mutes to 'stale' and
 * its clock freezes at the manifest's heartbeat.
 */
function factsForWorkRow(
  w: WorkRowV1,
  manifest: (WorkflowRunManifest & { mtimeMs: number }) | undefined,
  runnerLive: boolean,
): RunFacts {
  const groups: InfoPhase[] = (w.phases ?? []).map(p => ({
    title: p.title,
    planned: p.planned,
    agents: p.agents.map(a => ({ index: a.index, label: a.label, state: narrowAgentState(a.state) })),
  }))
  const flatAgents = groups.flatMap(g => g.agents)
  const tone = statusTone(w.status as Parameters<typeof statusTone>[0])
  const running = w.status === 'running' || w.status === 'pending'
  const stale = running && !runnerLive
  return {
    name: w.name,
    state: stale ? 'failed' : headerStateFor(w.status, false),
    word: stale ? 'stale' : (SHORT_STATE_WORD[tone.word] ?? tone.word),
    phaseSettled: settledCount(groups),
    phaseTotal: groups.length,
    groups,
    agentCount: w.agentCount ?? flatAgents.length,
    agentsDone: agentsDoneOf(flatAgents),
    totalTokens: w.totalTokens ?? 0,
    startTime: w.startTime,
    clockEnd: w.endTime ?? (stale ? manifest?.mtimeMs : undefined),
    desc: w.description,
    model: w.model,
    error: w.error,
    scriptPath: manifest?.scriptPath,
    runDir: manifest?.runDir,
    pendingAsks: w.pendingAsks,
  }
}

function factsForManifest(m: WorkflowRunManifest & { mtimeMs: number }): RunFacts {
  const orphaned = isRunOrphaned(m, m.mtimeMs, Date.now(), pidAlive)
  const groups = groupByPhase(m.phases, m.agents)
  const tone = statusTone(m.status)
  const name = m.workflowName ?? m.title ?? m.description ?? 'Dynamic workflow'
  return {
    name,
    state: headerStateFor(m.status, orphaned),
    word: orphaned ? 'stale' : (SHORT_STATE_WORD[tone.word] ?? tone.word),
    phaseSettled: settledCount(groups),
    phaseTotal: groups.length,
    groups: groups.map(g => ({
      title: g.title,
      planned: g.planned,
      agents: g.agents.map(a => ({ index: a.index, label: a.label, state: a.state })),
    })),
    agentCount: m.agentCount,
    agentsDone: agentsDoneOf(m.agents),
    totalTokens: m.totalTokens,
    startTime: m.startTime,
    // A stale (orphaned) claims-running manifest's honest runtime is what the
    // heartbeat last attested — endTime when it settled, else the mtime.
    clockEnd: m.endTime ?? (orphaned ? m.mtimeMs : undefined),
    desc: m.description && m.description !== name ? m.description : undefined,
    error: m.error,
    scriptPath: m.scriptPath,
    args: m.args,
    runDir: m.runDir,
  }
}

function Unavailable(): React.ReactNode {
  return <Text color={STATE_STYLE.unavailable.color}>{STATE_STYLE.unavailable.glyph}</Text>
}

// Phase-dot strip + settled/total (the "more sophisticated than a % bar"
// treatment): one toned dot per phase, speaking the exact PhaseBlock tone
// table via workflowRollup.phaseTone. >MAX_PHASE_DOTS phases collapse to the
// count alone so the fixed column never overflows.
function PhaseStrip({ facts }: { facts: RunFacts }): React.ReactNode {
  const tokens = useMercuryTokens()
  const count = (
    <Text color={tokens.textMuted}>
      {facts.phaseSettled}/{facts.phaseTotal}
    </Text>
  )
  if (facts.phaseTotal === 0) return <Unavailable />
  if (facts.phaseTotal > MAX_PHASE_DOTS) return count
  return (
    <Text>
      {facts.groups.map((g, i) => {
        const tone = phaseTone(g)
        const dot =
          tone === 'settled' ? (
            <Text color={tokens.success}>{GLYPH.done}</Text>
          ) : tone === 'active' ? (
            <Text color={tokens.warning}>{GLYPH.inProgress}</Text>
          ) : tone === 'error' ? (
            <Text color={tokens.failure}>{GLYPH.fail}</Text>
          ) : (
            <Text color={tokens.textMuted}>{GLYPH.pending}</Text>
          )
        return <React.Fragment key={i}>{dot}</React.Fragment>
      })}
      <Text> </Text>
      {count}
    </Text>
  )
}

// The standing side pane — the run shell's header grammar in miniature (the
// header floor: NAME bold accent · description · state + runtime · facts), then the
// numbered Phases rail (❯ cursor on the in-flight phase) with per-agent
// machine-head chips (✧ in agentHeadAt(index).hue — a stable per-agent
// identity, mirroring the party board's lane hues).
// Disk-resume eligibility for a Past row — the pure core (runManifest.ts)
// with the board's real fs/pid deps.
function probeDiskResumability(
  m: WorkflowRunManifest & { mtimeMs: number },
): ReturnType<typeof diskResumability> {
  return diskResumability(m, {
    pidAlive,
    fileExists: existsSync,
    readFileText: (p: string): string | undefined => {
      try {
        return readFileSync(p, 'utf8')
      } catch {
        return undefined
      }
    },
    sha256: (text: string) => createHash('sha256').update(text).digest('hex'),
  })
}

// the info pane + the R-action `when:` predicate run in the
// RENDER path of a board that re-renders on useNowTick — unmemoized, the
// sync fs + pid probes re-fired every second while a Past row was selected.
// The loader mints fresh manifest objects each PAST_POLL_MS reload, so a
// WeakMap keyed on the manifest object gives at-most-one probe per row per
// poll cycle with zero invalidation logic. The R action's run() body keeps
// probing FRESH at the keypress (a one-shot at decision time).
const resumabilityByManifest = new WeakMap<
  WorkflowRunManifest & { mtimeMs: number },
  ReturnType<typeof diskResumability>
>()
function boardDiskResumability(
  m: WorkflowRunManifest & { mtimeMs: number },
): ReturnType<typeof diskResumability> {
  const hit = resumabilityByManifest.get(m)
  if (hit) return hit
  const res = probeDiskResumability(m)
  resumabilityByManifest.set(m, res)
  return res
}

function RunInfoPane({ row, now }: { row: RunRow; now: number }): React.ReactNode {
  const tokens = useMercuryTokens()
  const accent = tokens.accent
  const f = row.facts
  const runtime = formatDuration(Math.max(0, (f.clockEnd ?? now) - f.startTime))
  const kv: KVRow[] = [
    { k: 'run', v: truncateToWidth(row.runId, 25), tone: tokens.textPrimary },
    {
      k: 'agents',
      v: f.agentCount > 0 ? `${f.agentsDone}/${f.agentCount} done` : '—',
      tone: f.agentCount > 0 ? tokens.textPrimary : tokens.textMuted,
    },
    {
      k: 'tokens',
      v: f.totalTokens > 0 ? `${GLYPH.tokens} ${formatTokens(f.totalTokens)}` : '—',
      tone: f.totalTokens > 0 ? tokens.textPrimary : tokens.textMuted,
    },
  ]
  if (f.model) kv.push({ k: 'model', v: f.model, tone: tokens.textPrimary })
  kv.push({ k: 'started', v: `${formatDuration(now - f.startTime)} ago`, tone: tokens.textMuted })
  if (f.owner) kv.push({ k: 'owner', v: `pid ${f.owner.pid}`, tone: tokens.textMuted, note: f.owner.word })

  // The ❯ cursor sits on the first in-flight phase; a still-running run with
  // nothing in flight points at the next pending phase. Settled runs carry no
  // cursor (nothing is "current" — honest).
  const running = f.word === 'run' || f.word === 'wait'
  let cursorIdx = f.groups.findIndex(g => phaseTone(g) === 'active')
  if (cursorIdx < 0 && running) cursorIdx = f.groups.findIndex(g => phaseTone(g) === 'pending')

  return (
    <Box flexDirection="column">
      <Text bold color={accent} wrap="truncate-end">
        {f.name}
      </Text>
      {f.desc ? (
        <Text color={tokens.textMuted} wrap="truncate-end">
          {f.desc}
        </Text>
      ) : null}
      <Text>
        <StateBadge state={f.state} label={f.word} />
        <Text color={tokens.textMuted}> · {runtime}</Text>
      </Text>
      {f.error ? (
        <Text color={tokens.failure} wrap="truncate-end">
          {f.error}
        </Text>
      ) : null}
      {(f.pendingAsks ?? 0) > 0 ? (
        <Text color={tokens.warning} wrap="truncate-end">
          {f.pendingAsks} ask{f.pendingAsks === 1 ? '' : 's'} waiting — a answers
        </Text>
      ) : null}
      {row.section === 'past' && row.manifest ? (
        (() => {
          const res = boardDiskResumability(row.manifest)
          return res.ok ? (
            <Text color={tokens.success} wrap="truncate-end">R resumes from disk — script + args recovered</Text>
          ) : (
            <Text color={tokens.textMuted} wrap="wrap">no resume: {res.reason}</Text>
          )
        })()
      ) : null}
      <Box marginTop={1}>
        <KeyValueGrid rows={kv} keyWidth={8} />
      </Box>
      {f.groups.length > 0 ? (
        <Box flexDirection="column">
          <SectionHeader>Phases</SectionHeader>
          {f.groups.map((g, i) => {
            const on = i === cursorIdx
            const shown = g.agents.slice(0, MAX_INFO_AGENTS_PER_PHASE)
            const hidden = g.agents.length - shown.length
            return (
              <Box key={i} flexDirection="column">
                <Text>
                  <Text color={on ? accent : tokens.textMuted}>{on ? `${GLYPH.prompt} ` : '  '}</Text>
                  <Text color={tokens.textMuted}>{i + 1} </Text>
                  <Text color={g.planned ? tokens.textSecondary : tokens.textPrimary}>{truncateToWidth(g.title, 18)}</Text>
                  {g.agents.length > 0 ? (
                    <Text color={tokens.textMuted}>
                      {' '}
                      {agentsDoneOf(g.agents)}/{g.agents.length}
                    </Text>
                  ) : g.planned ? (
                    <Text color={tokens.textSecondary}> · planned</Text>
                  ) : null}
                </Text>
                {shown.map(a => {
                  // The ONE taxonomy mapping (WorkflowDetailDialog) — stopped/
                  // skipped mute instead of impersonating in-flight amber.
                  const s = STATE_STYLE[agentSnapshotState(a.state)]
                  return (
                    <Text key={a.index}>
                      <Text color={agentHeadAt(a.index).hue}>{`   ${GLYPH.sparkFaint} `}</Text>
                      <Text color={a.state === 'done' ? tokens.textPrimary : tokens.textSecondary}>
                        {truncateToWidth(a.label, 16)}
                      </Text>
                      <Text color={s.color}> {s.glyph}</Text>
                    </Text>
                  )
                })}
                {hidden > 0 ? <Text color={tokens.textMuted}>{`     +${hidden} more`}</Text> : null}
              </Box>
            )
          })}
        </Box>
      ) : null}
    </Box>
  )
}

type ViewState =
  | { view: 'board' }
  | { view: 'run'; runId: string; taskId?: string }
  | { view: 'agent'; runId: string; taskId?: string; agentIndex: number }

export function WorkflowsBoard({ onClose }: { onClose: () => void }): React.ReactNode {
  const tokens = useMercuryTokens()
  const tasks = useAppState(s => s.tasks)
  const setAppState = useSetAppState()
  // The FOCUSED SESSION's board: its runner's roster feeds Active/Recent,
  // and the disk sweep scopes to ITS workspace (the session's history) —
  // never to the screen's own boot cwd (the work-scope law).
  const roster = useFocusedWorkRoster()
  const cwd = useFocusedWorkspaceCwd()
  const [pastRuns, setPastRuns] = useState<Array<WorkflowRunManifest & { mtimeMs: number }>>([])
  const [pastLoaded, setPastLoaded] = useState(false)
  // I/O-degraded sweeps: a non-zero count means the listing is
  // PARTIAL and the Past section says so instead of presenting the remainder
  // as the whole.
  const [unreadableRuns, setUnreadableRuns] = useState(0)
  const [view, setView] = useState<ViewState>({ view: 'board' })

  // Row derivation ONCE per data change: factsForManifest runs
  // a pidAlive probe per row, and doing this in the render body meant the 1s
  // clock tick re-probed every historical run every second (11k syscalls/s
  // at 10k runs). Liveness words refresh when the poll or the task store
  // moves — bounded staleness of one poll period, exactly the cadence the
  // values actually change on.
  const derivedRows = React.useMemo(() => {
    const workflows = Object.values(tasks ?? {}).filter(
      isLocalWorkflowTask,
    ) as DeepImmutable<LocalWorkflowTaskState>[]
    const activeTasks = workflows.filter(t => t.status === 'running')
    const recentTasks = workflows.filter(t => t.status !== 'running')
    // The focused session's roster rows (its runner's own workflows). The
    // runner-presence read rides this memo's cadence (the poll / the store)
    // — a dormant session's claims-running rows mute to 'stale' instead of
    // impersonating motion, and the revive vocabulary speaks below.
    const rosterWorkflows = roster.rows.filter(w => w.kind === 'workflow')
    const presence = focusedRunnerPresence()
    const runnerLive = presence !== 'dormant'
    const diskByRunId = new Map(pastRuns.map(m => [m.runId, m] as const))
    const rosterActive = rosterWorkflows.filter(
      w => w.status === 'running' || w.status === 'pending',
    )
    const rosterRecent = rosterWorkflows.filter(
      w => w.status !== 'running' && w.status !== 'pending',
    )
    const liveRunIds = new Set([
      ...workflows.map(t => t.workflowRunId).filter((id): id is string => !!id),
      ...rosterWorkflows.map(w => w.workflowRunId).filter((id): id is string => !!id),
    ])
    // Cross-process honesty (trust-cockpit): a claims-running manifest owned
    // by ANOTHER live process is EXTERNAL — running elsewhere ('run') or hung
    // elsewhere ('wedged') — never quietly filed under Past while executing.
    const derivedAt = Date.now()
    const { external, past: diskPast } = partitionDiskRuns(
      pastRuns,
      liveRunIds,
      derivedAt,
      pidAlive,
    )
    // THE LEAK FILTER (the work-scope law): a claims-running manifest owned
    // by ANOTHER concourse session's live runner is THAT session's work — it
    // paints under that session's board and chip, never under this one. A
    // foreign live pid (a Mercury outside this concourse) stays External.
    const otherPids = otherSessionRunnerPids(focusedSessionIdOrNull())
    const externalKept = external.filter(m => !otherPids.has(m.ownerPid))
    const rosterRow = (w: WorkRowV1, section: RunSection): RunRow => {
      const manifest = w.workflowRunId !== undefined ? diskByRunId.get(w.workflowRunId) : undefined
      return {
        runId: w.workflowRunId ?? w.id,
        section,
        manifest,
        facts: factsForWorkRow(w, manifest, runnerLive),
      }
    }
    const activeRows: RunRow[] = [
      ...activeTasks.map(t => ({
        runId: t.workflowRunId,
        section: 'active' as const,
        taskId: t.id,
        task: t,
        facts: factsForTask(t),
      })),
      ...rosterActive.map(w => rosterRow(w, 'active')),
    ]
    const recentRows: RunRow[] = [
      ...recentTasks.map(t => ({
        runId: t.workflowRunId,
        section: 'recent' as const,
        taskId: t.id,
        task: t,
        facts: factsForTask(t),
      })),
      ...rosterRecent.map(w => rosterRow(w, 'recent')),
    ]
    const externalRows: RunRow[] = externalKept.map(m => ({
      runId: m.runId,
      section: 'external',
      manifest: m,
      facts: {
        ...factsForManifest(m),
        // liveness overrides the manifest's self-claimed word: 'run' when the
        // heartbeat is fresh, 'wedged' when it stopped but the owner pid lives
        // (a hung engine must not impersonate a healthy run). Both ride the
        // AMBER 'gated' spine state — running-not-here / suspect, never TEAL.
        state: 'gated' as SnapshotState,
        word: m.liveness === 'wedged' ? 'wedged' : 'run',
        // A wedged run's clock honestly freezes at its last heartbeat.
        clockEnd: m.liveness === 'wedged' ? m.mtimeMs : undefined,
        // The liveness WORD rides the St badge (run/wedged); the owner row just
        // locates the process — 'alive · silent' = pid alive, heartbeat silent.
        owner: {
          pid: m.ownerPid,
          word: m.liveness === 'wedged' ? 'alive · silent' : 'elsewhere',
        },
      },
    }))
    const pastRows: RunRow[] = diskPast.map(m => ({
      runId: m.runId,
      section: 'past',
      manifest: m,
      facts: factsForManifest(m),
    }))
    return {
      activeRows,
      recentRows,
      externalRows,
      pastRows,
      presence,
      totalRows:
        activeRows.length + recentRows.length + externalRows.length + pastRows.length,
    }
  }, [tasks, pastRuns, roster])
  const { activeRows, recentRows, externalRows, pastRows, presence, totalRows } = derivedRows

  // 1s wall-clock tick so the Time column/detail tick instead of freezing at
  // the last state change (trust-cockpit W2a). Hoisted above the run/agent
  // early-returns — hooks must run unconditionally. PARKED when nothing is in
  // motion: a board of entirely settled runs must not commit at
  // 1 Hz forever — the RunDetailPane/AgentInspectorPane precedent.
  const boardHasMotion = activeRows.length > 0 || externalRows.length > 0
  const now = useNowTick(boardHasMotion ? 1000 : null)
  // Action feedback + dedupe:
  // both rowActions were fire-and-forget and the queued resume once drained
  // only after the board closed, so the operator saw nothing and pressed R
  // again, dispatching duplicates. Resumes ride the delivery door and start
  // beneath the open board; the dedupe set still guards double-R.
  // Hoisted above the early-returns like every hook here.
  const [actionNote, setActionNote] = useState<string | null>(null)
  // the embedded scoped dispatch composer (the same slot the
  // workbench board wires — ONE panes-grammar seam). Its draft never touches
  // the main composer; receipts land in the actionNote line; words ride the
  // delivery door and the session reads them at its next readable moment.
  const [dispatchOpen, setDispatchOpen] = useState(false)
  const [dispatchDraft, setDispatchDraft] = useState('')
  const handleDispatchInput = (input: string, key: Record<string, boolean>): void => {
    if (key.return) {
      const draft = dispatchDraft
      void (async () => {
        const r = await submitDispatch({
          intentId: mintIntentId(),
          kind: 'board-dispatch',
          value: draft,
        })
        if (r.kind === 'dispatch-accepted') {
          // The delivery law: the session HAS the words — it reads them at
          // its next step; the board needs no close.
          setActionNote('sent to the session — it reads them at its next step')
        } else {
          setActionNote(`dispatch refused — ${r.reason}`)
        }
      })()
      setDispatchDraft('')
      setDispatchOpen(false)
      return
    }
    if (key.backspace || key.delete) {
      setDispatchDraft(d => d.slice(0, -1))
      return
    }
    if (input && !key.ctrl && !key.meta && input !== '\t') setDispatchDraft(d => d + input)
  }
  const queuedResumes = useRef<Set<string>>(new Set())
  // Carry-back (slice F leftover): the row the operator inspected. The board
  // component stays mounted across board→run→agent (only the pane subtree
  // swaps), so on the way back NavigablePanes re-mounts seeded on this key
  // instead of dumping the cursor at row 0 of a long Recent list.
  const lastActivatedKey = useRef<string | undefined>(undefined)

  const onBoard = view.view === 'board'
  useEffect(() => {
    // Suspended beneath nested views: the run/agent panes read
    // a settled or externally-owned manifest — re-sweeping the disk and
    // re-rendering the subtree every 5s beneath the operator's reading
    // position informed nothing. Returning to the board re-arms the effect
    // and loads immediately.
    if (!onBoard) return
    // Guarded: single-flight + generation stamp + dispose — a
    // slow scan can neither overlap the next tick nor land stale over a
    // fresher result; unchanged runs come from the mtime parse-cache.
    const loader = createPastRunsLoader({
      list: () => listWorkflowRunsDetailed(cwd),
      apply: listing => {
        // Unchanged sweep ⇒ no state write: keeping the prior
        // array identity means React bails and nothing repaints.
        setPastRuns(prev => (sameRunListing(prev, listing.rows) ? prev : listing.rows))
        setUnreadableRuns(listing.unreadable)
        setPastLoaded(true)
      },
    })
    loader.load()
    const t = setInterval(loader.load, PAST_POLL_MS)
    return () => {
      loader.dispose()
      clearInterval(t)
    }
  }, [cwd, onBoard])

  if (view.view === 'run') {
    return (
      <RunDetailPane
        runId={view.runId}
        task={
          view.taskId
            ? (tasks[view.taskId] as DeepImmutable<LocalWorkflowTaskState> | undefined)
            : undefined
        }
        manifest={pastRuns.find(m => m.runId === view.runId)}
        onBack={() => setView({ view: 'board' })}
        onOpenAgent={agentIndex =>
          setView({ view: 'agent', runId: view.runId, taskId: view.taskId, agentIndex })
        }
      />
    )
  }
  if (view.view === 'agent') {
    return (
      <AgentInspectorPane
        runId={view.runId}
        task={
          view.taskId
            ? (tasks[view.taskId] as DeepImmutable<LocalWorkflowTaskState> | undefined)
            : undefined
        }
        manifest={pastRuns.find(m => m.runId === view.runId)}
        agentIndex={view.agentIndex}
        onBack={() => setView({ view: 'run', runId: view.runId, taskId: view.taskId })}
      />
    )
  }

  const columns: ColumnDef<RunRow>[] = [
    {
      key: 'name',
      header: 'Workflow',
      cell: r => (
        <Text color={tokens.textPrimary} wrap="truncate-end">
          {r.facts.name}
        </Text>
      ),
    },
    {
      key: 'status',
      header: 'St',
      width: 8,
      // A genuinely-running-HERE row rotates (WorkingGlyph — state-true motion,
      // TEAL like every running task chip; frame 0 / pinned captures = static
      // ◐). Everything else keeps the honest StateBadge: external/wedged stay
      // static AMBER ⦿ — this process can't attest another engine's motion.
      cell: r =>
        r.section === 'active' && r.facts.word !== 'stale' ? (
          <Text>
            <WorkingGlyph color={tokens.success} active />
            <Text color={tokens.success}> {r.facts.word}</Text>
          </Text>
        ) : (
          <StateBadge state={r.facts.state} label={r.facts.word} />
        ),
    },
    {
      key: 'phase',
      header: 'Phases',
      width: 9,
      cell: r => <PhaseStrip facts={r.facts} />,
    },
    {
      key: 'agents',
      header: 'Ag',
      width: 6,
      align: 'right',
      cell: r =>
        r.facts.agentCount > 0 ? (
          <Text>
            <Text color={r.facts.agentsDone === r.facts.agentCount ? tokens.success : tokens.textPrimary}>
              {r.facts.agentsDone}
            </Text>
            <Text color={tokens.textMuted}>/{r.facts.agentCount}</Text>
          </Text>
        ) : (
          <Unavailable />
        ),
    },
    {
      key: 'tok',
      header: 'Tok',
      width: 8,
      align: 'right',
      cell: r =>
        r.facts.totalTokens > 0 ? (
          <Text>
            <Text color={tokens.textMuted}>{GLYPH.tokens} </Text>
            <Text>{formatTokens(r.facts.totalTokens)}</Text>
          </Text>
        ) : (
          <Unavailable />
        ),
    },
    {
      key: 'time',
      header: 'Time',
      width: 8,
      align: 'right',
      // Honest runtime: running → ticking elapsed · settled → total runtime ·
      // stale/wedged → last-known runtime (clockEnd = the heartbeat mtime).
      cell: r => (
        <Text color={tokens.textMuted}>
          {formatDuration(Math.max(0, (r.facts.clockEnd ?? now) - r.facts.startTime))}
        </Text>
      ),
    },
  ]

  const sections: SectionDef<RunRow>[] = [
    {
      id: 'active',
      label: 'Active',
      count: activeRows.length,
      rows: activeRows,
      // The revive-line vocabulary: a session with no live runner runs
      // nothing — saying "no workflows running" alone would hide WHY.
      emptyHint:
        presence === 'dormant'
          ? 'the session has no live runner — ↵ in the chat revives it'
          : 'no workflows running',
    },
    {
      id: 'recent',
      label: 'Recent',
      count: recentRows.length,
      rows: recentRows,
      emptyHint: 'nothing recent',
    },
    // Conditional: External appears only when a run IS running/hung elsewhere
    // — a permanently-empty fourth section would be noise on the common board.
    ...(externalRows.length > 0
      ? [
          {
            id: 'external',
            label: 'External',
            count: externalRows.length,
            rows: externalRows,
            emptyHint: 'none running elsewhere',
          },
        ]
      : []),
    {
      id: 'past',
      // Honest partiality: an I/O-degraded sweep names the
      // shortfall instead of presenting the remainder as the whole.
      label:
        unreadableRuns > 0
          ? `Past · ${unreadableRuns} unreadable — partial`
          : 'Past',
      count: pastRows.length,
      rows: pastRows,
      emptyHint: 'no past runs on disk',
    },
  ]

  // `S save` arms only where the script is genuinely recoverable:
  // a live row carries the source in memory; a disk row only qualifies when
  // its run dir still holds the persisted workflow.js.
  const savableSource = (r: RunRow): string | undefined => {
    if (r.facts.script) return r.facts.script
    if (r.facts.runDir) {
      const file = join(r.facts.runDir, 'workflow.js')
      try {
        if (existsSync(file)) return readFileSync(file, 'utf8')
      } catch {
        return undefined
      }
    }
    return undefined
  }
  const canSave = (r: RunRow): boolean => {
    if (r.facts.script) return true
    if (!r.facts.runDir) return false
    try {
      return existsSync(join(r.facts.runDir, 'workflow.js'))
    } catch {
      return false
    }
  }

  // x/p only ever render on an AppState-tracked ACTIVE row — a Past row has no
  // in-process AbortController (x) or running status to suspend (p). R arms on
  // Recent rows (task-registered here) AND on disk-backed Past rows whose
  // artifacts prove recoverable (Sol 5.6 WS3 supersedes the earlier
  // Recent-only narrowing: launch persistence is atomic now, so a disk run
  // carries exact script + args + digest — restart recovery is safe).
  const rowActions = [
    {
      key: 'D',
      label: 'dispatch',
      when: () => true,
      run: () => setDispatchOpen(true),
    },
    {
      // THE ANSWER ROUTE (defect 4): a run blocked on a
      // permission ask showed "1 ask" here while the consent card — which
      // lives in the session's own permission queue — was stood down by
      // this very board (every full-screen overlay blocks the dialog
      // ladder). The operator could SEE the ask and not answer it. The
      // board cannot host the card, so the route is to stand itself down:
      // `a` closes the board and the queued card renders immediately.
      key: 'a',
      label: 'answer ask',
      // Screen-tracked rows read the live map; roster rows carry the
      // count over the wire — either way the card lives in the session's
      // own permission queue, and closing the board lets it render.
      when: (r: RunRow) =>
        r.section === 'active' &&
        ((r.task?.pendingPermissions?.size ?? 0) > 0 || (r.facts.pendingAsks ?? 0) > 0),
      run: () => {
        onClose()
      },
    },
    {
      key: 'x',
      label: 'stop',
      when: (r: RunRow) => r.section === 'active' && !!r.taskId,
      run: (r: RunRow) => {
        if (r.taskId) {
          // The note reads the RECEIPT — the run can settle
          // between render and keypress; never claim a stop that
          // touched nothing.
          const receipt = killWorkflowTask(r.taskId, setAppState)
          setActionNote(
            receipt === 'applied'
              ? `stopping ${r.runId} — the row settles when the tree is down`
              : `${r.runId} already settled — nothing to stop`,
          )
        }
      },
    },
    {
      key: 'p',
      label: 'pause',
      when: (r: RunRow) => r.section === 'active' && !!r.taskId,
      run: (r: RunRow) => {
        if (r.taskId) {
          const receipt = pauseWorkflowTask(r.taskId, setAppState)
          setActionNote(
            receipt === 'applied'
              ? `paused ${r.runId} — R on its Recent row dispatches the resume`
              : `${r.runId} already settled — nothing to pause`,
          )
        }
      },
    },
    {
      key: 'S',
      label: 'save',
      when: canSave,
      run: (r: RunRow) => {
        const src = savableSource(r)
        if (!src) {
          setActionNote(`no script recoverable for ${r.runId}`)
          return
        }
        // ONE save semantic across the board + the run view (task #3):
        // registry.saveWorkflowSourceToProject — slugged `<name>.js`,
        // identical content reports already-saved, a different file gets a
        // numbered sibling (never clobbered, never proliferating variants).
        void saveWorkflowSourceToProject({ source: src, name: r.facts.name, cwd }).then(res =>
          setActionNote(
            res.ok
              ? res.already
                ? `already saved — ${res.savedPath}`
                : `saved → ${res.savedPath} (runs by name via the Workflow tool)`
              : `save failed — ${res.error}`,
          ),
        )
      },
    },
    {
      key: 'R',
      label: 'resume',
      // Recent rows resume from the live task facts; PAST rows (paused /
      // failed / killed / orphaned on disk) resume from their persisted run
      // artifacts when diskResumability proves script + args recoverable
      // (Sol 5.6 WS3 — restart recovery does not need this process to have
      // launched the run). External rows never see R (another live process
      // owns them); completed rows surface S save instead (no dead keys).
      when: (r: RunRow) =>
        (r.section === 'recent' && !!r.taskId && !!r.facts.scriptPath) ||
        ((r.section === 'past' || (r.section === 'recent' && !r.taskId)) &&
          !!r.manifest &&
          boardDiskResumability(r.manifest).ok),
      run: (r: RunRow) => {
        if (queuedResumes.current.has(r.runId)) {
          setActionNote(`resume for ${r.runId} already dispatched`)
          return
        }
        let scriptPath: string | undefined
        let args: unknown
        // A roster row (no screen task) resumes from its DISK artifacts —
        // the run dir's exact script + args — the same road as a Past row;
        // only a screen-tracked Recent row resumes from live task facts.
        if (r.section === 'recent' && r.taskId) {
          scriptPath = r.facts.scriptPath
          args = r.facts.args
        } else if (r.manifest) {
          // Fresh probe at the keypress (decision time) — never the render cache.
          const res = probeDiskResumability(r.manifest)
          if (!res.ok) {
            setActionNote(`cannot resume ${r.runId}: ${res.reason}`)
            return
          }
          scriptPath = res.scriptPath
          args = res.args
        }
        if (!scriptPath) return
        queuedResumes.current.add(r.runId)
        // The delivery law: the resume prompt goes to the session NOW and
        // is read at its next readable moment; the board needs no close.
        void (async () => {
          const receipt = await submitDispatch({
            intentId: mintIntentId(),
            kind: 'board-dispatch',
            value: buildResumePrompt({
              args,
              scriptPath,
              workflowRunId: r.runId,
            }),
          })
          setActionNote(
            receipt.kind === 'dispatch-accepted'
              ? `resume sent for ${r.runId} — the session reads it at its next step`
              : `resume refused — ${receipt.reason}`,
          )
        })()
      },
    },
  ]

  // The header's right-aligned LIVE rollup (the floor grammar: "0/3 agents · 28s") —
  // present only while something genuinely runs here; grammar shared with the
  // inline rows via workflowRollup.ts.
  const activeAgents = activeRows.reduce((n, r) => n + r.facts.agentCount, 0)
  const activeDone = activeRows.reduce((n, r) => n + r.facts.agentsDone, 0)
  const activeTokens = activeRows.reduce((n, r) => n + r.facts.totalTokens, 0)
  const newestActiveStart = activeRows.reduce((t, r) => Math.max(t, r.facts.startTime), 0)
  const headerRight =
    activeRows.length > 0 ? (
      <Text color={tokens.textMuted} wrap="truncate-end">
        <WorkingGlyph color={tokens.success} active />
        <Text color={tokens.success}>
          {' '}
          {activeRows.length} running
        </Text>
        <Text color={tokens.textMuted}>
          {' '}
          ·{' '}
          {workflowRollupLine({
            agentsDone: activeDone,
            agentCount: activeAgents,
            elapsedMs: now - newestActiveStart,
            tokens: activeTokens,
          })}
        </Text>
      </Text>
    ) : undefined

  // x/p/S/R hints are selection-tracked by NavigablePanes itself (the
  // one-grammar footer engine composes them from rowActions.when(selectedRow)),
  // so a hint can never sit on a row where its key is dead.
  const showLoading = !pastLoaded && totalRows === 0

  return (
    <NavigablePanes<RunRow>
      view="workflows"
      sections={sections}
      columns={columns}
      rowKey={row => row.taskId ?? row.runId}
      renderDetail={row => <RunInfoPane row={row} now={now} />}
      sideInfo={row => <RunInfoPane row={row} now={now} />}
      headerRight={headerRight}
      onClose={onClose}
      onActivate={row => {
        lastActivatedKey.current = row.taskId ?? row.runId
        setView({ view: 'run', runId: row.runId, taskId: row.taskId })
      }}
      initialRowKey={lastActivatedKey.current}
      rowActions={rowActions}
      footerHints={actionNote ?? undefined}
      composerSlot={{
        active: dispatchOpen,
        node:
          dispatchOpen || dispatchDraft !== '' ? (
            <Box flexDirection="column" flexShrink={0}>
              <Text wrap="truncate-end">
                <Text color={tokens.accent} bold>
                  dispatch
                </Text>
                <Text color={tokens.textMuted}>
                  {' '}
                  {GLYPH.cursor} this session · session model · {cwd}
                </Text>
              </Text>
              <Text wrap="truncate-end">
                <Text color={tokens.textSecondary}>{GLYPH.prompt} </Text>
                <Text>{dispatchDraft}</Text>
                {dispatchOpen ? <Text color={tokens.accent}>{GLYPH.caretBlock}</Text> : null}
                <Text color={tokens.textMuted}>
                  {dispatchOpen ? '   ↵ dispatch · esc keep draft' : '   D resumes the draft'}
                </Text>
              </Text>
            </Box>
          ) : null,
        onInput: handleDispatchInput,
        onEscape: () => setDispatchOpen(false),
      }}
      loading={showLoading}
      emptyState={
        !showLoading && totalRows === 0
          ? {
              title: 'No workflow runs',
              hint:
                presence === 'dormant'
                  ? 'the session has no live runner — a replay revives it (↵ in the chat); its workflows list here'
                  : presence === 'blank'
                    ? 'this chat has no session yet — its first message creates one; the Workflow tool lists runs here live'
                    : 'Call the Workflow tool to launch one — /workflows will list it here live',
            }
          : undefined
      }
    />
  )
}
