import React from 'react'
import { Ansi, Box, Text } from '../../../ink.js'
import type { CollapsedReadSearchGroup } from '../../../types/message.js'
import type { Tools } from '../../../Tool.js'
import { findToolByName, safeUserFacingName } from '../../../Tool.js'
import type { MessageLookups } from '../../../services/messages/lookups.js'
import { logError } from '../../../utils/log.js'
import { plural } from '../../../utils/stringUtils.js'
import { toTildePath } from '../../../utils/path.js'
import { BACKGROUND_MOVED_WORDS, type ToolUseEntryV1 } from '../../../services/engine-connector/shellRunning.js'
import { CtrlOToExpand } from '../../CtrlOToExpand.js'
import { MessageResponse } from '../../MessageResponse.js'
import { denialLineOf } from '../../../utils/messages/rejectionText.js'
import { toolFamilyFor, type ToolFamily } from '../../mercury-ui/toolGlyphs.js'
import { RunningShellBackgroundHint } from '../AssistantToolUseMessage.js'
import { ToolRowLead, toolRowStateOf } from '../ToolRowLead.js'
import { TranscriptNameplate } from '../TranscriptNameplate.js'
import { OutputLine } from '../../shell/OutputLine.js'
import { BASH_TOOL_NAME } from '../../../constants/tools/bash.js'
import { notBuilt } from '../../../pi/holes.js'

export type Fragment = { verb: string; rest: React.ReactNode; family: ToolFamily }

type VerboseGroupArgs = {
  message: CollapsedReadSearchGroup
  tools: Tools
  lookups: MessageLookups
  verbose: boolean
  shellId: string | null
  selectedBg: string | undefined
  memberResultText: (lookups: MessageLookups, id: string) => string
}

export function verboseGroupView(arg0: VerboseGroupArgs): React.ReactNode {
  return notBuilt('src/components/messages/collapsedReadSearch/views.tsx:33')
}

type CollapsedGroupArgs = {
  selectedBg: string | undefined
  fragments: Fragment[]
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

export function collapsedGroupView({ selectedBg, fragments, active, anyErrored, anyDenied, sentence, tail, hint, memberEntries, lookups, shellId, movedByOperator, memberResultText }: CollapsedGroupArgs): React.ReactNode {
  return (
    <Box flexDirection="column" backgroundColor={selectedBg}>
      <Box>
        {}
        <Box flexShrink={0}>
          <TranscriptNameplate />
        </Box>
        <Text wrap="truncate-end">
          <ToolRowLead
            family={fragments[0]?.family ?? 'shell'}
            state={toolRowStateOf({ resolved: !active, errored: anyErrored, denied: anyDenied })}
          />
          <Text color={active ? undefined : 'subtle'}>
            {sentence}
            {active ? '…' : ''}
          </Text>{' '}
          <CtrlOToExpand />
          {tail}
        </Text>
      </Box>
      {active && hint !== null ? (
        <MessageResponse>
          <Text dimColor wrap="wrap">
            {hint}
          </Text>
        </MessageResponse>
      ) : null}
      {memberEntries
        .filter(entry => lookups.deniedToolUseIDs.has(entry.id))
        .map(entry => (
          <MessageResponse key={entry.id}>
            <Text dimColor wrap="wrap">
              {denialLineOf(memberResultText(lookups, entry.id))}
            </Text>
          </MessageResponse>
        ))}
      {shellId !== null ? <RunningShellBackgroundHint id={shellId} /> : null}
      {movedByOperator ? (
        <MessageResponse height={1}>
          <Text dimColor>{BACKGROUND_MOVED_WORDS}</Text>
        </MessageResponse>
      ) : null}
    </Box>
  )
}
