import { useRef } from 'react'
import { useClaim, useLoad } from './effects.js'
import { getSessionId } from '../bootstrap/state.js'
import {
  agentNeedsYouEnabled,
  classifyAgentState,
  clearAgentStateVerdict,
  recordAgentStateVerdict,
} from '../services/agentNeedsYou.js'
import type { Message } from '../types/message.js'
import { getAssistantMessageText } from '../services/messages.js'
import { notBuilt } from '../pi/holes.js'

export function useAgentNeedsYou(
  messages: readonly Message[],
  isLoading: boolean,
): void {
  return notBuilt('src/hooks/useAgentNeedsYou.ts:25')
}
