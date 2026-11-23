import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { getCwd } from '../cwd.js'
import { isENOENT } from '../errors.js'
import { execFileNoThrowWithCwd } from '../execFileNoThrow.js'
import { logError } from '../log.js'
import { xdgAndRoamingConfigRoots } from '../platform/files.js'
import { gitExe } from './gitExe.js'
import { findGitRoot } from './gitRoot.js'

export async function isPathGitignored(filePath: string, cwd: string): Promise<boolean> {
  const result = await execFileNoThrowWithCwd(gitExe(), ['check-ignore', '--quiet', '--', filePath], {
    cwd,
    preserveOutputOnError: false,
  })
  return result.code === 0
}

async function resolveGlobalIgnoreFile(cwd: string): Promise<string> {
  const result = await execFileNoThrowWithCwd(
    gitExe(),
    ['config', '--global', '--path', 'core.excludesFile'],
    { cwd, preserveOutputOnError: false },
  )
  const configured = result.code === 0 ? result.stdout.trim() : ''
  if (configured !== '') return configured
  return join(xdgAndRoamingConfigRoots()[0]!, 'git', 'ignore')
}

export async function addFileGlobRuleToGitignore(filename: string, cwd?: string): Promise<void> {
  try {
    const dir = cwd ?? getCwd()
    if (findGitRoot(dir) === null) return

    const normalized = filename.replace(/\\/g, '/')
    const probePath = normalized.endsWith('/') ? `${normalized}sample-file` : normalized
    if (await isPathGitignored(probePath, dir)) return

    const entry = normalized.startsWith('**/') ? normalized : `**/${normalized.replace(/^\/+/, '')}`
    const ignoreFile = await resolveGlobalIgnoreFile(dir)
    await mkdir(dirname(ignoreFile), { recursive: true })

    let existing: string | null = null
    try {
      existing = await readFile(ignoreFile, 'utf8')
    } catch (error) {
      if (!isENOENT(error)) throw error
    }
    if (existing !== null && existing.includes(entry)) return

    const prefix =
      existing === null || existing === ''
        ? ''
        : existing.endsWith('\n')
          ? existing
          : `${existing}\n`
    await writeFile(ignoreFile, `${prefix}${entry}\n`, 'utf8')
  } catch (error) {
    logError(error)
  }
}
