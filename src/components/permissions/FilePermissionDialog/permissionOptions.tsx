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

export type PermissionOption =
  | { type: 'accept-once' }
  | {
      type: 'accept-session'
      scope?: 'config-home' | 'global-config-home'
      pattern?: string
    }
  | { type: 'reject' }

export type PermissionOptionWithLabel = OptionWithDescription<string> & {
  option: PermissionOption
}

export type FileOperationType = 'read' | 'write' | 'create'

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

export function getFilePermissionOptions({
  filePath,
  toolPermissionContext,
  operationType = 'write',
  onRejectFeedbackChange,
  onAcceptFeedbackChange,
  yesInputMode,
  noInputMode,
}: {
  filePath: string | null
  toolPermissionContext: ToolPermissionContext
  operationType?: FileOperationType
  onRejectFeedbackChange?: (feedback: string) => void
  onAcceptFeedbackChange?: (feedback: string) => void
  yesInputMode?: boolean
  noInputMode?: boolean
}): PermissionOptionWithLabel[] {
  const options: PermissionOptionWithLabel[] = []

  if (yesInputMode && onAcceptFeedbackChange) {
    options.push({
      type: 'input',
      label: 'Yes',
      value: 'accept-once',
      onChange: onAcceptFeedbackChange,
      placeholder: 'tell Mercury what to do next',
      allowEmptySubmitToCancel: true,
      option: { type: 'accept-once' },
    })
  } else {
    options.push({ label: 'Yes', value: 'accept-once', option: { type: 'accept-once' } })
  }

  const remote = filePath !== null && isRemotePath(filePath)
  const remoteHost = remote ? remoteHostLabel(filePath) : null
  const projectHome = filePath !== null && !remote ? projectConfigHomeOf(filePath) : null
  const inGlobalHome = filePath !== null && !remote && isInGlobalConfigHome(filePath)
  const hostList = remote && remoteHost === null
  if (!hostList && operationType !== 'read' && (projectHome !== null || inGlobalHome)) {
    const scope = inGlobalHome ? 'global-config-home' : 'config-home'
    const pattern = inGlobalHome ? globalConfigHomePattern() : `/${projectHome}/**`
    options.push({
      label: (
        <Text>
          Yes, and allow Mercury to edit <Text bold>its own settings</Text> for the rest of this
          session
        </Text>
      ),
      value: 'accept-session',
      option: { type: 'accept-session', scope, pattern },
    })
  } else if (
    !hostList &&
    filePath !== null &&
    generateSuggestions(filePath, operationType, toolPermissionContext).length > 0
  ) {
    const cwd = getFocusedSessionConnector().workspace().originalCwd
    const inside =
      filePath !== null &&
      !remote &&
      !(WINDOWS_ABS.test(filePath) && !WINDOWS_ABS.test(cwd)) &&
      pathInAllowedWorkingPath(filePath, toolPermissionContext)
    const isRead = operationType === 'read'
    const shortcut = getShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab')
    let label: React.ReactNode
    if (remoteHost !== null && isRead) {
      label = (
        <Text>
          Yes, allow reading from <Text bold>{remoteHost}</Text> for this session
        </Text>
      )
    } else if (remoteHost !== null) {
      label = (
        <Text>
          Yes, allow all edits on <Text bold>{remoteHost}</Text> for this session <Text bold>({shortcut})</Text>
        </Text>
      )
    } else if (inside && isRead) {
      label = 'Yes, for this session'
    } else if (inside) {
      label = (
        <Text>
          Yes, allow all edits for this session <Text bold>({shortcut})</Text>
        </Text>
      )
    } else if (isRead) {
      label = (
        <Text>
          Yes, allow reading from <Text bold>{containingDirectoryName(filePath ?? '')}</Text> for
          this session
        </Text>
      )
    } else {
      label = (
        <Text>
          Yes, allow all edits in <Text bold>{containingDirectoryName(filePath ?? '')}</Text> for
          this session <Text bold>({shortcut})</Text>
        </Text>
      )
    }
    options.push({
      label,
      value: 'accept-session',
      option: { type: 'accept-session' },
    })
  }

  if (noInputMode && onRejectFeedbackChange) {
    options.push({
      type: 'input',
      label: 'No, and tell Mercury what to do differently (esc)',
      value: 'reject',
      onChange: onRejectFeedbackChange,
      placeholder: 'tell Mercury what to do differently',
      allowEmptySubmitToCancel: true,
      option: { type: 'reject' },
    })
  } else {
    options.push({
      label: 'No, and tell Mercury what to do differently (esc)',
      value: 'reject',
      option: { type: 'reject' },
    })
  }

  return options
}
