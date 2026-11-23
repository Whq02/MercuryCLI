import figures from 'figures'
import { GLYPH } from '../utils/glyphs.js'
import React, { useRef, useState } from 'react'
import { Box, Text } from '../ink.js'
import { stringWidth } from '../ink/stringWidth.js'
import { useTimer } from '../hooks/effects.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { isTaskToolsEnabled } from '../utils/tasks.js'

type TaskRowV2 = { id: string; status: 'pending' | 'in_progress' | 'completed'; subject: string; blockedBy?: readonly string[]; owner?: string }
import { truncateToWidth } from '../utils/truncate.js'
import { startTimeout, stopTimeout } from '../utils/timers.js'

const RECENT_COMPLETION_MS = 30_000

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
        const showOwner =
          columns >= 60 &&
          task.status === 'in_progress' &&
          openBlockers.length === 0 &&
          typeof task.owner === 'string' &&
          task.owner.length > 0
        const ownerSuffix = showOwner ? ` (${task.owner})` : ''
        const blockerSuffix =
          openBlockers.length > 0
            ? ` ${figures.pointerSmall} blocked by ${openBlockers.map(id => `#${id}`).join(', ')}`
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
          <Box key={task.id} flexDirection="row">
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
        )
      })}
      {hiddenSummary !== null && <Text dimColor>{hiddenSummary}</Text>}
    </Box>
  )
}

export default TaskListV2
