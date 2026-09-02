import * as React from 'react'

import { getSkillToolCommands } from '../../commands.js'
import { SubAgentProvider } from '../../components/CtrlOToExpand.js'
import { Byline } from '../../components/design-system/Byline.js'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { FallbackToolUseRejectedMessage } from '../../components/FallbackToolUseRejectedMessage.js'
import { Message as MessageComponent } from '../../components/Message.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Box, Text } from '../../ink.js'
import type { Tools } from '../../Tool.js'
import type { Command } from '../../types/command.js'
import type { ProgressMessage } from '../../types/message.js'
import type { SkillToolProgress } from '../../types/tools.js'
import type { ToolResultBlockParam } from '../../types/wire.js'
import { getCwd } from '../../utils/cwd.js'
import { buildSubagentLookups } from '../../utils/messages.js'
import { plural } from '../../utils/stringUtils.js'
import type { Output } from './SkillTool.js'

/** Skill header, progress, rejection, error, result renderers. */

/** Non-verbose progress shows only the last few sub-agent messages. */
const VISIBLE_PROGRESS_TAIL = 3
const EMPTY_SET: Set<string> = new Set()

/** The command's load origin for which the header carries a leading slash (contract data). */
const LEGACY_COMMANDS_ORIGIN = 'legacy-commands'

function SkillHeader({ name }: { name: string }): React.ReactNode {
  const [commands, setCommands] = React.useState<Command[] | null>(null)
  React.useEffect(() => {
    let cancelled = false
    getSkillToolCommands(getCwd())
      .then(loaded => {
        if (!cancelled) setCommands(loaded)
      })
      .catch(() => {
        if (!cancelled) setCommands([])
      })
    return () => {
      cancelled = true
    }
  }, [])
  const command = commands?.find(candidate => candidate.name === name) as
    | (Command & { loadedFrom?: string })
    | undefined
  const prefix = command?.loadedFrom === LEGACY_COMMANDS_ORIGIN ? '/' : ''
  return <Text>{`${prefix}${name}`}</Text>
}

export function renderToolUseMessage(input?: { skill?: string }): React.ReactNode {
  if (!input?.skill) return null
  return <SkillHeader name={input.skill} />
}

export function renderToolResultMessage(output: Output): React.ReactNode {
  if (output.status === 'forked') {
    // The single-word completion byline for a forked run.
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
  const rows = progressMessages.filter(row => row.data?.message !== undefined)
  if (rows.length === 0) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>Initializing skill…</Text>
      </MessageResponse>
    )
  }
  const visible = verbose ? rows : rows.slice(-VISIBLE_PROGRESS_TAIL)
  const hidden = rows.length - visible.length
  const lookups = buildSubagentLookups(rows.map(row => row.data.message) as never)
  return (
    <SubAgentProvider>
      <MessageResponse>
      <Box flexDirection="column">
        {hidden > 0 ? <Text dimColor>+{plural(hidden, 'more tool use')}</Text> : null}
        {visible.map((row, index) => (
          <Box key={index} height={1} overflow="hidden">
            <MessageComponent
              message={row.data.message as never}
              tools={tools}
              commands={[] as never}
              verbose={false}
              addMargin={false}
              shouldAnimate={false}
              shouldShowDot={false}
              isTranscriptMode={false}
              isStatic={true}
              inProgressToolUseIDs={EMPTY_SET}
              progressMessagesForMessage={[] as never}
              lookups={lookups as never}
              style="condensed"
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
  return (
    <Box flexDirection="column">
      <ProgressRows progressMessages={progressMessagesForMessage ?? []} tools={tools} verbose={verbose} />
      <FallbackToolUseErrorMessage result={result} verbose={verbose} />
    </Box>
  )
}
