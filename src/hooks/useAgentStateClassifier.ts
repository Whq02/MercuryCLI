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

// ============================================================================
// useAgentStateClassifier — DORMANT-READY per-turn trigger for the agent-state
// classifier. On each turn-end (isLoading true→false) it classifies the latest
// assistant text and records a {state, tempo, detail, needs} verdict that the
// substrate (agentStateSnapshot → deck/fleet/MercuryFrame) can read.
//
// WIRED LIVE for Mercury (agentStateClassifierEnabled): the zero-token heuristic
// runs every turn-end on a Mercury build (opt out MERCURY_AGENT_CLASSIFIER=0); off →
// the effect is an inert no-op (no classification, no behaviour change, no token
// cost). The fast-model refinement tier is itself further gated on
// MERCURY_AGENT_CLASSIFIER_LLM (default off — it has token cost).
// ============================================================================

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
    // A NEW turn started (loading false→true): the previous turn's verdict
    // is stale — the operator answered / work resumed. Abort any in-flight
    // classify and CLEAR, else the deck's "▲ agent needs you" chip keeps
    // alarming through the whole working turn (operator sighting;
    // clearAgentStateVerdict had zero callers). Cleared store ⇒ snapshot
    // 'unavailable' ⇒ the chip drops on the next bus repaint.
    if (!wasLoading && isLoading) {
      abortRef.current?.abort()
      clearAgentStateVerdict(getSessionId())
      return
    }
    // Fire only on the loading true→false edge (a turn just completed).
    if (!wasLoading || isLoading) return

    const text = latestAssistantText(messagesRef.current)
    if (!text) return

    // Supersede any in-flight classification from a prior turn.
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

  // Abort any in-flight classification on unmount.
  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])
}
