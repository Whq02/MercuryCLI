import * as React from 'react'
import { ExitFlow } from '../../components/ExitFlow.js'
import { ExitHandoff } from '../../components/ExitHandoff.js'
import { MercuryExitConfirm } from '../../components/MercuryExitConfirm.js'
import { exitNoteDue } from '../../mneme/exitHandoff.js'
import type { AppState } from '../../state/AppState.js'
import type { SetAppState } from '../../Task.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { liveBackgroundCounts, liveWorkWords, settleOwnerlessTasks } from '../../utils/task/framework.js'
import { gracefulShutdown } from '../../utils/gracefulShutdown.js'
import { getCurrentWorktreeSession } from '../../utils/worktree.js'

const FAREWELL = 'Session saved. Reopen it any time with /sessions.'

function ExitWithNote({ liveWords, onDone }: { liveWords: string | null; onDone: LocalJSXCommandOnDone }): React.ReactNode {
  const [phase, setPhase] = React.useState<'confirm' | 'note'>(liveWords === null ? 'note' : 'confirm')
  const quit = (): void => {
    onDone(FAREWELL)
    void gracefulShutdown(0, 'quit')
  }
  if (phase === 'confirm' && liveWords !== null) {
    return <MercuryExitConfirm liveWords={liveWords} onStay={() => onDone()} onQuit={() => (exitNoteDue() ? setPhase('note') : quit())} />
  }
  return <ExitHandoff onSettled={quit} />
}

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
    return <ExitWithNote liveWords={liveWorkWords(counts)} onDone={onDone} />
  }

  if (exitNoteDue()) return <ExitWithNote liveWords={null} onDone={onDone} />

  onDone(FAREWELL)
  await gracefulShutdown(0, 'quit')
  return null
}
