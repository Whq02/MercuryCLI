import { notBuilt } from '../../pi/holes.js'

export async function isPathGitignored(filePath: string, cwd: string): Promise<boolean> {
  return notBuilt('src/utils/git/gitignore.ts:12')
}

export async function addFileGlobRuleToGitignore(filename: string, cwd?: string): Promise<void> {
  return notBuilt('src/utils/git/gitignore.ts:21')
}
