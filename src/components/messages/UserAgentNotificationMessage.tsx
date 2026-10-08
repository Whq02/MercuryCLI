import React from 'react'
import type { TextBlockParam } from '../../types/wire.js'
import { extractTag } from '../../utils/messages.js'
import { FOLDED_COUNT_TAG } from '../../utils/collapseBackgroundBashNotifications.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'
import { taskNoticeBlock } from '../../utils/messages/noticeRows.js'
import { UserNoticeMessage } from './UserNoticeMessage.js'

function statusColor(status: string | null, accent: string): string {
  switch (status) {
    case 'completed':
      return 'success'
    case 'failed':
      return 'error'
    case 'killed':
      return 'warning'
    default:
      return accent
  }
}

export function partialResultOf(text: string): string | null {
  if (extractTag(text, FOLDED_COUNT_TAG) !== null) return null
  const status = extractTag(text, 'status')
  if (status !== 'failed' && status !== 'killed') return null
  const result = extractTag(text, 'result')
  return result !== null && result !== '' ? result : null
}

export function UserAgentNotificationMessage({
  addMargin,
  param,
  arrivedAt,
  expanded = false,
}: {
  addMargin?: boolean
  param: TextBlockParam
  arrivedAt?: string | null
  expanded?: boolean
}): React.ReactNode {
  const { accent } = useSessionAccent()
  const block = taskNoticeBlock(param.text)
  if (block === null) return null
  const partial = partialResultOf(param.text)
  const lines = partial === null ? block.lines : [`partial result kept (${partial.length} chars) — send it a message to resume`, ...block.lines]
  return <UserNoticeMessage addMargin={addMargin} blocks={[{ ...block, lines }]} arrivedAt={arrivedAt} expanded={expanded} fold dotColor={statusColor(extractTag(param.text, 'status'), accent)} />
}

export default UserAgentNotificationMessage
