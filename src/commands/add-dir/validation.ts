import { statSync } from 'node:fs'
import { resolve, sep, dirname } from 'node:path'
import chalk from 'chalk'
import type { ToolPermissionContext } from '../../Tool.js'
import { allWorkingDirectories, pathInWorkingPath } from '../../utils/permissions/filesystem.js'
import { expandPath } from '../../utils/path.js'
import { getErrnoCode } from '../../utils/errors.js'

/**
 * Pure validation for a workspace-directory candidate, shared by the
 * `/add-dir` command and the boot-time pass over settings-configured
 * additional directories.
 */
export type AddDirectoryResult =
  | { resultType: 'success'; absolutePath: string }
  | { resultType: 'emptyPath' }
  | { resultType: 'pathNotFound'; directoryPath: string; absolutePath: string }
  | { resultType: 'notADirectory'; directoryPath: string; absolutePath: string }
  | { resultType: 'alreadyInWorkingDirectory'; directoryPath: string; workingDir: string }

/**
 * Stat errors that degrade to "not found" instead of rethrowing. The same
 * validator runs during boot over directories a user put in settings; an
 * unreadable entry there must not abort the whole start.
 */
const TOLERATED_STAT_ERRNOS = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'])

/** Drop any trailing separator so `/foo` and `/foo/` produce one key.
 *  Exported for the boot pass: an explicitly named directory that is already
 *  contained in a working root still joins the WORKSPACE list (the bare-mode
 *  law: never refuse a directory the operator named), under the same key
 *  shape the map uses. */
export function resolveWithoutTrailingSeparator(path: string): string {
  const expanded = expandPath(path)
  const trimmed =
    expanded.length > 1 && expanded.endsWith(sep) ? expanded.slice(0, -sep.length) : expanded
  return resolve(trimmed)
}

export async function validateDirectoryForWorkspace(
  directoryPath: string,
  permissionContext: ToolPermissionContext,
): Promise<AddDirectoryResult> {
  if (!directoryPath) {
    return { resultType: 'emptyPath' }
  }

  const absolutePath = resolveWithoutTrailingSeparator(directoryPath)

  try {
    const stats = statSync(absolutePath)
    if (!stats.isDirectory()) {
      return { resultType: 'notADirectory', directoryPath, absolutePath }
    }
  } catch (error) {
    const code = getErrnoCode(error)
    if (code !== undefined && TOLERATED_STAT_ERRNOS.has(code)) {
      return { resultType: 'pathNotFound', directoryPath, absolutePath }
    }
    throw error
  }

  // Walked in order; the first working directory that already contains the
  // candidate wins.
  for (const workingDir of allWorkingDirectories(permissionContext)) {
    if (pathInWorkingPath(absolutePath, workingDir)) {
      return { resultType: 'alreadyInWorkingDirectory', directoryPath, workingDir }
    }
  }

  return { resultType: 'success', absolutePath }
}

/** The user-facing sentence for each validation outcome (total over the union). */
export function addDirHelpMessage(result: AddDirectoryResult): string {
  switch (result.resultType) {
    case 'emptyPath':
      return 'Provide a directory path to add.'
    case 'pathNotFound':
      return `Path not found: ${chalk.bold(result.absolutePath)}`
    case 'notADirectory':
      return `${chalk.bold(result.directoryPath)} is not a directory — did you mean its parent, ${chalk.bold(dirname(result.absolutePath))}?`
    case 'alreadyInWorkingDirectory':
      return `${chalk.bold(result.directoryPath)} is already covered by the working directory ${chalk.bold(result.workingDir)}`
    case 'success':
      return `Added ${chalk.bold(result.absolutePath)} as a working directory.`
  }
}
