import memoize from 'lodash-es/memoize.js'

import { getCwd } from '../files/cwd.js'
import { execFileNoThrowWithCwd } from '../processes/execFileNoThrow.js'
import { gitExe } from '../git/git.js'

export function resetUserCache(): void {
  getGitEmail.cache?.clear?.()
}

export const getGitEmail = memoize(async (): Promise<string | undefined> => {
  const result = await execFileNoThrowWithCwd(gitExe(), ['config', '--get', 'user.email'], {
    cwd: getCwd(),
    preserveOutputOnError: false,
  })
  if (result.code !== 0) return undefined
  const trimmed = result.stdout.trim()
  return trimmed !== '' ? trimmed : undefined
})
