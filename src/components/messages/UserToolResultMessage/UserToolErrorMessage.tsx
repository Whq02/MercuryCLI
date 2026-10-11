import * as React from 'react'
import { OUTPUT_CONNECTOR } from '../../../constants/figures.js'
import { Box, Text } from '../../../ink.js'
import { filterToolProgressMessages, type Tool, type Tools } from '../../../Tool.js'
import type { ProgressMessage } from '../../../types/message.js'
import type { ToolResultBlockParam } from '../../../types/wire.js'
import { INTERRUPT_MESSAGE_FOR_TOOL_USE, REJECT_MESSAGE_WITH_REASON_PREFIX } from '../../../utils/messages.js'
import type { HermesKillInfo } from '../../../utils/permissions/capabilityGate.js'
import { FallbackToolUseErrorMessage } from '../../FallbackToolUseErrorMessage.js'
import { InterruptedByUser } from '../../InterruptedByUser.js'
import { GLYPH } from '../../mercury-ui/glyphs.js'
import { CRIMSON, FAINT, IVORY, SECOND } from '../../mercuryPalette.js'
import { MessageResponse } from '../../MessageResponse.js'
import { RejectedToolUseMessage } from './RejectedToolUseMessage.js'

type Props = { progressMessagesForMessage: ProgressMessage[]; tool?: Tool; tools: Tools; param: ToolResultBlockParam; verbose: boolean; isTranscriptMode?: boolean; hermesKill?: HermesKillInfo; toolUseResult?: unknown; input?: unknown }

const interrupted = (param: ToolResultBlockParam): boolean =>
  typeof param.content === 'string' && param.content.includes(INTERRUPT_MESSAGE_FOR_TOOL_USE)

const rejectedWithReason = (param: ToolResultBlockParam): boolean =>
  typeof param.content === 'string' && param.content.startsWith(REJECT_MESSAGE_WITH_REASON_PREFIX)

function killReason(kill: HermesKillInfo): string {
  const blocked = `blocked · ${kill.kind}`
  return kill.killPattern != null ? `${blocked} · killed by MERCURY_KILL=${kill.killPattern}` : blocked
}

function KilledToolRow({ kill }: { kill: HermesKillInfo }): React.ReactNode {
  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color={CRIMSON}>{GLYPH.fail} </Text>
          <Text color={IVORY}>{kill.tool}</Text>
          {kill.target ? (
            <Text color={SECOND}>
              {'  '}
              {kill.target}
            </Text>
          ) : null}
        </Box>
        <Text color={FAINT}>
          {OUTPUT_CONNECTOR}
          {killReason(kill)}
        </Text>
      </Box>
    </MessageResponse>
  )
}

function ToolsOwnErrorRow({ progressMessagesForMessage, tool, tools, param, verbose, isTranscriptMode, toolUseResult, input }: Props): React.ReactNode {
  const own = tool?.renderToolUseErrorMessage?.(param.content, {
    progressMessagesForMessage: filterToolProgressMessages(progressMessagesForMessage),
    tools,
    verbose,
    isTranscriptMode,
    toolUseResult,
    input,
  })
  return own ?? <FallbackToolUseErrorMessage result={param.content} verbose={verbose} />
}

export function UserToolErrorMessage(props: Props): React.ReactNode {
  const { hermesKill, param } = props
  if (hermesKill) return <KilledToolRow kill={hermesKill} />
  if (interrupted(param)) {
    return (
      <MessageResponse height={1}>
        <InterruptedByUser />
      </MessageResponse>
    )
  }
  if (rejectedWithReason(param)) return <RejectedToolUseMessage />
  return <ToolsOwnErrorRow {...props} />
}
