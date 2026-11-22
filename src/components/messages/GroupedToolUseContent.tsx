import React from 'react'
import { Box } from '../../ink.js'
import type {
  GroupedToolUseMessage,
  ProgressMessage,
} from '../../types/message.js'
import type { Tools } from '../../Tool.js'
import { findToolByName } from '../../Tool.js'
import type { MessageLookups } from '../../services/messages/lookups.js'
import {
  getEphemeralProgressFrame,
  useEphemeralProgressVersion,
} from '../../state/ephemeralProgressStore.js'
import { TranscriptNameplate } from './TranscriptNameplate.js'
import { notBuilt } from '../../pi/holes.js'

export function GroupedToolUseContent(arg0: {
  message: GroupedToolUseMessage
  tools: Tools
  lookups: MessageLookups
  inProgressToolUseIDs: Set<string>
  shouldAnimate?: boolean
}): React.ReactNode {
  return notBuilt('src/components/messages/GroupedToolUseContent.tsx:17')
}

export default GroupedToolUseContent
