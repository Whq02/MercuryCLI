import React, { useRef, useState } from 'react'
import { GLYPH } from '../theme/glyphs.js'
import { Box, Text } from '../themedRenderer.js'
import { stringWidth } from '../renderer/stringWidth.js'
import { useTimer } from '../effects/effects.js'
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js'
import { AppStoreContext, type AppState } from '../app-state/AppState.js'
import { isLocalAgentTask } from '../../engine/tasks/local-agent/crewmateTask.js'
import type { WorkRowV1 } from '../../engine/connector/types.js'
import { isTaskToolsEnabled } from '../../engine/task-framework/tasks.js'
import { truncateToWidth } from '../../platform/text/truncate.js'
import { startTimeout, stopTimeout } from '../../platform/async/timers.js'
import { useFocusedWorkRoster } from './useFocusedWork.js'

type TaskRowV2 = { id: string; status: 'pending' | 'in_progress' | 'completed'; subject: string; blockedBy?: readonly string[]; owner?: string }

const RECENT_COMPLETION_MS = 30_000
const noopSubscribe = (): (() => void) => () => {}

function collectRunningOwners(
  appTasks: AppState['tasks'] | undefined,
  agentNameRegistry: AppState['agentNameRegistry'] | undefined,
  rosterRows: readonly WorkRowV1[],
): { runningOwners: Set<string>; ownerActivity: Map<string, string> } {
  const runningOwners = new Set<string>()
  const ownerActivity = new Map<string, string>()

  if (appTasks !== undefined) {
    if (agentNameRegistry !== undefined) {
      for (const [name, taskId] of agentNameRegistry) {
        const agentTask = appTasks[taskId]
        if (
          agentTask !== undefined &&
          isLocalAgentTask(agentTask) &&
          agentTask.status === 'running'
        ) {
          runningOwners.add(name)
          const last = agentTask.progress?.lastActivity
          const desc = last?.activityDescription || last?.toolName
          if (desc !== undefined && desc !== '') {
            ownerActivity.set(name, desc)
          }
        }
      }
    }
    for (const agentTask of Object.values(appTasks)) {
      if (isLocalAgentTask(agentTask) && agentTask.status === 'running') {
        runningOwners.add(agentTask.id)
        runningOwners.add(agentTask.agentId)
        const last = agentTask.progress?.lastActivity
        const desc = last?.activityDescription || last?.toolName
        if (desc !== undefined && desc !== '') {
          ownerActivity.set(agentTask.id, desc)
          ownerActivity.set(agentTask.agentId, desc)
        }
      }
    }
  }

  for (const row of rosterRows) {
    if (row.kind === 'agent' && row.status === 'running') {
      runningOwners.add(row.name)
      runningOwners.add(row.id)
      if (row.agentId !== undefined) {
        runningOwners.add(row.agentId)
      }
      if (typeof row.activity === 'string' && row.activity.length > 0) {
        if (!ownerActivity.has(row.name)) ownerActivity.set(row.name, row.activity)
        if (!ownerActivity.has(row.id)) ownerActivity.set(row.id, row.activity)
        if (row.agentId !== undefined && !ownerActivity.has(row.agentId)) {
          ownerActivity.set(row.agentId, row.activity)
        }
      }
    }
  }

  return { runningOwners, ownerActivity }
}

function compareIds(a: string, b: string): number {
  const an = Number(a)
  const bn = Number(b)
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn
  return a < b ? -1 : a > b ? 1 : 0
}

