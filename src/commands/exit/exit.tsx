import * as React from 'react'
import { ExitFlow } from '../../components/ExitFlow.js'
import { MercuryExitConfirm } from '../../components/MercuryExitConfirm.js'
import type { AppState } from '../../state/AppState.js'
import { isBackgroundTask, type TaskState } from '../../tasks/types.js'
import { isTerminalTaskStatus } from '../../Task.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { gracefulShutdown } from '../../utils/gracefulShutdown.js'
import { getCurrentWorktreeSession } from '../../utils/worktree.js'

const FAREWELL = 'Session saved. Reopen it any time with /sessions.'

function liveBackgroundCount(getAppState?: () => AppState): number {
  if (!getAppState) return 0
  const tasks: Record<string, TaskState> = getAppState().tasks ?? {}
  let count = 0
  for (const task of Object.values(tasks)) {
    if (isBackgroundTask(task) && !isTerminalTaskStatus(task.status)) count++
  }
  return count
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: { getAppState?: () => AppState },
): Promise<React.ReactNode> {
  if (getCurrentWorktreeSession()) {
    return <ExitFlow onDone={message => onDone(message ?? undefined)} showWorktree={true} />
  }

  const count = liveBackgroundCount(context.getAppState)
  if (count > 0) {
    return (
      <MercuryExitConfirm
        liveCount={count}
        onStay={() => onDone()}
        onQuit={() => {
          onDone(FAREWELL)
          void gracefulShutdown(0, 'prompt_input_exit')
        }}
      />
    )
  }

  onDone(FAREWELL)
  await gracefulShutdown(0, 'prompt_input_exit')
  return null
}
