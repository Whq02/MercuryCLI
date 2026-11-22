import { notBuilt, type Unbuilt } from '../../pi/holes.js'

export type BashTaskKind = Unbuilt

export type ShellKillSource = Unbuilt

export type LocalShellTaskState = Unbuilt

export function isLocalShellTask(task: unknown): task is LocalShellTaskState {
  return notBuilt('src/tasks/LocalShellTask/guards.ts:29')
}
