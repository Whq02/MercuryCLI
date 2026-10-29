
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
