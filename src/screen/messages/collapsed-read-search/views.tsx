import React from 'react'
import { Ansi, Box, Text } from '../../themedRenderer.js'
import type { CollapsedReadSearchGroup } from '../../../engine/message-shapes/message.js'
import type { Tools } from '../../../tools/kit/tool.js'
import { findToolByName, safeUserFacingName } from '../../../tools/kit/tool.js'
import type { MessageLookups } from '../../../engine/messages/lookups.js'
import { logError } from '../../../platform/logs/errorLog.js'
import { plural } from '../../../platform/text/strings.js'
import { toTildePath } from '../../../platform/files/path.js'
import { BACKGROUND_MOVED_WORDS, type ToolUseEntryV1 } from '../../../engine/connector/shellRunning.js'
import { CtrlOToExpand } from '../CtrlOToExpand.js'
import { MessageResponse } from '../../../tools/kit/MessageResponse.js'
import { denialLineOf } from '../../../engine/message-shapes/rejectionText.js'
import { RunningShellBackgroundHint } from '../AssistantToolUseMessage.js'
import { ToolRowLead, toolRowStateOf } from '../ToolRowLead.js'
import { TranscriptNameplate } from '../TranscriptNameplate.js'
import { OutputLine } from '../../shell-output/OutputLine.js'
import { BASH_TOOL_NAME } from '../../../tools/kit/names/bash.js'

export type Fragment = { verb: string; rest: React.ReactNode }

type VerboseGroupArgs = {
  message: CollapsedReadSearchGroup
  tools: Tools
  lookups: MessageLookups
  verbose: boolean
  shellId: string | null
  selectedBg: string | undefined
  memberResultText: (lookups: MessageLookups, id: string) => string
}

export function verboseGroupView({ message, tools, lookups, verbose, shellId, selectedBg, memberResultText }: VerboseGroupArgs): React.ReactNode {
  const blocks: React.ReactNode[] = []
  const flat: Array<{ id: string; name: string; input: unknown }> = []
  for (const member of message.messages) {
    if (member.type === 'grouped_tool_use') {
      for (const inner of member.messages) {
        const first = inner.message.content[0]
        if (first && first.type === 'tool_use') {
          flat.push({ id: first.id, name: first.name, input: first.input })
        }
      }
    } else {
      const first = member.message.content[0]
      if (first && first.type === 'tool_use') {
        flat.push({ id: first.id, name: first.name, input: first.input })
      }
    }
  }
  for (const entry of flat) {
    const tool = findToolByName(tools, entry.name)
    if (!tool) continue
    let target: React.ReactNode | string | null = null
    try {
      target = tool.renderToolUseMessage?.(entry.input, { verbose: false }) ?? null
    } catch (error) {
      logError(error)
      target = null
    }
    const resolvedMember = lookups.resolvedToolUseIDs.has(entry.id)
    const erroredMember = lookups.erroredToolUseIDs.has(entry.id)
    const deniedMember = lookups.deniedToolUseIDs.has(entry.id)
    let resultNode: React.ReactNode = null
    if (deniedMember) {
      resultNode = (
        <Text dimColor wrap="wrap">
          {denialLineOf(memberResultText(lookups, entry.id))}
        </Text>
      )
    }
    if (resolvedMember && !erroredMember) {
      const raw = (
        lookups.toolResultByToolUseID.get(entry.id) as
          | { toolUseResult?: unknown }
          | undefined
      )?.toolUseResult
      if ((raw === undefined || raw === null) && tool.name === BASH_TOOL_NAME) {
        const text = memberResultText(lookups, entry.id)
        resultNode = text.trim() ? <OutputLine content={text} verbose={verbose} /> : null
      } else if (raw !== undefined) {
        const validated = tool.outputSchema
          ? tool.outputSchema.safeParse(raw)
          : { success: true as const, data: raw }
        if (validated.success) {
          try {
            resultNode =
              tool.renderToolResultMessage?.(validated.data, [], {
                verbose,
                tools,
              }) ?? null
          } catch (error) {
            logError(error)
            resultNode = null
          }
        }
      }
    }
    blocks.push(
      <Box key={entry.id} flexDirection="column">
        <Box>
          <Text wrap="truncate-middle">
            <ToolRowLead
              state={toolRowStateOf({
                resolved: resolvedMember,
                errored: erroredMember,
                denied: deniedMember,
              })}
            />
            <Text bold>{safeUserFacingName(tool, entry.input, entry.name)}</Text>
            {target ? <Text dimColor> {target}</Text> : null}
          </Text>
        </Box>
        {resultNode ? <Box paddingLeft={2}>{resultNode}</Box> : null}
        {entry.id === shellId ? <RunningShellBackgroundHint id={entry.id} /> : null}
      </Box>,
    )
  }
  return (
    <Box flexDirection="column" backgroundColor={selectedBg}>
      <Text>
        <TranscriptNameplate />
        <Text dimColor>Expanded group ({flat.length} {plural(flat.length, 'call')})</Text>
      </Text>
      {blocks}
      {(message.relevantMemories ?? []).map(memory => (
        <Box key={memory.path} flexDirection="column" paddingLeft={2}>
          <Text dimColor>{toTildePath(memory.path)}</Text>
          <Ansi dimColor>{memory.content}</Ansi>
        </Box>
      ))}
    </Box>
  )
}

type CollapsedGroupArgs = {
  selectedBg: string | undefined
  active: boolean
  anyErrored: boolean
  anyDenied: boolean
  sentence: React.ReactNode[]
  tail: React.ReactNode
  hint: string | null
  memberEntries: ToolUseEntryV1[]
  lookups: MessageLookups
  shellId: string | null
  movedByOperator: boolean
  memberResultText: (lookups: MessageLookups, id: string) => string
}

export function collapsedGroupView({ selectedBg, active, anyErrored, anyDenied, sentence, tail, hint, memberEntries, lookups, shellId, movedByOperator, memberResultText }: CollapsedGroupArgs): React.ReactNode {
  return (
    <Box flexDirection="column" backgroundColor={selectedBg}>
      <Box>
        <Box flexShrink={0}>
          <ToolRowLead
            state={toolRowStateOf({ resolved: !active, errored: anyErrored, denied: anyDenied })}
          />
        </Box>
        <Box flexShrink={0}>
          <TranscriptNameplate />
        </Box>
        <Text wrap="truncate-end">
          <Text color={active ? undefined : 'subtle'}>
            {sentence}
            {active ? '…' : ''}
          </Text>{' '}
          <CtrlOToExpand />
          {tail}
        </Text>
      </Box>
      {active && hint !== null ? (
        <Box paddingLeft={2}>
          <MessageResponse>
            <Text dimColor wrap="wrap">
              {hint}
            </Text>
          </MessageResponse>
        </Box>
      ) : null}
      {memberEntries
        .filter(entry => lookups.deniedToolUseIDs.has(entry.id))
        .map(entry => (
          <Box key={entry.id} paddingLeft={2}>
            <MessageResponse>
              <Text dimColor wrap="wrap">
                {denialLineOf(memberResultText(lookups, entry.id))}
              </Text>
            </MessageResponse>
          </Box>
        ))}
      {shellId !== null ? (
        <Box paddingLeft={2}>
          <RunningShellBackgroundHint id={shellId} />
        </Box>
      ) : null}
      {movedByOperator ? (
        <Box paddingLeft={2}>
          <MessageResponse height={1}>
            <Text dimColor>{BACKGROUND_MOVED_WORDS}</Text>
          </MessageResponse>
        </Box>
      ) : null}
    </Box>
  )
}
