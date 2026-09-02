import type { TextBlockParam } from '../../types/wire.js'
import * as React from 'react'
import { NO_CONTENT_MESSAGE } from '../../constants/messages.js'
import {
  CHANNEL_TAG,
  COMMAND_MESSAGE_TAG,
  FORK_BOILERPLATE_TAG,
  LOCAL_COMMAND_CAVEAT_TAG,
  TASK_NOTIFICATION_TAG,
  TEAMMATE_MESSAGE_TAG,
  TICK_TAG,
} from '../../constants/xml.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import {
  extractTag,
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
} from '../../utils/messages.js'
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
import { UserPlanMessage } from './UserPlanMessage.js'
import { UserPromptMessage } from './UserPromptMessage.js'
import { UserResourceUpdateMessage } from './UserResourceUpdateMessage.js'
import { UserTeammateMessage } from './UserTeammateMessage.js'

type Props = {
  addMargin: boolean
  param: TextBlockParam
  verbose: boolean
  planContent?: string
  isTranscriptMode?: boolean
  timestamp?: string
}

export function UserTextMessage({
  addMargin,
  param,
  verbose,
  planContent,
  isTranscriptMode,
  timestamp,
}: Props): React.ReactNode {
  if (param.text.trim() === NO_CONTENT_MESSAGE) {
    return null
  }

  if (planContent) {
    return <UserPlanMessage addMargin={addMargin} planContent={planContent} />
  }

  if (extractTag(param.text, TICK_TAG)) {
    return null
  }

  if (param.text.includes(`<${LOCAL_COMMAND_CAVEAT_TAG}>`)) {
    return null
  }

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
    return <UserLocalCommandOutputMessage content={param.text} />
  }

  if (
    param.text === INTERRUPT_MESSAGE ||
    param.text === INTERRUPT_MESSAGE_FOR_TOOL_USE
  ) {
    return (
      <MessageResponse height={1}>
        <InterruptedByUser />
      </MessageResponse>
    )
  }

  

  if (param.text.includes('<bash-input>')) {
    return <UserBashInputMessage addMargin={addMargin} param={param} />
  }

  if (param.text.includes(`<${COMMAND_MESSAGE_TAG}>`)) {
    return <UserCommandMessage addMargin={addMargin} param={param} />
  }

  if (param.text.includes('<user-memory-input>')) {
    return <UserMemoryInputMessage addMargin={addMargin} text={param.text} />
  }

  if (
    isAgentSwarmsEnabled() &&
    param.text.includes(`<${TEAMMATE_MESSAGE_TAG}`)
  ) {
    return (
      <UserTeammateMessage
        addMargin={addMargin}
        param={param}
        isTranscriptMode={isTranscriptMode}
      />
    )
  }

  if (param.text.includes(`<${TASK_NOTIFICATION_TAG}`)) {
    return <UserAgentNotificationMessage addMargin={addMargin} param={param} />
  }

  if (
    param.text.includes('<mcp-resource-update') ||
    param.text.includes('<mcp-polling-update')
  ) {
    return <UserResourceUpdateMessage addMargin={addMargin} param={param} />
  }

  if (param.text.includes(`<${FORK_BOILERPLATE_TAG}>`)) {
    return <UserForkBoilerplateMessage addMargin={addMargin} param={param} />
  }

  if (param.text.includes(`<${CHANNEL_TAG} source="`)) {
    return <UserChannelMessage addMargin={addMargin} param={param} />
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
