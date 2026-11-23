import * as React from 'react'

import { SubAgentProvider } from '../../screen/messages/CtrlOToExpand.js'
import { Byline } from '../../screen/theme/Byline.js'
import { FallbackToolUseErrorMessage } from '../kit/FallbackToolUseErrorMessage.js'
import { isDenialResultText } from '../../engine/message-shapes/rejectionText.js'
import { FallbackToolUseRejectedMessage } from '../kit/FallbackToolUseRejectedMessage.js'
import { Message as MessageComponent } from '../../screen/messages/Message.js'
import { MessageResponse } from '../kit/MessageResponse.js'
import { Box, Text } from '../../screen/themedRenderer.js'
import type { Tools } from '../kit/tool.js'
import type { ProgressMessage } from '../../engine/message-shapes/message.js'
import type { SkillToolProgress } from '../kit/toolProgress.js'
import type { ToolResultBlockParam } from '../../engine/message-shapes/wire.js'
import { buildSubagentLookups } from '../../engine/messages/messages.js'
import { plural } from '../../platform/text/strings.js'
import type { Output } from './SkillTool.js'

const VISIBLE_PROGRESS_TAIL = 3
const EMPTY_SET: Set<string> = new Set()

function SkillHeader({ name }: { name: string }): React.ReactNode {
  return <Text>{name}</Text>
}

export function renderToolUseMessage(input?: { skill?: string }): React.ReactNode {
  if (!input?.skill) return null
  return <SkillHeader name={input.skill} />
}

export function renderToolResultMessage(output: Output): React.ReactNode {
  if (output.status === 'forked') {
    return (
      <MessageResponse height={1}>
        <Byline>Done</Byline>
      </MessageResponse>
    )
  }
  const parts = ['Skill loaded']
  const toolCount = output.allowedTools?.length ?? 0
  if (toolCount > 0) parts.push(`${plural(toolCount, 'allowed tool')}`)
  if (output.model && output.model !== 'default') parts.push(`model: ${output.model}`)
  return (
    <MessageResponse height={1}>
      <Byline>{parts.join(' · ')}</Byline>
    </MessageResponse>
  )
}

function ProgressRows({
  progressMessages,
  tools,
  verbose,
}: {
  progressMessages: readonly ProgressMessage<SkillToolProgress>[]
  tools: Tools
  verbose: boolean
}): React.ReactNode {
  const rows = progressMessages.filter(row => Boolean(row.data?.message))
  if (rows.length === 0) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>Initializing skill…</Text>
      </MessageResponse>
    )
  }
  const visible = verbose ? rows : rows.slice(-VISIBLE_PROGRESS_TAIL)
  const hidden = rows.length - visible.length
  const { lookups } = buildSubagentLookups(rows.map(row => ({ message: row.data.message })))
  return (
    <SubAgentProvider>
      <MessageResponse>
        <Box flexDirection="column">
          {hidden > 0 ? (
            <Text dimColor>{`+${hidden} more ${plural(hidden, 'tool use')}`}</Text>
          ) : null}
          {visible.map((row, index) => (
            <Box key={row.uuid ?? index} height={1} overflow="hidden">
              <MessageComponent
                message={row.data.message}
                tools={tools}
                commands={[]}
                verbose={verbose}
                addMargin={false}
                shouldAnimate={false}
                shouldShowDot={false}
                isTranscriptMode={false}
                isStatic={true}
                style="condensed"
                inProgressToolUseIDs={EMPTY_SET}
                progressMessagesForMessage={[]}
                lookups={lookups}
              />
            </Box>
          ))}
        </Box>
      </MessageResponse>
    </SubAgentProvider>
  )
}

export function renderToolUseProgressMessage(
  progressMessages: readonly ProgressMessage<SkillToolProgress>[],
  { tools, verbose }: { tools: Tools; verbose: boolean },
): React.ReactNode {
  return <ProgressRows progressMessages={progressMessages ?? []} tools={tools} verbose={verbose} />
}

export function renderToolUseRejectedMessage(
  _input: unknown,
  { progressMessagesForMessage, tools, verbose }: { progressMessagesForMessage?: ProgressMessage<SkillToolProgress>[]; tools: Tools; verbose: boolean },
): React.ReactNode {
  return (
    <Box flexDirection="column">
      <ProgressRows progressMessages={progressMessagesForMessage ?? []} tools={tools} verbose={verbose} />
      <FallbackToolUseRejectedMessage />
    </Box>
  )
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { progressMessagesForMessage, tools, verbose }: { progressMessagesForMessage?: ProgressMessage<SkillToolProgress>[]; tools: Tools; verbose: boolean },
): React.ReactNode {
  if (typeof result === 'string' && isDenialResultText(result) && (progressMessagesForMessage ?? []).length === 0) {
    return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
  }
  return (
    <Box flexDirection="column">
      <ProgressRows progressMessages={progressMessagesForMessage ?? []} tools={tools} verbose={verbose} />
      <FallbackToolUseErrorMessage result={result} verbose={verbose} />
    </Box>
  )
}
