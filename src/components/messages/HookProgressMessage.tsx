import React from 'react'
import { Text } from '../../ink.js'
import type { HookEvent } from '../../utils/hooks/contract.js'
import { hookWaitLineOf } from '../../utils/hooks/wait.js'
import type { MessageLookups } from '../../services/messages/lookups.js'
import type { ProgressMessage } from '../../types/message.js'
import { plural } from '../../utils/stringUtils.js'
import { notBuilt } from '../../pi/holes.js'

export function HookProgressMessage(arg0: {
  hookEvent: HookEvent
  toolUseID: string
  lookups: MessageLookups
  progress?: readonly ProgressMessage[]
  isTranscriptMode?: boolean
}): React.ReactNode {
  return notBuilt('src/components/messages/HookProgressMessage.tsx:9')
}

export default HookProgressMessage
