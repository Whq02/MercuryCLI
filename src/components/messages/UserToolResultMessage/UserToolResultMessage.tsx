import type { ToolResultBlockParam } from '../../../types/wire.js'
import * as React from 'react'
import type { Tools } from '../../../Tool.js'
import type { NormalizedUserMessage, ProgressMessage } from '../../../types/message.js'
import { type buildMessageLookups, CANCEL_MESSAGE, INTERRUPT_MESSAGE_FOR_TOOL_USE, REJECT_MESSAGE } from '../../../services/messages.js'
import type { HermesKillInfo } from '../../../utils/permissions/capabilityGate.js'
import { UserToolCanceledMessage } from './UserToolCanceledMessage.js'
import { UserToolErrorMessage } from './UserToolErrorMessage.js'
import { UserToolRejectMessage } from './UserToolRejectMessage.js'
import { UserToolSuccessMessage } from './UserToolSuccessMessage.js'
import { useGetToolFromMessages } from './utils.js'

type Props = {
  param: ToolResultBlockParam
  message: NormalizedUserMessage
  lookups: ReturnType<typeof buildMessageLookups>
  progressMessagesForMessage: ProgressMessage[]
  tools: Tools
  verbose: boolean
  width: number | string
  style?: 'condensed'
  isTranscriptMode?: boolean
}

function extractHermesKill(rawResult: unknown): HermesKillInfo | undefined {
  if (typeof rawResult !== 'object' || rawResult === null) return undefined
  const kill = (rawResult as { hermesKill?: HermesKillInfo }).hermesKill
  return kill !== undefined && typeof kill === 'object' && kill !== null ? kill : undefined
}

export function UserToolResultMessage({
  param,
  message,
  lookups,
  progressMessagesForMessage,
  tools,
  verbose,
  width,
  style,
  isTranscriptMode,
}: Props): React.ReactNode {
  const found = useGetToolFromMessages(param.tool_use_id, tools, lookups)
  if (!found) return null

  const { tool, toolUse } = found
  const content = param.content

  if (typeof content === 'string' && content.startsWith(CANCEL_MESSAGE)) {
    return <UserToolCanceledMessage />
  }

  if (
    typeof content === 'string' &&
    (content.startsWith(REJECT_MESSAGE) ||
      content === INTERRUPT_MESSAGE_FOR_TOOL_USE)
  ) {
    const input =
      typeof toolUse.input === 'object' && toolUse.input !== null
        ? (toolUse.input as Record<string, unknown>)
        : {}
    return (
      <UserToolRejectMessage
        input={input}
        progressMessagesForMessage={progressMessagesForMessage}
        tool={tool}
        tools={tools}
        lookups={lookups}
        style={style}
        verbose={verbose}
        isTranscriptMode={isTranscriptMode}
      />
    )
  }

  if (param.is_error) {
    const hermesKill = extractHermesKill(message.toolUseResult)
    return (
      <UserToolErrorMessage
        param={param}
        toolUseResult={message.toolUseResult}
        progressMessagesForMessage={progressMessagesForMessage}
        tool={tool}
        tools={tools}
        verbose={verbose}
        isTranscriptMode={isTranscriptMode}
        hermesKill={hermesKill}
        input={toolUse.input}
      />
    )
  }

  return (
    <UserToolSuccessMessage
      message={message}
      lookups={lookups}
      toolUseID={param.tool_use_id}
      progressMessagesForMessage={progressMessagesForMessage}
      style={style}
      tool={tool}
      tools={tools}
      verbose={verbose}
      width={width}
      isTranscriptMode={isTranscriptMode}
    />
  )
}
