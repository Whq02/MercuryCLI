import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { getCwd } from '../cwd.js'
import { isENOENT } from '../errors.js'
import { execFileNoThrowWithCwd } from '../execFileNoThrow.js'
import { dirIsInGitRepo } from '../git.js'
import { logError } from '../log.js'

/**
 * Gitignore membership check and global-gitignore append. Delegating the
 * check to git means every source (nested .gitignore files, the repository
 * exclude file, the global gitignore) resolves with correct precedence.
 */

/**
 * True only on exit 0. Exit 1 (not ignored) and exit 128 (not a
 * repository) both answer false — callers outside a repository fail open.
 */
export async function isPathGitignored(filePath: string, cwd: string): Promise<boolean> {
  const result = await execFileNoThrowWithCwd('git', ['check-ignore', filePath], { cwd })
  return result.code === 0
}

/** `<home>/.config/git/ignore` — git's global ignore location. */
function getGlobalGitignorePath(): string {
  return join(homedir(), '.config', 'git', 'ignore')
}

/**
 * Appends a `**\/<filename>` rule to the global gitignore when the file is
 * not already ignored. Never throws — every error is logged and swallowed.
 */
export async function addFileGlobRuleToGitignore(filename: string, cwd: string = getCwd()): Promise<void> {
  try {
    if (!(await dirIsInGitRepo(cwd))) return
    // gitignore patterns are POSIX on every platform (backslash is the ESCAPE
    // character): a win32-relative `.mercury\\settings.local.json` appended
    // `**/.mercury\\settings.local.json`, which git reads as the literal
    // `**/.mercurysettings.local.json` — a junk line in the operator's global
    // ignore that never matched, and the dedupe made it permanent (TASK-017 S2,
    // gitignore-rule-written-with-win32-backslashes).
    const entry = `**/${filename.split('\\').join('/')}`
    // For a directory pattern, probe a sample file inside it — a bare
    // directory path may not answer correctly.
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