export function TaskListV2({
  tasks,
  isStandalone = false,
}: {
  tasks: readonly TaskRowV2[]
  isStandalone?: boolean
}): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const store = React.useContext(AppStoreContext)
  const appTasks = React.useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    () => store?.getState().tasks,
    () => store?.getState().tasks,
  )
  const agentNameRegistry = React.useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    () => store?.getState().agentNameRegistry,
    () => store?.getState().agentNameRegistry,
  )
  const roster = useFocusedWorkRoster()
  const [tick, setTick] = useState(0)
  const prevStatusRef = useRef<Map<string, TaskRowV2['status']> | null>(null)
  const completedAtRef = useRef<Map<string, number>>(new Map())
  const now = Date.now()
  if (prevStatusRef.current === null) {
    prevStatusRef.current = new Map(tasks.map(task => [task.id, task.status]))
  } else {
    const nextPrev = new Map<string, TaskRowV2['status']>()
    for (const task of tasks) {
      const prev = prevStatusRef.current.get(task.id)
      if (task.status === 'completed') {
        if (prev !== 'completed') {
          completedAtRef.current.set(task.id, now)
        }
      } else {
        completedAtRef.current.delete(task.id)
      }
      nextPrev.set(task.id, task.status)
    }
    for (const id of [...completedAtRef.current.keys()]) {
      if (!nextPrev.has(id)) {
        completedAtRef.current.delete(id)
      }
    }
    prevStatusRef.current = nextPrev
  }

  for (const [id, completedAt] of [...completedAtRef.current.entries()]) {
    if (now - completedAt >= RECENT_COMPLETION_MS) {
      completedAtRef.current.delete(id)
    }
  }

  let earliestExpiry = Infinity
  for (const completedAt of completedAtRef.current.values()) {
    const expiry = completedAt + RECENT_COMPLETION_MS
    if (expiry < earliestExpiry) earliestExpiry = expiry
  }

  useTimer(() => {
    if (!Number.isFinite(earliestExpiry)) return
    const delay = Math.max(1, earliestExpiry - Date.now())
    const handle = startTimeout(() => {
      setTick(value => value + 1)
    }, delay)
    return () => {
      stopTimeout(handle)
    }
  }, [earliestExpiry, tick])

  if (!isTaskToolsEnabled() || tasks.length === 0) return null

  const taskById = new Map<string, TaskRowV2>()
  for (const task of tasks) {
    taskById.set(task.id, task)
  }

  const openBlockersOf = (task: TaskRowV2): string[] =>
    (task.blockedBy ?? []).filter(id => {
      const blocker = taskById.get(id)
      return blocker !== undefined && blocker.status !== 'completed'
    })

  const maxRows = rows <= 10 ? 0 : Math.min(10, Math.max(3, rows - 14))
  let visibleTasks: TaskRowV2[] = []
  let hiddenTasks: TaskRowV2[] = []

  if (maxRows === 0) {
    visibleTasks = []
    hiddenTasks = []
  } else if (tasks.length > maxRows) {
    const recentCompleted: TaskRowV2[] = []
    const inProgress: TaskRowV2[] = []
    const unblockedPending: TaskRowV2[] = []
    const blockedPending: TaskRowV2[] = []
    const olderCompleted: TaskRowV2[] = []

    for (const task of tasks) {
      if (task.status === 'completed') {
        if (completedAtRef.current.has(task.id)) {
          recentCompleted.push(task)
        } else {
          olderCompleted.push(task)
        }
      } else if (task.status === 'in_progress') {
        inProgress.push(task)
      } else if (openBlockersOf(task).length === 0) {
        unblockedPending.push(task)
      } else {
        blockedPending.push(task)
      }
    }

    const sortById = (list: TaskRowV2[]): TaskRowV2[] =>
      list.sort((a, b) => compareIds(a.id, b.id))

    const prioritized = [
      ...sortById(recentCompleted),
      ...sortById(inProgress),
      ...sortById(unblockedPending),
      ...sortById(blockedPending),
      ...sortById(olderCompleted),
    ]
    visibleTasks = prioritized.slice(0, maxRows).sort((a, b) => compareIds(a.id, b.id))
    hiddenTasks = prioritized.slice(maxRows)
  } else {
    visibleTasks = [...tasks].sort((a, b) => compareIds(a.id, b.id))
  }

  let doneCount = 0
  let inProgressCount = 0
  let openCount = 0
  for (const task of tasks) {
    if (task.status === 'completed') doneCount++
    else if (task.status === 'in_progress') inProgressCount++
    else openCount++
  }

  let hiddenSummary: string | null = null
  if (maxRows > 0 && hiddenTasks.length > 0) {
    let hiddenInProgress = 0
    let hiddenPending = 0
    let hiddenCompleted = 0
    for (const task of hiddenTasks) {
      if (task.status === 'in_progress') hiddenInProgress++
      else if (task.status === 'pending') hiddenPending++
      else hiddenCompleted++
    }
    const parts: string[] = []
    if (hiddenInProgress > 0) parts.push(`${hiddenInProgress} in progress`)
    if (hiddenPending > 0) parts.push(`${hiddenPending} pending`)
    if (hiddenCompleted > 0) parts.push(`${hiddenCompleted} completed`)
    hiddenSummary = `… +${hiddenTasks.length} (${parts.join(', ')})`
  }

  const standaloneSummary = isStandalone
    ? [
        `${tasks.length} tasks`,
        `${doneCount} done`,
        ...(inProgressCount > 0 ? [`${inProgressCount} in progress`] : []),
        `${openCount} open`,
      ].join(' · ')
    : null

  if (!isStandalone && visibleTasks.length === 0 && hiddenSummary === null) {
    return null
  }

  const { runningOwners, ownerActivity } = collectRunningOwners(
    appTasks,
    agentNameRegistry,
    roster.rows,
  )

  const rowIndent = isStandalone ? 2 : 0

  return (
    <Box
      flexDirection="column"
      marginTop={isStandalone ? 1 : undefined}
      marginLeft={isStandalone ? 2 : undefined}
    >
      {standaloneSummary !== null && <Text dimColor>{standaloneSummary}</Text>}
      {visibleTasks.map(task => {
        const openBlockers = task.status === 'completed' ? [] : openBlockersOf(task)
        const isBlocked = task.status === 'pending' && openBlockers.length > 0
        const ownerIsRunning =
          typeof task.owner === 'string' &&
          task.owner.length > 0 &&
          runningOwners.has(task.owner)
        const ownerSuffix =
          columns >= 60 && task.status !== 'completed' && ownerIsRunning
            ? ` (${task.owner})`
            : ''
        const liveActivity =
          task.status === 'in_progress' &&
          openBlockers.length === 0 &&
          ownerIsRunning &&
          task.owner !== undefined
            ? ownerActivity.get(task.owner)
            : undefined
        const blockerSuffix =
          openBlockers.length > 0
            ? ` ${GLYPH.cursor} blocked by ${openBlockers.map(id => `#${id}`).join(', ')}`
            : ''
        const glyph =
          task.status === 'completed'
            ? GLYPH.check
            : task.status === 'in_progress'
              ? GLYPH.inProgress
              : GLYPH.pending
        const prefixWidth = rowIndent + stringWidth(glyph) + 1
        const suffixWidth = stringWidth(ownerSuffix) + stringWidth(blockerSuffix)
        const maxSubjectWidth = Math.max(10, columns - prefixWidth - suffixWidth)
        const subject = truncateToWidth(task.subject, maxSubjectWidth)

        return (
          <Box key={task.id} flexDirection="column">
            <Box>
              {task.status === 'completed' ? (
                <Text color="success">{glyph} </Text>
              ) : task.status === 'in_progress' ? (
                <Text color="brand">{glyph} </Text>
              ) : (
                <Text dimColor={isBlocked}>{glyph} </Text>
              )}
              <Text
                bold={task.status === 'in_progress'}
                strikethrough={task.status === 'completed'}
                dimColor={task.status === 'completed' || isBlocked}
              >
                {subject}
              </Text>
              {ownerSuffix.length > 0 && <Text dimColor>{ownerSuffix}</Text>}
              {blockerSuffix.length > 0 && <Text dimColor>{blockerSuffix}</Text>}
            </Box>
            {liveActivity !== undefined && (
              <Box paddingLeft={2}>
                <Text dimColor>
                  {truncateToWidth(liveActivity, Math.max(10, columns - rowIndent - 2))}
                </Text>
              </Box>
            )}
          </Box>
        )
      })}
      {hiddenSummary !== null && <Text dimColor>{hiddenSummary}</Text>}
    </Box>
  )
}

export default TaskListV2
