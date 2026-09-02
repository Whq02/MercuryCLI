import * as React from 'react'
import { ExitFlow } from '../../components/ExitFlow.js'
import { MercuryExitConfirm } from '../../components/MercuryExitConfirm.js'
import type { AppState } from '../../state/AppState.js'
import { isBackgroundTask, type TaskState } from '../../tasks/types.js'
import { isTerminalTaskStatus } from '../../Task.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { gracefulShutdown } from '../../utils/gracefulShutdown.js'
import { getCurrentWorktreeSession } from '../../utils/worktree.js'

/** The session is saved; name the way back. Plain and directive. */
const FAREWELL = 'Session saved. Reopen it any time with /sessions.'

/** Background tasks still doing work — the only reason to interpose a prompt. */
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
  // Inside a worktree the exit flow owns settlement.
  if (getCurrentWorktreeSession()) {
    return <ExitFlow onDone={message => onDone(message ?? undefined)} showWorktree={true} />
  }

  const count = liveBackgroundCount(context.getAppState)
  if (count > 0) {
    // Quitting would kill background work the user may not have noticed —
    // the one case that earns a confirmation step.
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

  // The common path pays no confirmation.
  onDone(FAREWELL)
  await gracefulShutdown(0, 'prompt_input_exit')
  return null
}
