import * as React from 'react'
import { ExitFlow } from '../../components/ExitFlow.js'
import { ExitHandoff, noteAskedAtExit, type ExitNoteReceipt } from '../../components/ExitHandoff.js'
import { exitFarewell } from '../../mneme/exitHandoff.js'
import { MercuryExitConfirm } from '../../components/MercuryExitConfirm.js'
import { getFocusedSessionConnector, hasFocusedSession, subscribeThroughFocused } from '../../services/engine-connector/focusedConnector.js'
import { workCounts } from '../../services/engine-connector/workCounts.js'
import { useAppStateMaybeOutsideOfProvider } from '../../state/AppState.js'
import type { AppState } from '../../state/AppState.js'
import type { SetAppState } from '../../Task.js'
import type { TaskState } from '../../tasks/types.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { liveBackgroundCounts, liveWorkWords, settleOwnerlessTasks, type LiveWorkCounts } from '../../utils/task/framework.js'
import { gracefulShutdown } from '../../utils/gracefulShutdown.js'
import { getCurrentWorktreeSession } from '../../utils/worktree.js'
import { farewellWithTesterDoor } from '../feedback/testerDoor.js'

const FAREWELL = 'Session saved. Reopen it any time with /sessions.'

const subscribeFocusedWork = subscribeThroughFocused((connector, listener) => connector.subscribeWork(listener))

function readHostedWorkKey(): string {
  if (!hasFocusedSession()) return '0:0'
  const hosted = workCounts(getFocusedSessionConnector().workRoster().rows)
  return `${hosted.shells}:${hosted.agents}`
}

export function liveWorkAtExit(tasks: Record<string, TaskState> | undefined): LiveWorkCounts {
  const counts = liveBackgroundCounts(tasks)
  if (!hasFocusedSession()) return counts
  const hosted = workCounts(getFocusedSessionConnector().workRoster().rows)
  return {
    total: counts.total + hosted.shells + hosted.agents,
    shells: counts.shells + hosted.shells,
    agents: counts.agents + hosted.agents,
    other: counts.other,
  }
}

function ExitWithNote({
  confirm,
  getTasks,
  onDone,
}: {
  confirm: boolean
  getTasks?: () => Record<string, TaskState> | undefined
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const [phase, setPhase] = React.useState<'confirm' | 'note'>(confirm ? 'confirm' : 'note')
  const storeTasks = useAppStateMaybeOutsideOfProvider(s => s.tasks)
  const hostedKey = React.useSyncExternalStore(subscribeFocusedWork, readHostedWorkKey, readHostedWorkKey)
  void hostedKey
  const quit = (receipt?: ExitNoteReceipt): void => {
    const base = receipt === undefined ? FAREWELL : exitFarewell(FAREWELL, receipt.note, receipt.noteChars)
    const farewell = receipt?.detail !== undefined && receipt.detail !== '' ? `${base}\n${receipt.detail}` : base
    onDone(farewell)
    void gracefulShutdown(0, 'quit', { finalMessage: farewellWithTesterDoor(farewell) })
  }
  if (phase === 'confirm') {
    const counts = liveWorkAtExit(storeTasks ?? getTasks?.())
    return (
      <MercuryExitConfirm
        liveWords={liveWorkWords(counts)}
        hasRunning={counts.total > 0}
        onStay={() => onDone()}
        onQuit={() => (noteAskedAtExit() ? setPhase('note') : quit())}
      />
    )
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
  const getTasks = context.getAppState ? () => context.getAppState?.().tasks : undefined
  const counts = liveWorkAtExit(getTasks?.())
  if (counts.total > 0) {
    return <ExitWithNote confirm={true} getTasks={getTasks} onDone={onDone} />
  }

  if (noteAskedAtExit()) return <ExitWithNote confirm={false} getTasks={getTasks} onDone={onDone} />

  onDone(FAREWELL)
  await gracefulShutdown(0, 'quit', { finalMessage: farewellWithTesterDoor(FAREWELL) })
  return null
}
