import { statSync } from 'node:fs'
import { resolve, sep, dirname } from 'node:path'
import chalk from 'chalk'
import type { ToolPermissionContext } from '../../Tool.js'
import { allWorkingDirectories, pathInWorkingPath } from '../../utils/permissions/filesystem.js'
import { expandPath } from '../../utils/path.js'
import { getErrnoCode } from '../../utils/errors.js'

export type AddDirectoryResult =
  | { resultType: 'success'; absolutePath: string }
  | { resultType: 'emptyPath' }
  | { resultType: 'pathNotFound'; directoryPath: string; absolutePath: string }
  | { resultType: 'notADirectory'; directoryPath: string; absolutePath: string }
  | { resultType: 'alreadyInWorkingDirectory'; directoryPath: string; workingDir: string }

const TOLERATED_STAT_ERRNOS = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'])

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

  for (const workingDir of allWorkingDirectories(permissionContext)) {
    if (pathInWorkingPath(absolutePath, workingDir)) {
      return { resultType: 'alreadyInWorkingDirectory', directoryPath, workingDir }
    }
  }

  return { resultType: 'success', absolutePath }
}

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
