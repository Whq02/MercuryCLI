// Status parenthetical for shell tasks + the shared status-text element
// The shell map substitutes its own words: completed → done,
// failed → error, killed → stopped, running/pending → the running word.

import React from 'react'
import { Text } from '../../ink.js'
import type { LocalShellTaskState } from '../../tasks/LocalShellTask/guards.js'

function shellStatusWord(status: string): string {
  switch (status) {
    case 'completed':
      return 'done'
    case 'failed':
      return 'error'
    case 'killed':
      return 'stopped'
    default:
      return 'running'
  }
}

function statusColor(
  status: string,
): 'success' | 'error' | 'warning' | undefined {
  switch (status) {
    case 'completed':
      return 'success'
    case 'failed':
      return 'error'
    case 'killed':
      return 'warning'
    default:
      return undefined
  }
}

/** The shared parenthetical: always dim, always parenthesised; the colour
 *  rides the terminal status. */
export function TaskStatusText({
  status,
  label,
  suffix,
}: {
  status: string
  label?: string
  suffix?: string
}): React.ReactNode {
  return (
    <Text color={statusColor(status)} dimColor>
      ({label ?? status}
      {suffix ? ` ${suffix}` : ''})
    </Text>
  )
}

export function ShellProgress({
  shell,
}: {
  shell: LocalShellTaskState
}): React.ReactNode {
  return (
    <TaskStatusText status={shell.status} label={shellStatusWord(shell.status)} />
  )
}
