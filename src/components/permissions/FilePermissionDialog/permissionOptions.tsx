import * as React from 'react'
import { homedir } from 'node:os'
import { isAbsolute, relative, sep as platformSep, win32 } from 'node:path'
import { Text } from '../../../ink.js'
import type { OptionWithDescription } from '../../CustomSelect/select.js'
import { getFocusedSessionConnector } from '../../../services/engine-connector/focusedConnector.js'
import { getShortcutDisplay } from '../../../keybindings/shortcutFormat.js'
import { isRemotePath, remoteHostLabel } from '../../../utils/remoteFiles/target.js'
import { getMercuryHome } from '../../../utils/envUtils.js'
import { hostEnv } from '../../../utils/hostEnv.js'
import { expandPath, getDirectoryForPath, toTildePath } from '../../../utils/path.js'
import {
  generateSuggestions,
  normalizeCaseForComparison,
  pathInAllowedWorkingPath,
} from '../../../utils/permissions/filesystem.js'
import { PROJECT_CONFIG_DIR_NAMES } from '../../../utils/projectConfig.js'
import type { ToolPermissionContext } from '../../../Tool.js'
import { notBuilt, type Unbuilt } from '../../../pi/holes.js'

export type PermissionOption = Unbuilt

export type PermissionOptionWithLabel = Unbuilt

export type FileOperationType = Unbuilt

export type ToolInput = Record<string, unknown>

function isPathStrictlyInside(candidatePath: string, folder: string): boolean {
  const candidate = normalizeCaseForComparison(expandPath(candidatePath))
  const target = normalizeCaseForComparison(folder)
  if (candidate === target) return false
  return candidate.startsWith(target + platformSep) || candidate.startsWith(target + '/')
}

function projectConfigHomeOf(filePath: string): string | null {
  const cwd = getFocusedSessionConnector().workspace().originalCwd
  for (const home of PROJECT_CONFIG_DIR_NAMES) {
    if (isPathStrictlyInside(filePath, `${cwd}${platformSep}${home}`)) return home
  }
  return null
}

function isInGlobalConfigHome(filePath: string): boolean {
  return isPathStrictlyInside(filePath, getMercuryHome())
}

function globalConfigHomePattern(): string {
  const home = getMercuryHome()
  const tilde = toTildePath(home)
  return `${tilde}/**`
}

const WINDOWS_ABS = /^(?:[A-Za-z]:[\\/]|\\\\)/

function ensureTrailing(path: string, sep: string): string {
  if (path === '') return ''
  return path.endsWith(sep) ? path : `${path}${sep}`
}

function containingDirectoryName(filePath: string): string {
  const cwd = getFocusedSessionConnector().workspace().originalCwd
  if (WINDOWS_ABS.test(filePath)) {
    const dir = win32.normalize(win32.dirname(filePath))
    if (WINDOWS_ABS.test(cwd)) {
      const rel = win32.relative(win32.normalize(cwd), dir)
      if (rel === '') return '.\\'
      if (!rel.startsWith('..') && !win32.isAbsolute(rel)) return ensureTrailing(rel, '\\')
    }
    const winHome = hostEnv().USERPROFILE || hostEnv().HOME || ''
    if (WINDOWS_ABS.test(winHome)) {
      const relHome = win32.relative(win32.normalize(winHome), dir)
      if (relHome === '') return '~/'
      if (!relHome.startsWith('..') && !win32.isAbsolute(relHome)) {
        return ensureTrailing(`~/${relHome.replace(/\\/g, '/')}`, '/')
      }
    }
    return ensureTrailing(dir, '\\')
  }
  const dir = getDirectoryForPath(filePath)
  if (dir === '') return 'this directory'
  const rel = relative(cwd, dir)
  if (rel === '') return './'
  if (!rel.startsWith('..') && !isAbsolute(rel)) return ensureTrailing(rel, '/')
  if (dir === homedir()) return '~/'
  return ensureTrailing(toTildePath(dir), '/')
}

export function getFilePermissionOptions(arg0: {
  filePath: string | null
  toolPermissionContext: ToolPermissionContext
  operationType?: FileOperationType
  onRejectFeedbackChange?: (feedback: string) => void
  onAcceptFeedbackChange?: (feedback: string) => void
  yesInputMode?: boolean
  noInputMode?: boolean
}): PermissionOptionWithLabel[] {
  return notBuilt('src/components/permissions/FilePermissionDialog/permissionOptions.tsx:97')
}
