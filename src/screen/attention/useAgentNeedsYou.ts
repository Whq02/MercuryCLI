import { useRef } from 'react'
import { useClaim, useLoad } from '../effects/effects.js'
import { getSessionId } from '../../boot/process-state/processState.js'
import {
  agentNeedsYouEnabled,
  classifyAgentState,
  clearAgentStateVerdict,
  recordAgentStateVerdict,
} from './agentNeedsYou.js'
import type { Message } from '../../engine/message-shapes/message.js'
import { getAssistantMessageText } from '../../engine/messages/messages.js'

function latestAssistantText(messages: readonly Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.type !== 'assistant') continue
    const text = getAssistantMessageText(message)
    return text && text.trim().length > 0 ? text : null
  }
  return null
}

export function useAgentNeedsYou(
  messages: readonly Message[],
  isLoading: boolean,
): void {
  const wasLoadingRef = useRef(isLoading)
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const abortRef = useRef<AbortController | null>(null)

  useClaim(() => {
    return () => {
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [])

  useLoad(() => {
    if (!agentNeedsYouEnabled()) return
    const wasLoading = wasLoadingRef.current
    wasLoadingRef.current = isLoading
    if (!wasLoading && isLoading) {
      abortRef.current?.abort()
      abortRef.current = null
      clearAgentStateVerdict(getSessionId())
      return
    }
    if (wasLoading && !isLoading) {
      abortRef.current?.abort()
      const currentMessages = messagesRef.current
      const text = latestAssistantText(currentMessages)
      if (text === null) {
        abortRef.current = null
        return
      }
      const controller = new AbortController()
      abortRef.current = controller
      void classifyAgentState(currentMessages, text, controller.signal).then(
        verdict => {
          if (controller.signal.aborted || !verdict) return
          recordAgentStateVerdict(getSessionId(), verdict)
        },
      )
    }
  }, [isLoading])
}
