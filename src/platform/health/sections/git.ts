import { gitProbeNote } from '../../git/git.js'
import { branchChip } from '../../../screen/theme/glyphs.js'
import { sha7 } from '../healthCertCore.js'
import { homeRepositoryCheck, projectEstateCheck, type CheckSpec, type HealthContext } from '../healthReport.js'

export function gitChecks(context: HealthContext): CheckSpec[] {
  const { git, repo } = context
  return [
    {
      id: 'git',
      label: 'Working tree',
      run: () => {
        if (git.state === 'unavailable' || repo === null) {
          return {
            status: 'info',
            evidence: git.reason ?? 'not a git repository',
          }
        }
        if (git.state !== 'live') {
          return {
            status: 'unknown',
            evidence: git.reason ?? 'git probe failed',
          }
        }
        const parts = [
          `${branchChip(repo.branchName)} @ ${sha7(repo.commitHash)}`,
          repo.isClean ? 'clean' : 'uncommitted changes',
        ]
        if (repo.unpushedCount > 0) parts.push(`${repo.unpushedCount} unpushed`)
        else if (repo.remoteUrl === null) parts.push('no remote configured')
        else if (!repo.isHeadOnRemote) parts.push('no upstream for this branch')
        const note = gitProbeNote()
        if (note !== null) return { status: 'warn', evidence: `${parts.join(' · ')} · ${note}` }
        return { status: 'ok', evidence: parts.join(' · ') + ' (getGitState)' }
      },
    },
    {
      id: 'home-repository',
      label: 'Home repository',
      probe: 'functional',
      run: () => homeRepositoryCheck(),
    },
    {
      id: 'project-estate',
      label: 'Project estate',
      probe: 'functional',
      run: () => projectEstateCheck(),
    },
  ]
}
