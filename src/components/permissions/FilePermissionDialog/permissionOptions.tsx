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

export type FileOperationType = 'create' | 'read' | 'write'

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

function buildSessionOption(
  filePath: string | null,
  toolPermissionContext: ToolPermissionContext,
  operationType: FileOperationType,
): PermissionOptionWithLabel | null {
  if (filePath === null) return null

  const remote = isRemotePath(filePath)
  const remoteHost = remote ? remoteHostLabel(filePath) : null
  if (remote && remoteHost === null) return null

  if (!remote && operationType !== 'read') {
    if (isInGlobalConfigHome(filePath)) {
      return {
        label: (
          <Text>
            Yes, and allow Mercury to edit <Text bold>its own settings</Text> for the rest of this
            session
          </Text>
        ),
        value: 'accept-session',
        option: {
          type: 'accept-session',
          scope: 'global-config-home',
          pattern: globalConfigHomePattern(),
        },
      }
    }
    const configHome = projectConfigHomeOf(filePath)
    if (configHome !== null) {
      return {
        label: (
          <Text>
            Yes, and allow Mercury to edit <Text bold>its own settings</Text> for the rest of this
            session
          </Text>
        ),
        value: 'accept-session',
        option: {
          type: 'accept-session',
          scope: 'config-home',
          pattern: `/${configHome}/**`,
        },
      }
    }
  }

  const suggestions = generateSuggestions(filePath, operationType, toolPermissionContext)
  if (suggestions.length === 0) return null

  const shortcut = getShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab')

  if (remote && remoteHost !== null) {
    return {
      label:
        operationType === 'read' ? (
          <Text>
            Yes, allow reading from <Text bold>{remoteHost}</Text> for this session
          </Text>
        ) : (
          <Text>
            Yes, allow all edits on <Text bold>{remoteHost}</Text> for this session{' '}
            <Text bold>({shortcut})</Text>
          </Text>
        ),
      value: 'accept-session',
      option: { type: 'accept-session' },
    }
  }

  const cwd = getFocusedSessionConnector().workspace().originalCwd
  const isWindowsOnNonWindows = WINDOWS_ABS.test(filePath) && !WINDOWS_ABS.test(cwd)
  const isInside =
    !isWindowsOnNonWindows && pathInAllowedWorkingPath(filePath, toolPermissionContext)

  if (isInside) {
    return {
      label:
        operationType === 'read' ? (
          'Yes, for this session'
        ) : (
          <Text>
            Yes, allow all edits for this session <Text bold>({shortcut})</Text>
          </Text>
        ),
      value: 'accept-session',
      option: { type: 'accept-session' },
    }
  }

  const directory = containingDirectoryName(filePath)
  return {
    label:
      operationType === 'read' ? (
        <Text>
          Yes, allow reading from <Text bold>{directory}</Text> for this session
        </Text>
      ) : (
        <Text>
          Yes, allow all edits in <Text bold>{directory}</Text> for this session{' '}
          <Text bold>({shortcut})</Text>
        </Text>
      ),
    value: 'accept-session',
    option: { type: 'accept-session' },
  }
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
  const yesOption: PermissionOptionWithLabel =
    yesInputMode && onAcceptFeedbackChange
      ? {
          type: 'input',
          label: 'Yes',
          value: 'accept-once',
          placeholder: 'tell Mercury what to do next',
          onChange: onAcceptFeedbackChange,
          allowEmptySubmitToCancel: true,
          option: { type: 'accept-once' },
        }
      : {
          label: 'Yes',
          value: 'accept-once',
          option: { type: 'accept-once' },
        }

  const sessionOption = buildSessionOption(filePath, toolPermissionContext, operationType)

  const noOption: PermissionOptionWithLabel =
    noInputMode && onRejectFeedbackChange
      ? {
          type: 'input',
          label: 'No, and tell Mercury what to do differently (esc)',
          value: 'reject',
          placeholder: 'tell Mercury what to do differently',
          onChange: onRejectFeedbackChange,
          allowEmptySubmitToCancel: true,
          option: { type: 'reject' },
        }
      : {
          label: 'No, and tell Mercury what to do differently (esc)',
          value: 'reject',
          option: { type: 'reject' },
        }

  return sessionOption ? [yesOption, sessionOption, noOption] : [yesOption, noOption]
}
