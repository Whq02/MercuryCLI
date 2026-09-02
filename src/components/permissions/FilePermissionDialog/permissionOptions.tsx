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

/**
 * The three terminal choices of the file dialog. The type discriminants and
 * the two scope literals are matched by the IDE-diff hook and the IDE prompt
 * surface; the scope spellings are frozen despite naming the legacy home.
 */
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

/** An open string-keyed record; the generic bound for the file dialog. */
export type ToolInput = Record<string, unknown>

/**
 * A path is inside a folder only when it is STRICTLY within it — never equal
 * to it. The candidate is expanded first, the comparison is case-normalised
 * for the platform, and both the platform separator and `/` are accepted as
 * the boundary character.
 */
function isPathStrictlyInside(candidatePath: string, folder: string): boolean {
  const candidate = normalizeCaseForComparison(expandPath(candidatePath))
  const target = normalizeCaseForComparison(folder)
  if (candidate === target) return false
  return candidate.startsWith(target + platformSep) || candidate.startsWith(target + '/')
}

/**
 * The project config home name the path lives in (under the ORIGINAL working
 * directory), or null. The home names come from the project-config owner and
 * are tested in its read-precedence order.
 */
export function projectConfigHomeOf(filePath: string): string | null {
  const cwd = getFocusedSessionConnector().workspace().originalCwd
  for (const home of PROJECT_CONFIG_DIR_NAMES) {
    if (isPathStrictlyInside(filePath, `${cwd}${platformSep}${home}`)) return home
  }
  return null
}

/**
 * Whether the path is inside the RESOLVED user-scope config home. A
 * `~/.claude` that is not the resolved home is foreign-harness state and must
 * not match.
 */
export function isInGlobalConfigHome(filePath: string): boolean {
  return isPathStrictlyInside(filePath, getMercuryHome())
}

/**
 * The session rule pattern for the global config estate: `~/<rel>/**` when
 * the resolved home sits under the user's home directory, else the absolute
 * home path plus `/**`.
 */
export function globalConfigHomePattern(): string {
  const home = getMercuryHome()
  const tilde = toTildePath(home)
  return `${tilde}/**`
}

/** The bold directory name for the outside-working-path session labels: the
 *  containing directory's basename with a LITERAL forward slash (never the
 *  platform separator), falling back to a generic name when empty. */
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

  // Exactly one second option: the config-estate variant when a non-read
  // operation targets the product's own settings estate (the GLOBAL scope and
  // pattern win when both estates match), the session variant otherwise.
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
