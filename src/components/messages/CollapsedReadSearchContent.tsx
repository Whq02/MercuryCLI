import React, { useRef } from 'react'
import { Text } from '../../ink.js'
import type {
  CollapsedReadSearchGroup,
} from '../../types/message.js'
import type { Tools } from '../../Tool.js'
import { useMinDisplayTime } from '../../hooks/useMinDisplayTime.js'
import type { MessageLookups } from '../../services/messages/lookups.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import { plural } from '../../utils/stringUtils.js'
import { toTildePath } from '../../utils/path.js'
import { useFluxMountMark } from '../../hooks/useFluxMountMark.js'
import {
  getEphemeralProgressFrame,
  useEphemeralProgressVersion,
} from '../../state/ephemeralProgressStore.js'
import { hookWaitLineOf } from '../../utils/hooks/wait.js'
import {
  firstRunningShellId,
  movedToBackgroundByOperator,
  type ToolUseEntryV1,
} from '../../services/engine-connector/shellRunning.js'
import type { ToolFamily } from '../mercury-ui/toolGlyphs.js'
import { useSelectedMessageBg } from '../messageActions.js'
import { BASH_TOOL_NAME } from '../../constants/tools/bash.js'
import { isUserInterruptResultText } from '../../utils/messages/rejectionText.js'
import { collapsedGroupView, verboseGroupView, type Fragment } from './collapsedReadSearch/views.js'
import { notBuilt } from '../../pi/holes.js'

const HINT_MIN_DISPLAY_MS = 700


function bold(n: number): React.ReactNode {
  return <Text bold>{n}</Text>
}

function counted(verb: string, n: number, noun: string, family: ToolFamily): Fragment {
  return {
    verb,
    family,
    rest: (
      <>
        {' '}
        {bold(n)} {plural(n, noun)}
      </>
    ),
  }
}

function memberResultText(lookups: MessageLookups, id: string): string {
  const holder = lookups.toolResultByToolUseID.get(id)
  const content = holder?.type === 'user' ? holder.message.content : undefined
  if (!Array.isArray(content)) return ''
  for (const block of content) {
    if (block.type !== 'tool_result' || block.tool_use_id !== id) continue
    if (typeof block.content === 'string') return block.content
    if (Array.isArray(block.content)) {
      return block.content.map(part => (part.type === 'text' ? part.text : '')).join('\n')
    }
  }
  return ''
}

export function CollapsedReadSearchContent(arg0: {
  message: CollapsedReadSearchGroup
  inProgressToolUseIDs: Set<string>
  shouldAnimate?: boolean
  verbose?: boolean
  isTranscriptMode?: boolean
  tools: Tools
  lookups: MessageLookups
  isActiveGroup?: boolean
}): React.ReactNode {
  return notBuilt('src/components/messages/CollapsedReadSearchContent.tsx:80')
}

export default CollapsedReadSearchContent
