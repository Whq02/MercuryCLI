
import type { Message } from 'src/types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import { getApolloModeSections } from '../../prompt/apolloMode.js'
import { describeModeRoad, lastModeTransitionFrom } from '../permissions/modeTransitions.js'
import { permissionModeTitle } from '../permissions/PermissionMode.js'
import {
  getIsNonInteractiveSession,
  getOriginalCwd,
} from '../../bootstrap/state.js'
import { getLocalISODate } from '../../constants/common.js'
import { capsuleStateFor } from './capsuleState.js'
import {
  buildRepoSurfaceMap,
  hasOrientationDoc,
  repoSurfaceMapEnabled,
} from '../cockpit/repoSurfaceMap.js'
import {
  type Attachment,
} from './types.js'

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
  return getCapsuleDateChange({}, messages)
}

export function getCapsuleDateChange(
  context: Pick<ToolUseContext, 'owner' | 'agentId'>,
  messages: Message[] | undefined,
): Attachment[] {
  const state = capsuleStateFor(context, messages)
  const currentDate = getLocalISODate()
  const lastDate = state.lastDate
  state.lastDate = currentDate
  return lastDate !== null && lastDate !== currentDate
    ? [{ type: 'date_change', newDate: currentDate }]
    : []
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
