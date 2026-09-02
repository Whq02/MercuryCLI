import { useEffect, useRef } from 'react'
import { getSessionId } from '../bootstrap/state.js'
import {
  agentStateClassifierEnabled,
  classifyAgentState,
  clearAgentStateVerdict,
  recordAgentStateVerdict,
} from '../services/agentStateClassifier.js'
import type { Message } from '../types/message.js'
import { getAssistantMessageText } from '../utils/messages.js'


function latestAssistantText(messages: readonly Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.type === 'assistant') {
      const text = getAssistantMessageText(m)
      return text && text.trim() ? text : null
    }
  }
  return null
}

export function useAgentStateClassifier(
  messages: readonly Message[],
  isLoading: boolean,
): void {
  const prevLoadingRef = useRef(isLoading)
  const messagesRef = useRef(messages)
  const abortRef = useRef<AbortController | null>(null)
  messagesRef.current = messages

  useEffect(() => {
    if (!agentStateClassifierEnabled()) return
    const wasLoading = prevLoadingRef.current
    prevLoadingRef.current = isLoading
    if (!wasLoading && isLoading) {
      abortRef.current?.abort()
      clearAgentStateVerdict(getSessionId())
      return
    }
    if (!wasLoading || isLoading) return

    const text = latestAssistantText(messagesRef.current)
    if (!text) return

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    void classifyAgentState(messagesRef.current, text, controller.signal).then(
      verdict => {
        if (verdict && !controller.signal.aborted) {
          recordAgentStateVerdict(getSessionId(), verdict)
        }
      },
    )
  }, [isLoading])

  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])
}
