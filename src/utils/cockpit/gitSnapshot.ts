import { getGitState, type GitRepoState } from '../git.js'
import { withState, type Snapshot } from './types.js'

export type GitData = { git: GitRepoState | null }

export async function gitSnapshot(opts?: { fresh?: boolean }): Promise<Snapshot<{ data: GitData }>> {
  try {
    const git = await getGitState(opts?.fresh ? { fresh: true } : undefined)
    if (!git) {
      return withState('unavailable', { git: null }, 'not a git repository', 'getGitState')
    }
    return { state: 'live', source: 'getGitState', data: { git } }
  } catch {
    return withState('failed', { git: null }, 'git unavailable')
  }
}
