import type { Message } from 'src/engine/message-shapes/message.js'
import type { ToolUseContext } from '../../tools/kit/tool.js'
import { getApolloModeSections } from '../system-prompt/apolloMode.js'
import { describeModeRoad, lastModeTransitionFrom } from '../../permissions/rules/modeTransitions.js'
import { permissionModeTitle } from '../../permissions/rules/permissionMode.js'
import { getLocalISODate } from '../../platform/primitives/localIsoDate.js'
import { capsuleStateFor } from './capsuleState.js'
import {
  type Attachment,
} from './attachmentTypes.js'

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
  const today = getLocalISODate()
  const lastDate = state.lastDate
  state.lastDate = today
  return lastDate !== null && lastDate !== today ? [{ type: 'date_change', newDate: today }] : []
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
  const wanted: 'apollo' | null = mode === 'apollo' ? 'apollo' : null
  const active = latestModePack(messages ?? [])
  if (wanted === active) return []
  if (active !== null && wanted === null) {
    const transition = lastModeTransitionFrom(active)
    const reason = transition
      ? `${describeModeRoad(transition.road)} moved the session to ${permissionModeTitle(transition.to)}`
      : undefined
    return [{ type: 'mode_pack_exit', mode: active, ...(reason !== undefined ? { reason } : {}) }]
  }
  if (wanted !== null) {
    const sections = getApolloModeSections(wanted)
    if (sections.length === 0) return []
    return [{ type: 'mode_pack', mode: wanted, text: sections.join('\n\n') }]
  }
  return []
}
