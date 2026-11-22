import { notBuilt, type Unbuilt } from '../../pi/holes.js'

export type WorktreeSession = Unbuilt

export function getCurrentWorktreeSession(): WorktreeSession | null {
  return notBuilt('src/utils/worktree/session.ts:17')
}

export function restoreWorktreeSession(session: WorktreeSession | null): void {
  return notBuilt('src/utils/worktree/session.ts:21')
}
