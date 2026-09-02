// The todo/task list: owner attribution, blockers, teammate activity lines,
// and a recency-aware truncation priority (recently completed → in progress
// → pending → older completed). Completions count as "recent" for 30
// seconds from the moment this component first observed them; tasks already
// completed on the first render are the baseline and never count.

import figures from 'figures'
import React, { useEffect, useRef, useState } from 'react'
import { Box, Text } from '../ink.js'
import { stringWidth } from '../ink/stringWidth.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { useAppState } from '../state/AppState.js'
import {
  isInProcessTeammateTask,
  type InProcessTeammateTaskState,
} from '../tasks/InProcessTeammateTask/types.js'
import { describeTeammateActivity } from './tasks/taskStatusUtils.js'
import { isAgentSwarmsEnabled } from '../utils/agentSwarmsEnabled.js'
import { toInkColor } from '../utils/ink.js'
import { isTodoV2Enabled, type Task } from '../utils/tasks.js'
import { truncateToWidth } from '../utils/truncate.js'

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
  tasks: Task[]
  isStandalone?: boolean
}): React.ReactNode {
  const { rows, columns } = useTerminalSize()
  const appTasks = useAppState(state => state.tasks)
  const [, forceRender] = useState(0)

  // ── recent-completion tracking ────────────────────────────────────────
  const completedAtRef = useRef(new Map<string, number>())
  const baselineRef = useRef<Set<string> | null>(null)
  if (baselineRef.current === null) {
    baselineRef.current = new Set(
      tasks.filter(task => task.status === 'completed').map(task => task.id),
    )
  }
  const now = Date.now()
  for (const task of tasks) {
    if (task.status === 'completed') {
      if (
        !baselineRef.current.has(task.id) &&
        !completedAtRef.current.has(task.id)
      ) {
        completedAtRef.current.set(task.id, now)
      }
    } else if (completedAtRef.current.has(task.id)) {
      completedAtRef.current.delete(task.id)
    } else if (baselineRef.current.has(task.id)) {
      baselineRef.current.delete(task.id)
    }
  }
  const isRecent = (task: Task): boolean => {
    if (task.status !== 'completed') return false
    const at = completedAtRef.current.get(task.id)
    return at !== undefined && now - at < RECENT_COMPLETION_MS
  }

  // A timer scheduled to the earliest upcoming expiry forces a re-render —
  // dependent on the task list, not on every render.
  useEffect(() => {
    let earliest: number | null = null
    for (const task of tasks) {
      const at = completedAtRef.current.get(task.id)
      if (at === undefined) continue
      const expiry = at + RECENT_COMPLETION_MS
      if (expiry > Date.now() && (earliest === null || expiry < earliest)) {
        earliest = expiry
      }
    }
    if (earliest === null) return
    const timer = setTimeout(
      () => {
        forceRender(count => count + 1)
      },
      Math.max(0, earliest - Date.now()),
    )
    return () => {
      clearTimeout(timer)
    }
  }, [tasks])

  // Hooks above run unconditionally; the capability and emptiness checks
  // come after.
  if (!isTodoV2Enabled() || tasks.length === 0) return null

  // ── teammate owner colouring and activity ─────────────────────────────
  const swarmOn = isAgentSwarmsEnabled()
  const ownerColors = new Map<string, string>()
  const ownerActivities = new Map<string, string>()
  const runningOwners = new Set<string>()
  const teammateTasks = Object.values(appTasks ?? {}).filter(
    isInProcessTeammateTask,
  ) as InProcessTeammateTaskState[]
  for (const teammate of teammateTasks) {
    const name = teammate.identity.agentName
    if (swarmOn && teammate.identity.color) {
      // Registered under the teammate's NAME only.
      ownerColors.set(name, toInkColor(teammate.identity.color) as string)
    }
    if (!teammate.isIdle) {
      // Task owners may be written either way — register both spellings.
      const activity = describeTeammateActivity(teammate)
      ownerActivities.set(name, activity)
      ownerActivities.set(teammate.identity.agentId, activity)
      runningOwners.add(name)
      runningOwners.add(teammate.identity.agentId)
    }
  }

  const byStatus = (task: Task): 'completed' | 'in_progress' | 'pending' =>
    task.status

  const isBlocked = (task: Task): boolean =>
    task.blockedBy.some(blockerId => {
      const blocker = tasks.find(t => t.id === blockerId)
      return blocker !== undefined && blocker.status !== 'completed'
    })

  // ── display budget and truncation ─────────────────────────────────────
  const maxRows = rows <= 10 ? 0 : Math.min(10, Math.max(3, rows - 14))
  let visible: Task[]
  let hidden: Task[]
  if (tasks.length <= maxRows) {
    visible = [...tasks].sort((a, b) => compareIds(a.id, b.id))
    hidden = []
  } else {
    const recent = tasks.filter(isRecent).sort((a, b) => compareIds(a.id, b.id))
    const inProgress = tasks
      .filter(task => byStatus(task) === 'in_progress')
      .sort((a, b) => compareIds(a.id, b.id))
    const pending = tasks
      .filter(task => byStatus(task) === 'pending')
      .sort((a, b) => {
        // Unblocked before blocked, then by id.
        const ab = isBlocked(a) ? 1 : 0
        const bb = isBlocked(b) ? 1 : 0
        if (ab !== bb) return ab - bb
        return compareIds(a.id, b.id)
      })
    const older = tasks
      .filter(task => byStatus(task) === 'completed' && !isRecent(task))
      .sort((a, b) => compareIds(a.id, b.id))
    const prioritized = [...recent, ...inProgress, ...pending, ...older]
    visible = prioritized
      .slice(0, maxRows)
      .sort((a, b) => compareIds(a.id, b.id))
    hidden = prioritized.slice(maxRows)
  }

  const hiddenSummary = ((): string | null => {
    if (hidden.length === 0 || maxRows === 0) return null
    const counts = { in_progress: 0, pending: 0, completed: 0 }
    for (const task of hidden) counts[byStatus(task)] += 1
    const parts: string[] = []
    if (counts.in_progress > 0) parts.push(`${counts.in_progress} in progress`)
    if (counts.pending > 0) parts.push(`${counts.pending} pending`)
    if (counts.completed > 0) parts.push(`${counts.completed} completed`)
    return `${figures.ellipsis} +${hidden.length} (${parts.join(', ')})`
  })()

  const doneCount = tasks.filter(t => t.status === 'completed').length
  const inProgressCount = tasks.filter(t => t.status === 'in_progress').length
  const openCount = tasks.length - doneCount - inProgressCount

  const rowsOut = visible.map(task => {
    const blocked = isBlocked(task)
    const ownerName = task.owner
    const ownerRunning = ownerName !== undefined && runningOwners.has(ownerName)
    const showOwner = ownerName !== undefined && columns >= 60 && ownerRunning
    const ownerSuffix = showOwner ? ` (@${ownerName})` : ''
    const ownerWidth = showOwner ? stringWidth(ownerSuffix) : 0
    const subject = truncateToWidth(
      task.subject,
      Math.max(15, columns - 15 - ownerWidth),
    )
    const activity =
      task.status === 'in_progress' && !blocked && ownerName !== undefined
        ? ownerActivities.get(ownerName)
        : undefined
    const openBlockers = task.blockedBy
      .filter(blockerId => {
        const blocker = tasks.find(t => t.id === blockerId)
        return blocker !== undefined && blocker.status !== 'completed'
      })
      .sort(compareIds)

    let glyph: React.ReactNode
    if (task.status === 'completed') {
      glyph = <Text color="success">{figures.tick} </Text>
    } else if (task.status === 'in_progress') {
      glyph = <Text color="brand">{figures.squareSmallFilled} </Text>
    } else {
      glyph = <Text>{figures.squareSmall} </Text>
    }

    return (
      <Box key={task.id} flexDirection="column">
        <Box>
          {glyph}
          <Text
            bold={task.status === 'in_progress'}
            strikethrough={task.status === 'completed'}
            dimColor={task.status === 'completed' || blocked}
          >
            {subject}
          </Text>
          {showOwner ? (
            <Text dimColor>
              {' (@'}
              <Text color={ownerColors.get(ownerName)} dimColor>
                {ownerName}
              </Text>
              {')'}
            </Text>
          ) : null}
          {blocked && openBlockers.length > 0 ? (
            <Text dimColor>
              {' '}
              {figures.pointerSmall} blocked by{' '}
              {openBlockers.map(id => `#${id}`).join(', ')}
            </Text>
          ) : null}
        </Box>
        {activity !== undefined ? (
          <Box paddingLeft={2}>
            <Text dimColor>
              {truncateToWidth(activity, Math.max(15, columns - 15))}
              {figures.ellipsis}
            </Text>
          </Box>
        ) : null}
      </Box>
    )
  })

  const body = (
    <Box flexDirection="column">
      {isStandalone ? (
        <Text dimColor>
          <Text bold dimColor>
            {tasks.length}
          </Text>{' '}
          tasks ·{' '}
          <Text bold dimColor>
            {doneCount}
          </Text>{' '}
          done
          {inProgressCount > 0 ? (
            <>
              {' · '}
              <Text bold dimColor>
                {inProgressCount}
              </Text>{' '}
              in progress
            </>
          ) : null}
          {' · '}
          <Text bold dimColor>
            {openCount}
          </Text>{' '}
          open
        </Text>
      ) : null}
      {maxRows > 0 ? rowsOut : null}
      {hiddenSummary !== null ? <Text dimColor>{hiddenSummary}</Text> : null}
    </Box>
  )

  if (isStandalone) {
    return (
      <Box marginTop={1} marginLeft={2} flexDirection="column">
        {body}
      </Box>
    )
  }
  return body
}

export default TaskListV2
