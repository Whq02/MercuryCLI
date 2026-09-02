
import { useEffect, useRef } from 'react'
import type { UUID } from 'node:crypto'
import type { Message } from '../types/message.js'
import { recordTranscript, flushSessionStorage } from '../utils/sessionStorage/writer.js'
import {
  cleanMessagesForLogging,
  collectReplIds,
  collectReplIdsInto,
} from '../utils/sessionStorage/chain.js'
import { isChainParticipant } from '../utils/sessionStorage/paths.js'
import { isAgentSwarmsEnabled } from '../utils/agentSwarmsEnabled.js'
import { getAgentName, getTeamName } from '../utils/teammate.js'

const FLUSH_MAX_LATENCY_MS = 5000

export function isTurnBoundaryRow(m: Message): boolean {
  if (m.type === 'user') {
    if ((m as { isMeta?: boolean }).isMeta) return false
    if ((m as { toolUseResult?: unknown }).toolUseResult !== undefined) return false
    const content = m.message.content
    if (
      Array.isArray(content) &&
      content.some(block => (block as { type?: string }).type === 'tool_result')
    ) {
      return false
    }
    return true
  }
  if (m.type === 'assistant') {
    const content = m.message.content
    if (!Array.isArray(content)) return false
    return !content.some(block => (block as { type?: string }).type === 'tool_use')
  }
  return false
}

function lastLoggableUuid(
  slice: Message[],
  allMessages: readonly Message[],
  replIds: Set<string>,
): UUID | undefined {
  const transformed = cleanMessagesForLogging(slice, allMessages, replIds)
  for (let i = transformed.length - 1; i >= 0; i--) {
    const m = transformed[i]!
    if (isChainParticipant(m)) return m.uuid as UUID
  }
  return undefined
}

export function useLogMessages(messages: Message[], ignore?: boolean): void {
  const lastRecordedLengthRef = useRef(0)
  const firstUuidRef = useRef<string | undefined>(undefined)
  const parentHintRef = useRef<UUID | undefined>(undefined)
  const replIdsRef = useRef<Set<string>>(new Set())
  const lastFlushAtRef = useRef(Date.now())
  const seqRef = useRef(0)

  useEffect(() => {
    if (ignore) return
    if (messages.length === 0) return

    const firstUuid = messages[0]?.uuid
    const firstRender = firstUuidRef.current === undefined
    const headChanged = !firstRender && firstUuid !== firstUuidRef.current
    const sameHeadShrink =
      !firstRender && !headChanged && messages.length < lastRecordedLengthRef.current

    let slice: Message[]
    let incremental: boolean
    if (firstRender || headChanged || sameHeadShrink) {
      slice = messages
      incremental = false
      replIdsRef.current = collectReplIds(messages)
    } else {
      slice = messages.slice(lastRecordedLengthRef.current)
      if (slice.length === 0) return
      incremental = true
      collectReplIdsInto(replIdsRef.current, slice)
    }

    const replIds = replIdsRef.current
    const teamInfo = isAgentSwarmsEnabled()
      ? { teamName: getTeamName(), agentName: getAgentName() }
      : undefined
    const hint = incremental ? parentHintRef.current : undefined
    const seq = ++seqRef.current

    if (incremental || firstRender || sameHeadShrink) {
      const synced = lastLoggableUuid(slice, messages, replIds)
      if (synced !== undefined) parentHintRef.current = synced
    }

    lastRecordedLengthRef.current = messages.length
    firstUuidRef.current = firstUuid

    void recordTranscript(
      slice,
      teamInfo,
      hint,
      messages,
      replIds,
    ).then(async returnedParent => {
      if (headChanged && returnedParent !== null && seq === seqRef.current) {
        parentHintRef.current = returnedParent
      }
      const now = Date.now()
      if (
        slice.some(isTurnBoundaryRow) ||
        now - lastFlushAtRef.current >= FLUSH_MAX_LATENCY_MS
      ) {
        lastFlushAtRef.current = now
        await flushSessionStorage()
      }
    })
  }, [messages, ignore])
}
