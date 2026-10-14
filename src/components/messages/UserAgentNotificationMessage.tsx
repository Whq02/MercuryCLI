import React from 'react'
import type { TextBlockParam } from '../../types/wire.js'
import { extractTag } from '../../utils/messages.js'
import { FOLDED_COUNT_TAG } from '../../utils/collapseBackgroundBashNotifications.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'
import { ROW_SECOND_CLOCK_GAP_MS, taskNoticeBlock } from '../../utils/messages/noticeRows.js'
import { UserNoticeMessage } from './UserNoticeMessage.js'
import { formatClock, MessageMetaProvider, useMessageMeta } from './TranscriptNameplate.js'

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
  completedAt,
  deliveredAt,
  expanded = false,
}: {
  addMargin?: boolean
  param: TextBlockParam
  arrivedAt?: string | null
  completedAt?: string
  deliveredAt?: string
  expanded?: boolean
}): React.ReactNode {
  const { accent } = useSessionAccent()
  const meta = useMessageMeta()
  const block = taskNoticeBlock(param.text)
  if (block === null) return null
  const partial = partialResultOf(param.text)
  const lines = partial === null ? block.lines : [`partial result kept (${partial.length} chars) — send it a message to resume`, ...block.lines]
  const useCompletion = block.kind === 'task' && block.plate.startsWith('[Crewmate]') && completedAt !== undefined && Number.isFinite(Date.parse(completedAt))
  const deliveryGap = useCompletion ? Date.parse(deliveredAt ?? '') - Date.parse(completedAt) : Number.NaN
  const deliveredClock = !meta?.queued && Number.isFinite(deliveryGap) && deliveryGap >= ROW_SECOND_CLOCK_GAP_MS ? formatClock(deliveredAt) : null
  const body = <UserNoticeMessage addMargin={addMargin} blocks={[{ ...block, lines }]} arrivedAt={useCompletion ? null : arrivedAt} deliveredAt={deliveredClock} expanded={expanded} fold dotColor={statusColor(extractTag(param.text, 'status'), accent)} />
  return useCompletion ? (
    <MessageMetaProvider message={{ type: 'user', timestamp: completedAt, ...(meta?.queued ? { queued: true, heldFor: meta.heldFor } : {}) }}>
      {body}
    </MessageMetaProvider>
  ) : body
}

export default UserAgentNotificationMessage
