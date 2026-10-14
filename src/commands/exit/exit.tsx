import * as React from 'react'
import { ExitFlow } from '../../components/ExitFlow.js'
import { ExitHandoff, noteAskedAtExit, type ExitNoteReceipt } from '../../components/ExitHandoff.js'
import { exitFarewell } from '../../mneme/exitHandoff.js'
import { MercuryExitConfirm } from '../../components/MercuryExitConfirm.js'
import { getFocusedSessionConnector, hasFocusedSession } from '../../services/engine-connector/focusedConnector.js'
import { workCounts } from '../../services/engine-connector/workCounts.js'
import type { AppState } from '../../state/AppState.js'
import type { SetAppState } from '../../Task.js'
import type { TaskState } from '../../tasks/types.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { liveBackgroundCounts, liveWorkWords, settleOwnerlessTasks, type LiveWorkCounts } from '../../utils/task/framework.js'
import { gracefulShutdown } from '../../utils/gracefulShutdown.js'
import { getCurrentWorktreeSession } from '../../utils/worktree.js'
import { farewellWithTesterDoor } from '../feedback/testerDoor.js'

const FAREWELL = 'Session saved. Reopen it any time with /sessions.'

export function liveWorkAtExit(tasks: Record<string, TaskState> | undefined): LiveWorkCounts {
  const counts = liveBackgroundCounts(tasks)
  if (!hasFocusedSession()) return counts
  const hosted = workCounts(getFocusedSessionConnector().workRoster().rows)
  return {
    total: counts.total + hosted.shells + hosted.agents + hosted.workflows,
    shells: counts.shells + hosted.shells,
    agents: counts.agents + hosted.agents,
    workflows: counts.workflows + hosted.workflows,
    other: counts.other,
  }
}

function ExitWithNote({ liveWords, onDone }: { liveWords: string | null; onDone: LocalJSXCommandOnDone }): React.ReactNode {
  const [phase, setPhase] = React.useState<'confirm' | 'note'>(liveWords === null ? 'note' : 'confirm')
  const quit = (receipt?: ExitNoteReceipt): void => {
    const farewell = receipt === undefined ? FAREWELL : exitFarewell(FAREWELL, receipt.note, receipt.noteChars)
    onDone(farewell)
    void gracefulShutdown(0, 'quit', { finalMessage: farewellWithTesterDoor(farewell) })
  }
  if (phase === 'confirm' && liveWords !== null) {
    return <MercuryExitConfirm liveWords={liveWords} onStay={() => onDone()} onQuit={() => (noteAskedAtExit() ? setPhase('note') : quit())} />
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
  const counts = liveWorkAtExit(context.getAppState?.().tasks)
  if (counts.total > 0) {
    return <ExitWithNote liveWords={liveWorkWords(counts)} onDone={onDone} />
  }

  if (noteAskedAtExit()) return <ExitWithNote liveWords={null} onDone={onDone} />

  onDone(FAREWELL)
  await gracefulShutdown(0, 'quit', { finalMessage: farewellWithTesterDoor(FAREWELL) })
  return null
}
