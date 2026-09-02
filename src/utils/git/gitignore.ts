import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { getCwd } from '../cwd.js'
import { isENOENT } from '../errors.js'
import { execFileNoThrowWithCwd } from '../execFileNoThrow.js'
import { dirIsInGitRepo } from '../git.js'
import { logError } from '../log.js'


export async function isPathGitignored(filePath: string, cwd: string): Promise<boolean> {
  const result = await execFileNoThrowWithCwd('git', ['check-ignore', filePath], { cwd })
  return result.code === 0
}

function getGlobalGitignorePath(): string {
  return join(homedir(), '.config', 'git', 'ignore')
}

export async function addFileGlobRuleToGitignore(filename: string, cwd: string = getCwd()): Promise<void> {
  try {
    if (!(await dirIsInGitRepo(cwd))) return
    const entry = `**/${filename.split('\\').join('/')}`
    const probePath = filename.endsWith('/') ? `${entry}sample-file` : entry
    if (await isPathGitignored(probePath, cwd)) return

    const globalIgnorePath = getGlobalGitignorePath()
    await mkdir(dirname(globalIgnorePath), { recursive: true })
    try {
      const existing = await readFile(globalIgnorePath, 'utf8')
      if (existing.includes(entry)) return
      await writeFile(globalIgnorePath, `${existing}\n${entry}\n`)
    } catch (readError) {
      if (!isENOENT(readError)) throw readError
      await writeFile(globalIgnorePath, `${entry}\n`)
    }
  } catch (error) {
    logError(error)
  }
}
