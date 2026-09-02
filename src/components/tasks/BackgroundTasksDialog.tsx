// The tasks board: the MISSION ledger (read from the same telemetry
// bus the cockpit rail reads) above the sectioned process list — leader →
// teammates → shells → monitors → agents → workflows → consolidation — with
// stable-by-id selection, a cursor-following ~10-row window riding the
// proven /sessions slider, per-row ages on the shared 1-second tick, and
// kill/foreground/detail dispatch per kind. Escape is bound here: the
// surrounding shell does not capture input.

import figures from 'figures'
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useAppState, useSetAppState, type AppState } from '../../state/AppState.js'
import {
  enterTeammateView,
  exitTeammateView,
} from '../../state/teammateViewHelpers.js'
import { useTelemetry } from '../../state/telemetryBus.js'
import {
  bootRecoveryStatusLine,
  getBootRecovery,
  subscribeBootRecovery,
} from '../../substrate/recoveryOrchestrator.js'
import { isLocalShellTask, type LocalShellTaskState } from '../../tasks/LocalShellTask/guards.js'
import { killTask } from '../../tasks/LocalShellTask/killShellTasks.js'
import {
  isLocalAgentTask,
  killAsyncAgent,
  killAllRunningAgentTasks,
  type LocalAgentTaskState,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { InProcessTeammateTask } from '../../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import {
  isInProcessTeammateTask,
  type InProcessTeammateTaskState,
} from '../../tasks/InProcessTeammateTask/types.js'
import {
  isLocalWorkflowTask,
  killWorkflowTask,
  type LocalWorkflowTaskState,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { isDreamTask, type DreamTaskState } from '../../tasks/DreamTask/DreamTask.js'
import type { TaskState } from '../../tasks/types.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import { chatOnlyBoot } from '../../context/surfaceRoute.js'
import { formatDuration, formatTokens } from '../../utils/format.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { CommandCenter, KeyValueGrid, SectionHeader, useNowTick, type KVRow } from '../mercury-ui/components.js'
import { WorkingGlyph } from '../mercury-ui/LiveGlyphs.js'
import { computeSessionWindow } from '../mercury-ui/screens/SessionManagerView.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import type { WorkRowV1 } from '../../services/engine-connector/types.js'
import { GLYPH } from '../mercury-ui/glyphs.js'
import {
  focusedRunnerPresence,
  useFocusedWorkRoster,
} from './useFocusedWork.js'
import { AsyncAgentDetailDialog } from './AsyncAgentDetailDialog.js'
import { BackgroundTask as BackgroundTaskComponent } from './BackgroundTask.js'
import { DreamDetailDialog } from './DreamDetailDialog.js'
import { InProcessTeammateDetailDialog } from './InProcessTeammateDetailDialog.js'
import { ShellDetailDialog } from './ShellDetailDialog.js'
import { WorkflowDetailDialog } from './WorkflowDetailDialog.js'
import { isManageableTask } from './taskStatusUtils.js'

/** Contract data: the synthetic leader row's id. */
const LEADER_ROW_ID = '__leader__'
/** The mounted process-row window. */
const WINDOW = 10
/** Mission caps: in-progress rows, then pending rows. */
const MISSION_IN_PROGRESS_CAP = 4
const MISSION_PENDING_CAP = 6
/** Workflow detail views get a grace period so the final state is visible. */
const WORKFLOW_DETAIL_GRACE_MS = 5000

type RowKind =
  | 'leader'
  | 'teammate'
  | 'shell'
  | 'monitor'
  | 'agent'
  | 'workflow'
  | 'dream'

type BoardItem = {
  id: string
  kind: RowKind
  /** Absent only on the synthetic leader row. */
  task?: TaskState
  /** A FOCUSED-SESSION roster row (the session's runner's own work, fed
   *  over the connector) — task stays absent; the row renders these facts
   *  and its controllers live with the runner. */
  work?: WorkRowV1
}

function kindOf(task: TaskState): RowKind {
  if (isLocalShellTask(task)) return 'shell'
  if (isLocalAgentTask(task)) return 'agent'
  if (isInProcessTeammateTask(task)) return 'teammate'
  if (isLocalWorkflowTask(task)) return 'workflow'
  if (isDreamTask(task)) return 'dream'
  if ((task as { type?: string }).type === 'monitor_mcp') return 'monitor'
  throw new Error(
    `BackgroundTasksDialog: unrecognised task kind ${(task as { type?: string }).type}`,
  )
}

/** Right-aligned elapsed-since-start in a fixed 9-cell box; rows with an
 *  absent, non-finite or zero start show no age. */
function AgeCell({ item, now }: { item: BoardItem; now: number }): React.ReactNode {
  const started = item.task?.startTime ?? item.work?.startTime
  if (started === undefined || !Number.isFinite(started) || started === 0) {
    return <Box width={9} flexShrink={0} />
  }
  return (
    <Box width={9} flexShrink={0} justifyContent="flex-end">
      <Text dimColor>{formatDuration(Math.max(0, now - started))}</Text>
    </Box>
  )
}

/** The roster rows the /tasks board lists for one kind, in board order
 *  (running first, newest first) — THE board's own derivation, exported so
 *  the work-counts prover diffs the surfaces from one fixture. */
export function rosterRowsOf(
  rows: readonly WorkRowV1[],
  kind: WorkRowV1['kind'],
  excludeIds?: ReadonlySet<string>,
): WorkRowV1[] {
  return [...rows]
    .filter(w => w.kind === kind && !(excludeIds?.has(w.id) ?? false))
    .sort((a, b) => {
      const aRunning = a.status === 'running' ? 0 : 1
      const bRunning = b.status === 'running' ? 0 : 1
      if (aRunning !== bRunning) return aRunning - bRunning
      return b.startTime - a.startTime
    })
}

/** A FOCUSED-SESSION roster row's line: honest state glyph, name, the
 *  kind's own status word, workflow rows their agents fraction. */
function WorkRowLine({ work }: { work: WorkRowV1 }): React.ReactNode {
  const tokens = useMercuryTokens()
  const running = work.status === 'running'
  const pending = work.status === 'pending'
  const failed = work.status === 'failed' || work.status === 'killed'
  return (
    <Text wrap="truncate-end">
      {running ? (
        <WorkingGlyph color={tokens.success} active />
      ) : (
        <Text color={failed ? tokens.failure : pending ? tokens.warning : tokens.textMuted}>
          {failed ? GLYPH.fail : pending ? GLYPH.pending : GLYPH.done}
        </Text>
      )}
      <Text> {work.name}</Text>
      <Text color={tokens.textMuted}> · {work.status}</Text>
      {work.kind === 'workflow' && (work.agentCount ?? 0) > 0 ? (
        <Text color={tokens.textMuted}> · {work.agentCount} agents</Text>
      ) : null}
      {(work.pendingAsks ?? 0) > 0 ? (
        <Text color={tokens.warning}> · {work.pendingAsks} ask{(work.pendingAsks ?? 0) === 1 ? '' : 's'}</Text>
      ) : null}
    </Text>
  )
}

/** The roster row's detail card — the facts the wire carries. The row's
 *  streams and controllers live with the session's runner (the workflow
 *  board drills a run's phases; a chat's tool cards carry the rest). */
function RosterWorkDetail({
  work,
  now,
  onBack,
}: {
  work: WorkRowV1
  now: number
  onBack: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  useKeybindings(
    {
      'confirm:no': () => {
        onBack()
      },
    },
    { context: 'Confirmation', isActive: true },
  )
  const rows: KVRow[] = [
    { k: 'state', v: work.status, tone: work.status === 'running' ? tokens.success : tokens.textPrimary },
    { k: 'started', v: `${formatDuration(Math.max(0, now - work.startTime))} ago`, tone: tokens.textMuted },
  ]
  if (work.endTime !== undefined) rows.push({ k: 'ran', v: formatDuration(Math.max(0, work.endTime - work.startTime)), tone: tokens.textMuted })
  if (work.model !== undefined) rows.push({ k: 'model', v: work.model, tone: tokens.textPrimary })
  if (work.agentType !== undefined) rows.push({ k: 'agent', v: work.agentType, tone: tokens.textPrimary })
  if (work.team !== undefined) rows.push({ k: 'team', v: work.team, tone: tokens.textPrimary })
  if ((work.totalTokens ?? 0) > 0) rows.push({ k: 'tokens', v: `${GLYPH.tokens} ${formatTokens(work.totalTokens ?? 0)}`, tone: tokens.textPrimary })
  if (work.kind === 'workflow' && (work.agentCount ?? 0) > 0) rows.push({ k: 'agents', v: String(work.agentCount), tone: tokens.textPrimary })
  return (
    <Box flexDirection="column">
      {work.description !== undefined ? (
        <Text color={tokens.textMuted} wrap="truncate-end">
          {work.description}
        </Text>
      ) : null}
      {work.error !== undefined ? (
        <Text color={tokens.failure} wrap="wrap">
          {work.error}
        </Text>
      ) : null}
      <KeyValueGrid rows={rows} keyWidth={8} />
      <Box marginTop={1} flexDirection="column">
        <Text color={tokens.textMuted} wrap="wrap">
          runs in this session — its stream and controls live with the
          session&apos;s runner{work.kind === 'workflow' && !chatOnlyBoot() ? '; /workflows opens the run board' : ''}
        </Text>
        <Text dimColor>
          <KeyboardShortcutHint shortcut="Esc" action="back" />
        </Text>
      </Box>
    </Box>
  )
}

export function BackgroundTasksDialog({
  onDone,
  toolUseContext,
  initialDetailTaskId,
}: {
  onDone: () => void
  toolUseContext: LocalJSXCommandContext
  initialDetailTaskId?: string
}): React.ReactNode {
  void toolUseContext
  const tokens = useMercuryTokens()
  const { columns } = useTerminalSize()
  const now = useNowTick()
  const tasks = useAppState((state: AppState) => state.tasks)
  // The focused session's work roster (its runner's own task store, fed
  // over the connector) — the rows the unified screen's own store never
  // carries. Presence rides the roster's cadence: one cheap read per
  // roster change, never per clock tick.
  const roster = useFocusedWorkRoster()
  const presence = React.useMemo(() => focusedRunnerPresence(), [roster])
  const treeShowing = useAppState(
    (state: AppState) => state.expandedView === 'teammates',
  )
  const viewingAgentTaskId = useAppState(
    (state: AppState) => state.viewingAgentTaskId,
  )
  const setAppState = useSetAppState()
  // The mission ledger follows the focused session too: the screen's own
  // bus keys on the SCREEN's process session (a resumed session's seeded
  // ledger read "no mission tasks"); when it has nothing, the focused
  // session's ledger — published by its runner with the work roster —
  // paints (the /mcp template: the screen's own first, the session's when
  // the screen has none).
  const screenMission = useTelemetry(s => s.tasks)
  const missionTasks: ReadonlyArray<{ id: string; subject: string; activeForm?: string; status: string }> =
    screenMission.length > 0 ? screenMission : roster.mission
  const bootRecovery = useSyncExternalStore(
    subscribeBootRecovery,
    getBootRecovery,
    getBootRecovery,
  )

  // ── the selectable set, grouped and flattened in RENDERED order ──────────
  const manageable = Object.values(tasks)
    .filter(isManageableTask)
    .filter(task => {
      // A foregrounded local agent is excluded from the selectable set.
      if (isLocalAgentTask(task) && task.id === viewingAgentTaskId) return false
      // Teammates are excluded entirely while the spinner tree shows them.
      if (isInProcessTeammateTask(task) && treeShowing) return false
      return true
    })
    .sort((a, b) => {
      const aRunning = a.status === 'running' ? 0 : 1
      const bRunning = b.status === 'running' ? 0 : 1
      if (aRunning !== bRunning) return aRunning - bRunning
      return b.startTime - a.startTime
    })

  const byKind = new Map<RowKind, TaskState[]>()
  for (const task of manageable) {
    const kind = kindOf(task)
    byKind.set(kind, [...(byKind.get(kind) ?? []), task])
  }
  const teammateTasks = (byKind.get('teammate') ?? []) as InProcessTeammateTaskState[]
  const shellTasks = byKind.get('shell') ?? []
  const monitorTasks = byKind.get('monitor') ?? []
  const agentTasks = byKind.get('agent') ?? []
  const workflowTasks = byKind.get('workflow') ?? []
  const dreamTasks = byKind.get('dream') ?? []

  const leaderItem: BoardItem | null =
    teammateTasks.length > 0 ? { id: LEADER_ROW_ID, kind: 'leader' } : null
  // The focused session's roster rows join their kind's section after the
  // screen's own (the screen store is normally empty on the unified
  // screen — the session's runner owns the work). Running rows first,
  // newest first — the same order the screen rows take.
  const screenIds = new Set(manageable.map(task => task.id))
  const rosterOf = (kind: WorkRowV1['kind']): BoardItem[] =>
    rosterRowsOf(roster.rows, kind, screenIds).map(
      (w): BoardItem => ({ id: w.id, kind, work: w }),
    )
  const flat: BoardItem[] = [
    ...(leaderItem ? [leaderItem] : []),
    ...teammateTasks.map((task): BoardItem => ({ id: task.id, kind: 'teammate', task })),
    ...rosterOf('teammate'),
    ...shellTasks.map((task): BoardItem => ({ id: task.id, kind: 'shell', task })),
    ...rosterOf('shell'),
    ...monitorTasks.map((task): BoardItem => ({ id: task.id, kind: 'monitor', task })),
    ...rosterOf('monitor'),
    ...agentTasks.map((task): BoardItem => ({ id: task.id, kind: 'agent', task })),
    ...rosterOf('agent'),
    ...workflowTasks.map((task): BoardItem => ({ id: task.id, kind: 'workflow', task })),
    ...rosterOf('workflow'),
    ...dreamTasks.map((task): BoardItem => ({ id: task.id, kind: 'dream', task })),
    ...rosterOf('dream'),
  ]
  const indexById = new Map(flat.map((item, index) => [item.id, index]))

  // ── mission ledger (read-only rows; never selectable) ────────────────────
  const inProgress = missionTasks.filter(task => task.status === 'in_progress')
  const pendingMission = missionTasks.filter(task => task.status === 'pending')
  const doneMission = missionTasks.filter(task => task.status === 'completed')
  const ledgerOpenCount = inProgress.length + pendingMission.length

  // ── stable-by-id selection ───────────────────────────────────────────────
  const selectedIdRef = useRef<string | null>(null)
  const [cursor, setCursor] = useState(0)
  const stableId = selectedIdRef.current
  let selectedIndex = flat.findIndex(i => i.id === stableId)
  if (selectedIndex < 0) {
    // The chosen row disappeared: land on the nearest remaining row.
    selectedIndex = Math.max(0, Math.min(cursor, flat.length - 1))
  }
  selectedIdRef.current = flat[selectedIndex]?.id ?? null
  const selected: BoardItem | undefined = flat[selectedIndex]

  const moveSelection = (delta: number): void => {
    if (flat.length === 0) return
    const next = Math.max(0, Math.min(flat.length - 1, selectedIndex + delta))
    selectedIdRef.current = flat[next]?.id ?? null
    setCursor(next)
  }

  // ── view state: list vs detail ───────────────────────────────────────────
  const skippedListRef = useRef(false)
  const [detailTaskId, setDetailTaskId] = useState<string | undefined>(() => {
    if (initialDetailTaskId !== undefined) return initialDetailTaskId
    if (flat.filter(item => item.kind !== 'leader').length === 1 && !leaderItem) {
      skippedListRef.current = true
      return flat[0]?.id
    }
    return undefined
  })
  const detailTask =
    detailTaskId !== undefined ? tasks[detailTaskId] : undefined
  // A roster row's detail: the facts card (its controllers and streams
  // live with the session's runner — the honest scope of the wire).
  const detailWork =
    detailTaskId !== undefined && detailTask === undefined
      ? roster.rows.find(w => w.id === detailTaskId)
      : undefined
  const inDetail = detailTaskId !== undefined

  const returnToLeader = (): void => {
    exitTeammateView(setAppState)
    onDone()
  }

  // Back-from-detail is mission-aware: close instead of returning to the
  // list only when the list was skipped, at most one process row remains,
  // and no open ledger rows exist (never close past an open ledger).
  const backFromDetail = (): void => {
    if (skippedListRef.current && flat.length <= 1 && ledgerOpenCount === 0) {
      onDone()
      return
    }
    setDetailTaskId(undefined)
  }

  // Kick-out: a detail task that disappears or stops being manageable sends
  // the dialog back to the list (or out entirely when the list was skipped).
  // Workflow details get a grace period so their final state is visible.
  useEffect(() => {
    if (detailTaskId === undefined) return
    const task = tasks[detailTaskId]
    if (task !== undefined && isManageableTask(task)) return
    // A roster row's card stands while its row stands in the session's
    // roster; the row's eviction (the runner's own) sends the dialog back.
    if (task === undefined && roster.rows.some(w => w.id === detailTaskId)) return
    if (task !== undefined && isLocalWorkflowTask(task)) {
      const timer = setTimeout(() => {
        if (skippedListRef.current) onDone()
        else setDetailTaskId(undefined)
      }, WORKFLOW_DETAIL_GRACE_MS)
      return () => clearTimeout(timer)
    }
    if (skippedListRef.current) onDone()
    else setDetailTaskId(undefined)
  }, [detailTaskId, tasks, roster, onDone])

  const openDetail = (item: BoardItem): void => {
    if (item.kind === 'leader') {
      returnToLeader()
      return
    }
    setDetailTaskId(item.id)
  }

  const stopSelected = (item: BoardItem): void => {
    const task = item.task
    if (task === undefined || task.status !== 'running') return
    switch (item.kind) {
      case 'shell':
        void killTask(task.id, setAppState)
        return
      case 'agent':
        killAsyncAgent(task.id, setAppState)
        return
      case 'teammate':
        void InProcessTeammateTask.kill(task.id, setAppState)
        return
      case 'workflow':
        killWorkflowTask(task.id, setAppState)
        return
      case 'monitor':
        // The MCP-monitor module is harness-delivered (a type shim here):
        // stop through the state record's own controller.
        ;(task as { abortController?: AbortController }).abortController?.abort()
        return
      case 'dream':
        (task as DreamTaskState).abortController?.abort()
        return
      default:
        return
    }
  }

  // List-mode keys (Confirmation context): cancel closes, previous/next
  // move, accept opens detail — except the leader row, which returns to the
  // leader and closes. Escape is bound here (escape → confirm:no).
  useKeybindings(
    {
      'confirm:no': () => {
        onDone()
      },
      'confirm:previous': () => {
        moveSelection(-1)
      },
      'confirm:next': () => {
        moveSelection(1)
      },
      'confirm:yes': () => {
        if (selected !== undefined) openDetail(selected)
      },
    },
    { context: 'Confirmation', isActive: !inDetail },
  )

  const handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'left') {
      e.stopImmediatePropagation()
      onDone()
      return
    }
    if (e.key === 'x' && selected !== undefined) {
      e.stopImmediatePropagation()
      stopSelected(selected)
      return
    }
    if (e.key === 'X') {
      e.stopImmediatePropagation()
      killAllRunningAgentTasks(tasks, setAppState)
      return
    }
    if (e.key === 'f' || e.key === 'm') {
      e.stopImmediatePropagation()
      if (selected === undefined) return
      if (selected.kind === 'leader') {
        returnToLeader()
        return
      }
      const task = selected.task
      if (task === undefined) return
      // Local agents have NO status gate — a completed agent inside its
      // linger window is precisely the row the reply flow needs.
      if (task.type === 'local_agent') {
        enterTeammateView(task.id, setAppState)
        onDone()
        return
      }
      if (isInProcessTeammateTask(task) && task.status === 'running') {
        enterTeammateView(task.id, setAppState)
        onDone()
      }
    }
  }
  useInput(
    (_input, _key, event) => {
      handleKeyDown(new KeyboardEvent(event.keypress))
    },
    { isActive: !inDetail },
  )

  // ── detail dispatch (each card hosted in the command-center shell; the
  // shell captures no input — the card owns its keys) ──────────────────────
  if (inDetail && detailTask !== undefined) {
    if (isLocalAgentTask(detailTask)) {
      const agent = detailTask as LocalAgentTaskState
      return (
        <CommandCenter
          view={`agent › ${agent.description !== '' ? agent.description : agent.agentType}`}
          onClose={onDone}
          captureInput={false}
        >
          <AsyncAgentDetailDialog
            agent={agent}
            onDone={onDone}
            onBack={backFromDetail}
            onKillAgent={() => killAsyncAgent(agent.id, setAppState)}
            onForeground={() => {
              enterTeammateView(agent.id, setAppState)
              onDone()
            }}
          />
        </CommandCenter>
      )
    }
    if (isInProcessTeammateTask(detailTask)) {
      const teammate = detailTask
      return (
        <CommandCenter
          view={`teammate › @${teammate.identity.agentName}`}
          onClose={onDone}
          captureInput={false}
        >
          <InProcessTeammateDetailDialog
            teammate={teammate}
            onDone={onDone}
            onBack={backFromDetail}
            onKill={() => void InProcessTeammateTask.kill(teammate.id, setAppState)}
            onForeground={() => {
              enterTeammateView(teammate.id, setAppState)
              onDone()
            }}
          />
        </CommandCenter>
      )
    }
    if (isLocalShellTask(detailTask)) {
      const shell = detailTask as LocalShellTaskState
      return (
        <ShellDetailDialog
          shell={shell}
          onDone={onDone}
          onBack={backFromDetail}
          onKillShell={() => void killTask(shell.id, setAppState)}
        />
      )
    }
    if (isLocalWorkflowTask(detailTask)) {
      const workflow = detailTask as LocalWorkflowTaskState
      return (
        <WorkflowDetailDialog
          workflow={workflow}
          onDone={onDone}
          onBack={backFromDetail}
          onKill={() => killWorkflowTask(workflow.id, setAppState)}
        />
      )
    }
    if (isDreamTask(detailTask)) {
      const dream = detailTask as DreamTaskState
      return (
        <CommandCenter view="consolidation" onClose={onDone} captureInput={false}>
          <DreamDetailDialog
            task={dream}
            onDone={onDone}
            onBack={backFromDetail}
            onKill={() => dream.abortController?.abort()}
          />
        </CommandCenter>
      )
    }
  }
  if (inDetail && detailTask === undefined && detailWork !== undefined) {
    return (
      <CommandCenter
        view={`${detailWork.kind} › ${detailWork.name}`}
        onClose={onDone}
        captureInput={false}
      >
        <RosterWorkDetail work={detailWork} now={now} onBack={backFromDetail} />
      </CommandCenter>
    )
  }

  // ── list view ────────────────────────────────────────────────────────────
  const runningCount = flat.filter(item => (item.task ?? item.work)?.status === 'running').length
  const pendingCount = flat.filter(item => (item.task ?? item.work)?.status === 'pending').length
  const activeCount = runningCount + pendingCount
  const subtitle =
    `${activeCount} active` +
    (ledgerOpenCount > 0 ? ` · ${ledgerOpenCount} mission` : '')

  const { start: winStart, end: winEnd } = computeSessionWindow(
    selectedIndex,
    flat.length,
    WINDOW,
  )
  const inWin = (item: BoardItem): boolean => {
    const index = indexById.get(item.id)
    return index !== undefined && index >= winStart && index < winEnd
  }
  const activityWidth = Math.max(30, columns - 26)

  const recoveryLine = bootRecoveryStatusLine(bootRecovery)

  const rowFor = (item: BoardItem): React.ReactNode => {
    const isSelected = item.id === selectedIdRef.current
    return (
      <Box key={item.id} flexDirection="row">
        <Text bold={isSelected} color={isSelected ? tokens.textPrimary : undefined}>
          {isSelected ? `${figures.pointer} ` : '  '}
        </Text>
        <Box flexGrow={1} minWidth={0}>
          {item.kind === 'leader' ? (
            <Text bold={isSelected}>@{TEAM_LEAD_NAME}</Text>
          ) : item.task !== undefined ? (
            <BackgroundTaskComponent
              task={item.task}
              maxActivityWidth={activityWidth}
            />
          ) : item.work !== undefined ? (
            <WorkRowLine work={item.work} />
          ) : null}
        </Box>
        <AgeCell item={item} now={now} />
      </Box>
    )
  }

  // Teammate rows group by team name; each header carries the team's honest
  // member count (teammates plus the leader entry), window or not.
  const teamGroups = new Map<string, InProcessTeammateTaskState[]>()
  for (const teammate of teammateTasks) {
    const team = teammate.identity.teamName
    teamGroups.set(team, [...(teamGroups.get(team) ?? []), teammate])
  }
  const teammateItems = flat.filter(item => item.kind === 'teammate')
  // Roster teammates group under their own team labels (the runner's team;
  // the leader sits in the chat itself, so no synthetic leader row here).
  const rosterTeamGroups = new Map<string, BoardItem[]>()
  for (const item of teammateItems) {
    if (item.work === undefined) continue
    const team = item.work.team ?? 'team'
    rosterTeamGroups.set(team, [...(rosterTeamGroups.get(team) ?? []), item])
  }
  const shellItems = flat.filter(item => item.kind === 'shell')
  const monitorItems = flat.filter(item => item.kind === 'monitor')
  const agentItems = flat.filter(item => item.kind === 'agent')
  const workflowItems = flat.filter(item => item.kind === 'workflow')
  const dreamItems = flat.filter(item => item.kind === 'dream')

  const selectedTeammateRunning =
    selected?.kind === 'teammate' && selected.task?.status === 'running'
  const selectedStoppable =
    selected?.task !== undefined && selected.task.status === 'running'
  const anyAgentRunning = agentTasks.some(task => task.status === 'running')

  return (
    <CommandCenter
      view="tasks"
      subtitle={subtitle}
      onClose={onDone}
      captureInput={false}
    >
      <Box flexDirection="column" tabIndex={-1}>
        {missionTasks.length > 0 ? (
          <Box flexDirection="column">
            <SectionHeader marginTop={0} count={ledgerOpenCount}>
              Mission
            </SectionHeader>
            {inProgress.slice(0, MISSION_IN_PROGRESS_CAP).map(task => (
              <Box key={task.id}>
                <WorkingGlyph color={tokens.success} active={true} />
                <Text> {task.activeForm ?? task.subject}</Text>
              </Box>
            ))}
            {inProgress.length > MISSION_IN_PROGRESS_CAP ? (
              <Text dimColor>
                +{inProgress.length - MISSION_IN_PROGRESS_CAP} more in progress
              </Text>
            ) : null}
            {pendingMission.slice(0, MISSION_PENDING_CAP).map(task => (
              <Text key={task.id} dimColor>
                ○ {task.subject}
              </Text>
            ))}
            {pendingMission.length > MISSION_PENDING_CAP ? (
              <Text dimColor>
                +{pendingMission.length - MISSION_PENDING_CAP} more pending
              </Text>
            ) : null}
            {doneMission.length > 0 ? (
              <Text dimColor>{doneMission.length} done</Text>
            ) : null}
          </Box>
        ) : null}

        {flat.length === 0 ? (
          <Box flexDirection="column" marginTop={missionTasks.length > 0 ? 1 : 0}>
            {ledgerOpenCount === 0 && missionTasks.length === 0 ? (
              <Text dimColor>no mission tasks and no background runs</Text>
            ) : (
              <Text dimColor>no background runs</Text>
            )}
            {presence === 'dormant' ? (
              <Text color={tokens.textMuted}>
                the session has no live runner — ↵ in the chat revives it
              </Text>
            ) : null}
            {recoveryLine !== null ? (
              <Text
                color={
                  recoveryLine.tone === 'ok'
                    ? tokens.success
                    : recoveryLine.tone === 'warn'
                      ? tokens.warning
                      : tokens.textSecondary
                }
              >
                {recoveryLine.text}
              </Text>
            ) : null}
          </Box>
        ) : (
          <Box flexDirection="column">
            <Box>
              <Text>
                {runningCount} running
                <Text color={tokens.textMuted}> · </Text>
                {pendingCount} pending
              </Text>
            </Box>
            {winStart > 0 ? (
              <Text dimColor>↑ {winStart} more above</Text>
            ) : null}
            {teammateItems.length > 0 || leaderItem !== null ? (
              <Box flexDirection="column">
                <SectionHeader count={teammateItems.length}>
                  Teammates
                </SectionHeader>
                {leaderItem !== null && inWin(leaderItem)
                  ? rowFor(leaderItem)
                  : null}
                {[...teamGroups.entries()].map(([team, members]) => (
                  <Box key={team} flexDirection="column">
                    <Text dimColor>
                      {team} ({members.length + 1} members)
                    </Text>
                    {teammateItems
                      .filter(item =>
                        members.some(member => member.id === item.id),
                      )
                      .filter(inWin)
                      .map(rowFor)}
                  </Box>
                ))}
                {[...rosterTeamGroups.entries()].map(([team, items]) => (
                  <Box key={`roster-${team}`} flexDirection="column">
                    <Text dimColor>
                      {team} ({items.length} members)
                    </Text>
                    {items.filter(inWin).map(rowFor)}
                  </Box>
                ))}
              </Box>
            ) : null}
            {shellItems.length > 0 ? (
              <Box flexDirection="column">
                <SectionHeader count={shellItems.length}>Shells</SectionHeader>
                {shellItems.filter(inWin).map(rowFor)}
              </Box>
            ) : null}
            {monitorItems.length > 0 ? (
              <Box flexDirection="column">
                <SectionHeader count={monitorItems.length}>
                  Monitors
                </SectionHeader>
                {monitorItems.filter(inWin).map(rowFor)}
              </Box>
            ) : null}
            {agentItems.length > 0 ? (
              <Box flexDirection="column">
                <SectionHeader count={agentItems.length}>Agents</SectionHeader>
                {agentItems.filter(inWin).map(rowFor)}
              </Box>
            ) : null}
            {workflowItems.length > 0 ? (
              <Box flexDirection="column">
                <SectionHeader count={workflowItems.length}>
                  Workflows
                </SectionHeader>
                {workflowItems.filter(inWin).map(rowFor)}
              </Box>
            ) : null}
            {dreamItems.length > 0 ? (
              <Box flexDirection="column">
                <SectionHeader count={dreamItems.length}>
                  Consolidation
                </SectionHeader>
                {dreamItems.filter(inWin).map(rowFor)}
              </Box>
            ) : null}
            {winEnd < flat.length ? (
              <Text dimColor>↓ {flat.length - winEnd} more</Text>
            ) : null}
          </Box>
        )}

        <Box marginTop={1}>
          <Text dimColor>
            {flat.length > 0 ? (
              <>
                <KeyboardShortcutHint shortcut="↑/↓" action="select" />
                {' · '}
                <KeyboardShortcutHint shortcut="Enter" action="view" />
                {' · '}
              </>
            ) : null}
            {selected?.kind === 'leader' ? (
              <>
                <KeyboardShortcutHint shortcut="Enter" action="leader" />
                {' · '}
              </>
            ) : null}
            {selectedTeammateRunning ? (
              <>
                <KeyboardShortcutHint shortcut="f" action="foreground" />
                {' · '}
                <KeyboardShortcutHint shortcut="m" action="message" />
                {' · '}
              </>
            ) : null}
            {selectedStoppable ? (
              <>
                <KeyboardShortcutHint shortcut="x" action="stop" />
                {' · '}
              </>
            ) : null}
            {anyAgentRunning ? (
              <>
                <KeyboardShortcutHint shortcut="X" action="stop all" />
                {' · '}
              </>
            ) : null}
            <KeyboardShortcutHint shortcut="Esc" action="close" />
          </Text>
        </Box>
      </Box>
    </CommandCenter>
  )
}
