import * as React from 'react'
import { ExitFlow } from '../../components/ExitFlow.js'
import { MercuryExitConfirm } from '../../components/MercuryExitConfirm.js'
import type { AppState } from '../../state/AppState.js'
import type { SetAppState } from '../../Task.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { liveBackgroundCounts, liveWorkWords, settleOwnerlessTasks } from '../../utils/task/framework.js'
import { gracefulShutdown } from '../../utils/gracefulShutdown.js'
import { getCurrentWorktreeSession } from '../../utils/worktree.js'

const FAREWELL = 'Session saved. Reopen it any time with /sessions.'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: { getAppState?: () => AppState; setAppState?: SetAppState },
): Promise<React.ReactNode> {
  if (getCurrentWorktreeSession()) {
    return <ExitFlow onDone={message => onDone(message ?? undefined)} showWorktree={true} />
  }

  if (context.setAppState) settleOwnerlessTasks(context.setAppState)
  const counts = liveBackgroundCounts(context.getAppState?.().tasks)
  if (counts.total > 0) {
    return (
      <MercuryExitConfirm
        liveWords={liveWorkWords(counts)}
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
