import type { ToolResultBlockParam } from '../../../engine/message-shapes/wire.js'
import * as React from 'react'
import type { Tools } from '../../../tools/kit/tool.js'
import type { NormalizedUserMessage, ProgressMessage } from '../../../engine/message-shapes/message.js'
import { type buildMessageLookups, CANCEL_MESSAGE, INTERRUPT_MESSAGE_FOR_TOOL_USE, REJECT_MESSAGE } from '../../../engine/messages/messages.js'
import type { HermesKillInfo } from '../../../permissions/rules/capabilityGate.js'
import { isRecord } from '../../../platform/primitives/isRecord.js'
import { FallbackToolUseRejectedMessage } from '../../../tools/kit/FallbackToolUseRejectedMessage.js'
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
  if (!isRecord(rawResult)) return undefined
  const kill = rawResult.hermesKill
  if (!isRecord(kill)) return undefined
  if (typeof kill.kind !== 'string' || typeof kill.tool !== 'string') return undefined
  return {
    kind: kill.kind,
    tool: kill.tool,
    ...(typeof kill.killPattern === 'string' ? { killPattern: kill.killPattern } : {}),
    ...(typeof kill.target === 'string' ? { target: kill.target } : {}),
  }
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
    return <FallbackToolUseRejectedMessage />
  }

  if (
    typeof content === 'string' &&
    (content.startsWith(REJECT_MESSAGE) ||
      content === INTERRUPT_MESSAGE_FOR_TOOL_USE)
  ) {
    const input = isRecord(toolUse.input) ? toolUse.input : {}
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
