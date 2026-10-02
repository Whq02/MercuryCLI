
import type { Message } from 'src/types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import { getApolloModeSections } from '../../prompt/apolloMode.js'
import { describeModeRoad, lastModeTransitionFrom } from '../permissions/modeTransitions.js'
import { permissionModeTitle } from '../permissions/PermissionMode.js'
import {
  getIsNonInteractiveSession,
  getLastEmittedDate,
  getOriginalCwd,
  needsAutoModeExitAttachment,
  setLastEmittedDate,
  setNeedsAutoModeExitAttachment,
} from '../../bootstrap/state.js'
import { getLocalISODate } from '../../constants/common.js'
import {
  buildRepoSurfaceMap,
  hasOrientationDoc,
  repoSurfaceMapEnabled,
} from '../cockpit/repoSurfaceMap.js'
import { hasToolResultContent } from './shared.js'
import {
  AUTO_MODE_ATTACHMENT_CONFIG,
  type Attachment,
} from './types.js'

const autoModeStateModule: typeof import('../permissions/autoModeState.js') | null = null

function getAutoModeAttachmentTurnCount(messages: Message[]): {
  turnCount: number
  foundAutoModeAttachment: boolean
} {
  let turnsSinceLastAttachment = 0
  let foundAutoModeAttachment = false

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]

    if (
      message?.type === 'user' &&
      !message.isMeta &&
      !hasToolResultContent(message.message.content)
    ) {
      turnsSinceLastAttachment++
    } else if (
      message?.type === 'attachment' &&
      message.attachment.type === 'auto_mode'
    ) {
      foundAutoModeAttachment = true
      break
    } else if (
      message?.type === 'attachment' &&
      message.attachment.type === 'auto_mode_exit'
    ) {
      break
    }
  }

  return { turnCount: turnsSinceLastAttachment, foundAutoModeAttachment }
}

function countAutoModeAttachmentsSinceLastExit(messages: Message[]): number {
  let count = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type === 'attachment') {
      if (message.attachment.type === 'auto_mode_exit') {
        break
      }
      if (message.attachment.type === 'auto_mode') {
        count++
      }
    }
  }
  return count
}

export async function getAutoModeAttachments(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const appState = toolUseContext.getAppState()
  const permissionContext = appState.toolPermissionContext
  if (permissionContext.mode !== 'flow') {
    return []
  }

  if (messages && messages.length > 0) {
    const { turnCount, foundAutoModeAttachment } =
      getAutoModeAttachmentTurnCount(messages)
    if (
      foundAutoModeAttachment &&
      turnCount < AUTO_MODE_ATTACHMENT_CONFIG.TURNS_BETWEEN_ATTACHMENTS
    ) {
      return []
    }
  }

  const attachmentCount =
    countAutoModeAttachmentsSinceLastExit(messages ?? []) + 1
  const reminderType: 'full' | 'sparse' =
    attachmentCount %
      AUTO_MODE_ATTACHMENT_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS ===
    1
      ? 'full'
      : 'sparse'

  return [{ type: 'auto_mode', reminderType }]
}

export async function getAutoModeExitAttachment(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (!needsAutoModeExitAttachment()) {
    return []
  }

  const appState = toolUseContext.getAppState()
  if (
    appState.toolPermissionContext.mode === 'flow' ||
    (autoModeStateModule?.isAutoModeActive() ?? false)
  ) {
    setNeedsAutoModeExitAttachment(false)
    return []
  }

  setNeedsAutoModeExitAttachment(false)
  return [{ type: 'auto_mode_exit' }]
}

export function getRepoSurfaceMapAttachment(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Attachment[] {
  if (!repoSurfaceMapEnabled()) return []
  if (toolUseContext.agentId) return []
  if (getIsNonInteractiveSession()) return []
  const root = getOriginalCwd()
  if (hasOrientationDoc(root)) return []
  if (messages && messages.length > 0) {
    for (const m of messages) {
      if (m.type === 'attachment' && m.attachment.type === 'repo_surface_map') return []
    }
  }
  const markdown = buildRepoSurfaceMap(root)
  if (!markdown) return []
  return [{ type: 'repo_surface_map', markdown }]
}

export function getDateChangeAttachments(
  messages: Message[] | undefined,
): Attachment[] {
  const currentDate = getLocalISODate()
  const lastDate = getLastEmittedDate()

  if (lastDate === null) {
    setLastEmittedDate(currentDate)
    return []
  }

  if (currentDate === lastDate) {
    return []
  }

  setLastEmittedDate(currentDate)

  return [{ type: 'date_change', newDate: currentDate }]
}


function latestModePack(messages: readonly Message[]): 'apollo' | null {
  let current: 'apollo' | null = null
  for (const message of messages) {
    if (message.type !== 'attachment') continue
    if (message.attachment.type === 'mode_pack') current = message.attachment.mode === 'apollo' ? 'apollo' : null
    else if (message.attachment.type === 'mode_pack_exit') current = null
  }
  return current
}

export function getModePackAttachments(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Attachment[] {
  if (toolUseContext.agentId) return []
  const mode = toolUseContext.getAppState().toolPermissionContext.mode
  const wanted: 'apollo' | null = mode === 'apollo' ? mode : null
  const current = latestModePack(messages ?? [])
  if (wanted === current) return []
  const out: Attachment[] = []
  if (current !== null) {
    const exit = lastModeTransitionFrom(current)
    out.push({
      type: 'mode_pack_exit',
      mode: current,
      ...(exit !== undefined
        ? { reason: `${describeModeRoad(exit.road)} moved the session to ${permissionModeTitle(exit.to)}` }
        : {}),
    })
  }
  if (wanted !== null) {
    const sections = getApolloModeSections('apollo')
    if (sections.length > 0) out.push({ type: 'mode_pack', mode: wanted, text: sections.join('\n\n') })
  }
  return out
}
