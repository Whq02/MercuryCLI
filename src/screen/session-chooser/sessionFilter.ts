import type { SessionListing } from '../../sessions/transcripts/transcriptEntries.js'
import { workspaceRecognizedByGround } from '../boot-face/bootCardFacts.js'



export function isProjectSession(log: SessionListing, root: string): boolean {
  const raw = (log.projectPath ?? '').trim()
  if (!raw) return true
  if (!root.replace(/[\\/]+$/, '')) return true
  return workspaceRecognizedByGround(root, raw)
}

export function partitionByProject(
  logs: readonly SessionListing[],
  root: string,
): { inProject: SessionListing[]; elsewhere: SessionListing[] } {
  const inProject: SessionListing[] = []
  const elsewhere: SessionListing[] = []
  for (const l of logs) (isProjectSession(l, root) ? inProject : elsewhere).push(l)
  return { inProject, elsewhere }
}
