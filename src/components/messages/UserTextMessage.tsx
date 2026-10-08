import type { TextBlockParam } from '../../types/wire.js'
import * as React from 'react'
import { NO_CONTENT_MESSAGE } from '../../constants/messages.js'
import {
  CHANNEL_TAG,
  COMMAND_MESSAGE_TAG,
  COMMAND_NAME_TAG,
  FORK_BOILERPLATE_TAG,
  LOCAL_COMMAND_CAVEAT_TAG,
  TASK_NOTIFICATION_TAG,
  TICK_TAG,
} from '../../constants/xml.js'
import {
  turnCutOfText,
  turnCutWhy,
} from '../../utils/messages.js'
import { advisorBlockOf, isAdvisorOrigin, isMonitorText, isSaturnOrigin, noticeOfText, ROW_SECOND_CLOCK_GAP_MS, saturnBlockOf, wrappedNoticeBlocks } from '../../utils/messages/noticeRows.js'
import { InterruptedByUser } from '../InterruptedByUser.js'
import { MessageResponse } from '../MessageResponse.js'
import { UserAgentNotificationMessage } from './UserAgentNotificationMessage.js'
import { UserBashInputMessage } from './UserBashInputMessage.js'
import { UserBashOutputMessage } from './UserBashOutputMessage.js'
import { UserChannelMessage } from './UserChannelMessage.js'
import { UserCommandMessage } from './UserCommandMessage.js'
import { UserForkBoilerplateMessage } from './UserForkBoilerplateMessage.js'
import { UserLocalCommandOutputMessage } from './UserLocalCommandOutputMessage.js'
import { UserMemoryInputMessage } from './UserMemoryInputMessage.js'
import { UserNoticeMessage } from './UserNoticeMessage.js'
import { UserPromptMessage } from './UserPromptMessage.js'
import { UserResourceUpdateMessage } from './UserResourceUpdateMessage.js'
import { formatClock, useMessageMeta } from './TranscriptNameplate.js'

function noticeArrivalClock(sentAt?: string, deliveredAt?: string): string | null {
  const gap = Date.parse(deliveredAt ?? '') - Date.parse(sentAt ?? '')
  return Number.isFinite(gap) && gap >= ROW_SECOND_CLOCK_GAP_MS ? formatClock(sentAt) : null
}

type Props = {
  addMargin: boolean
  param: TextBlockParam
  verbose: boolean
  isTranscriptMode?: boolean
  timestamp?: string
  notice?: boolean
  noticeSentAt?: string
  noticeDeliveredAt?: string
  origin?: unknown
}

export function UserTextMessage({
  addMargin,
  param,
  verbose,
  isTranscriptMode,
  timestamp,
  notice = false,
  noticeSentAt,
  noticeDeliveredAt,
  origin,
}: Props): React.ReactNode {
  const meta = useMessageMeta()
  const arrivedAt = meta?.queued ? null : noticeArrivalClock(noticeSentAt, noticeDeliveredAt)
  const expanded = verbose || isTranscriptMode === true
  if (param.text.trim() === NO_CONTENT_MESSAGE) {
    return null
  }

  const monitorBlocks = isMonitorText(param.text) ? wrappedNoticeBlocks(param.text) : null
  if (monitorBlocks !== null) {
    return <UserNoticeMessage addMargin={addMargin} blocks={monitorBlocks} arrivedAt={arrivedAt} expanded={expanded} fold />
  }

  const head = param.text.trimStart()
  if (isSaturnOrigin(origin)) {
    return <UserNoticeMessage addMargin={addMargin} blocks={[saturnBlockOf(origin, param.text)]} expanded={expanded} fold />
  }

  if (isAdvisorOrigin(origin)) {
    return <UserNoticeMessage addMargin={addMargin} blocks={[advisorBlockOf(origin, param.text)]} fold={notice} expanded={expanded} />
  }

  if (notice && !head.startsWith(`<${TASK_NOTIFICATION_TAG}`)) {
    const blocks = noticeOfText(param.text, true)
    if (blocks !== null) return <UserNoticeMessage addMargin={addMargin} blocks={blocks} arrivedAt={arrivedAt} expanded={expanded} fold />
  }

  if (head.startsWith(`<${TICK_TAG}`) || head.startsWith(`<${LOCAL_COMMAND_CAVEAT_TAG}>`)) return null

  if (
    param.text.startsWith('<bash-stdout') ||
    param.text.startsWith('<bash-stderr')
  ) {
    return <UserBashOutputMessage content={param.text} verbose={verbose} />
  }

  if (
    param.text.startsWith('<local-command-stdout') ||
    param.text.startsWith('<local-command-stderr')
  ) {
    return <UserLocalCommandOutputMessage content={param.text} verbose={verbose || isTranscriptMode === true} />
  }

  const cut = turnCutOfText(param.text)
  if (cut !== null) {
    return (
      <MessageResponse height={1}>
        <InterruptedByUser why={turnCutWhy(cut)} />
      </MessageResponse>
    )
  }

  

  if (head.startsWith('<bash-input>')) {
    return <UserBashInputMessage addMargin={addMargin} param={param} />
  }

  if (head.startsWith(`<${COMMAND_NAME_TAG}>`) || head.startsWith(`<${COMMAND_MESSAGE_TAG}>`)) {
    return <UserCommandMessage addMargin={addMargin} param={param} />
  }

  if (head.startsWith('<user-memory-input>')) {
    return <UserMemoryInputMessage addMargin={addMargin} text={param.text} />
  }

  if (head.startsWith(`<${TASK_NOTIFICATION_TAG}`)) {
    return <UserAgentNotificationMessage addMargin={addMargin} param={param} arrivedAt={arrivedAt} expanded={expanded} />
  }

  if (
    head.startsWith('<mcp-resource-update') ||
    head.startsWith('<mcp-polling-update')
  ) {
    return <UserResourceUpdateMessage addMargin={addMargin} param={param} />
  }

  if (head.startsWith(`<${FORK_BOILERPLATE_TAG}>`)) {
    return <UserForkBoilerplateMessage addMargin={addMargin} param={param} />
  }

  if (head.startsWith(`<${CHANNEL_TAG} source="`)) {
    return <UserChannelMessage addMargin={addMargin} param={param} />
  }

  const noticeBlocks = noticeOfText(param.text, notice)
  if (noticeBlocks !== null) {
    return <UserNoticeMessage addMargin={addMargin} blocks={noticeBlocks} arrivedAt={arrivedAt} expanded={expanded} fold={notice} />
  }

  return (
    <UserPromptMessage
      addMargin={addMargin}
      param={param}
      isTranscriptMode={isTranscriptMode}
      timestamp={timestamp}
    />
  )
}
