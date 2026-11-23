export type WorktreeSession = {
  sessionId: string
  worktreeName: string
  worktreePath: string
  originalCwd: string
  worktreeBranch?: string
  originalBranch?: string
  originalHeadCommit?: string
  tmuxSessionName?: string
  prepareFailure?: string
  creationDurationMs?: number
  usedSparsePaths?: boolean
}

let currentWorktreeSession: WorktreeSession | null = null

export function getCurrentWorktreeSession(): WorktreeSession | null {
  return currentWorktreeSession
}

export function restoreWorktreeSession(session: WorktreeSession | null): void {
  currentWorktreeSession = session
}
