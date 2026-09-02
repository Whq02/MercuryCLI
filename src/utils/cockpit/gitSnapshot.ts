// gitSnapshot — the working-tree state via the base getGitState. `unavailable` when
// the cwd is not a repo (a valid UI state, not an error); `failed` if the probe
// throws. Async — callers await in an effect.
import { getGitState, type GitRepoState } from '../git.js'
import { withState, type Snapshot } from './types.js'

export type GitData = { git: GitRepoState | null }

export async function gitSnapshot(): Promise<Snapshot<{ data: GitData }>> {
  try {
    const git = await getGitState()
    if (!git) {
      return withState('unavailable', { git: null }, 'not a git repository', 'getGitState')
    }
    return { state: 'live', source: 'getGitState', data: { git } }
  } catch {
    return withState('failed', { git: null }, 'git unavailable')
  }
}
