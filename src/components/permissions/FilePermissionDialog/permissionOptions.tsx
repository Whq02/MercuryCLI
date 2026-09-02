import * as React from 'react'
import { basename, sep as platformSep } from 'node:path'
import { Text } from '../../../ink.js'
import type { OptionWithDescription } from '../../CustomSelect/select.js'
import { getFocusedSessionConnector } from '../../../services/engine-connector/focusedConnector.js'
import { getShortcutDisplay } from '../../../keybindings/shortcutFormat.js'
import { getMercuryHome } from '../../../utils/envUtils.js'
import { expandPath, getDirectoryForPath } from '../../../utils/path.js'
import { toTildePath } from '../../../utils/path.js'
import {
  normalizeCaseForComparison,
  pathInAllowedWorkingPath,
} from '../../../utils/permissions/filesystem.js'
import { PROJECT_CONFIG_DIR_NAMES } from '../../../utils/projectConfig.js'
import type { ToolPermissionContext } from '../../../Tool.js'

export type PermissionOption =
  | { type: 'accept-once' }
  | {
      type: 'accept-session'
      scope?: 'claude-folder' | 'global-claude-folder'
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

export function projectConfigHomeOf(filePath: string): string | null {
  const cwd = getFocusedSessionConnector().workspace().originalCwd
  for (const home of PROJECT_CONFIG_DIR_NAMES) {
    if (isPathStrictlyInside(filePath, `${cwd}${platformSep}${home}`)) return home
  }
  return null
}

export function isInGlobalConfigHome(filePath: string): boolean {
  return isPathStrictlyInside(filePath, getMercuryHome())
}

export function globalConfigHomePattern(): string {
  const home = getMercuryHome()
  const tilde = toTildePath(home)
  return `${tilde}/**`
}

function containingDirectoryName(filePath: string): string {
  const name = basename(getDirectoryForPath(filePath))
  return name === '' ? 'this directory' : `${name}/`
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

  const projectHome = filePath !== null ? projectConfigHomeOf(filePath) : null
  const inGlobalHome = filePath !== null && isInGlobalConfigHome(filePath)
  if (operationType !== 'read' && (projectHome !== null || inGlobalHome)) {
    const scope = inGlobalHome ? 'global-claude-folder' : 'claude-folder'
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
  } else {
    const inside =
      filePath !== null && pathInAllowedWorkingPath(filePath, toolPermissionContext)
    const isRead = operationType === 'read'
    const shortcut = getShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab')
    let label: React.ReactNode
    if (inside && isRead) {
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
