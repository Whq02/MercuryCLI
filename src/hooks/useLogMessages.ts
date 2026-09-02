// Transcript recording. Messages are append-only between
// compactions, so the hook records only the new tail; a changed FIRST
// identity means compaction/clear rebuilt the array (length alone cannot
// tell — a post-compaction array may be longer), and a same-head shrink is
// a tombstone filter, rewind, snip or partial compaction. The REPL-id set
// is append-only and extended by the slice — rebuilding it per append
// walked the whole transcript twice per recorded row, the dominant
// super-linear cost of a long tool loop. The flush barrier forces a
// physical drain on a REAL turn boundary or after the bounded max latency,
// checked AFTER the record settles.

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

/** A REAL turn boundary: a user message that is neither meta nor a
 *  tool-result carrier; or an assistant message whose content is an ARRAY
 *  containing no tool-use blocks. Deliberately narrow — a predicate that
 *  accepted every user/assistant row fired on tool results (typed as user
 *  messages) and mid-loop tool-call rows, paying a disk flush per tool
 *  iteration. */
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

/** Last persisted-view chain participant of a slice — the sync parent-hint
 *  walk must read the SAME transformed view that reaches disk. */
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
  // Guards a stale asynchronous completion against a fresher sync update.
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
      // Non-incremental: the full array; its own de-duplication handles
      // interleaving. Rebuild the REPL-id set once.
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

    // The sync walk serves incremental, first-render and same-head-shrink
    // cases; the async return value serves only the head-changed rebuild.
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
      // The flush barrier runs AFTER the record settles.
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
