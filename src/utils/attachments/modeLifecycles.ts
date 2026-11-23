import type { Message } from 'src/types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import { getApolloModeSections } from '../../prompt/apolloMode.js'
import { describeModeRoad, lastModeTransitionFrom } from '../permissions/modeTransitions.js'
import { permissionModeTitle } from '../permissions/PermissionMode.js'
import { getLocalISODate } from '../../constants/common.js'
import { capsuleStateFor } from './capsuleState.js'
import {
  type Attachment,
} from './types.js'
import { notBuilt } from '../../pi/holes.js'

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
  return notBuilt('src/utils/attachments/modeLifecycles.ts:43')
}
