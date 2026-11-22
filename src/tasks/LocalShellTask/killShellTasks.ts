import type { SetAppState } from '../../Task.js'
import type { AppState } from '../../state/AppState.js'
import type { ShellKillSource } from './guards.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

type KillSettlement = Unbuilt

export function killTask(taskId: string, setAppState: SetAppState, killedBy?: ShellKillSource): Promise<KillSettlement> {
  return notBuilt('src/tasks/LocalShellTask/killShellTasks.ts:25')
}

export function killShellTasksForAgent(
  agentId: string | undefined,
  getAppState: () => AppState,
  setAppState: SetAppState,
): void {
  return notBuilt('src/tasks/LocalShellTask/killShellTasks.ts:121')
}
