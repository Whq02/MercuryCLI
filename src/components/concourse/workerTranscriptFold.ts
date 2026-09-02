import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { useCallback, useEffect, useRef, useState } from 'react'
import { recordToEntry } from '../../fabric/entryCodec.js'
import type { Tools } from '../../Tool.js'
import type { Message as MessageType } from '../../types/message.js'
import {
  buildMessageLookups,
  normalizeMessages,
  reorderMessagesInUI,
  shouldShowUserMessage,
} from '../../utils/messages.js'
import { applyGrouping } from '../../utils/groupToolUses.js'
import { collapseReadSearchGroups } from '../../utils/collapseReadSearch.js'
import { collapseHookSummaries } from '../../utils/collapseHookSummaries.js'
import { collapseTeammateShutdowns } from '../../utils/collapseTeammateShutdowns.js'
import { collapseBackgroundBashNotifications } from '../../utils/collapseBackgroundBashNotifications.js'
import { injectTurnReceipts } from '../../utils/cockpit/turnReceipt.js'
import { isNullRenderingAttachment } from '../messages/nullRenderingAttachments.js'

// ============================================================================
//  workerTranscriptFold — the ONE home of the worker-transcript fold: the
//  byte-cursor drain, the pure record projection, the dispatch-ledger
//  attribution truth, and the real message pipeline derive.
//
//  Extracted from AttachedSessionScreen (mirror transaction) so
//  the switchboard's SessionMirror and the attached surface read the worker's
//  durable transcript through the SAME machinery — the transcript grammar has
//  exactly one home, never a parallel text-line renderer.
//
//  THE WORKER STAYS THE SOLE OWNER: consumers never touch the REPL
//  switch machinery or the worker's session file pointer. First paint reads
//  history once; every fold consumes only records after the cursor, exactly
//  once. Streaming is PUSH-driven: fs.watch triggers the cursor fold
//  the moment the worker appends (a 5s heartbeat guards missed events).
// ============================================================================

/** How many folded records a pane retains (AR-5: the cap is MARKED on
 *  screen — the shed count paints as an explicit boundary row; the worker's
 *  own transcript keeps the full history). */
export const RECORD_CAP = 500

/**
 * The PURE record projection, provable off-screen (AR-1: the byte-cursor
 * drain feeds the REAL message pipeline). MercuryRecord envelopes project
 * through the fabric's ONE codec; the projected user/assistant/system
 * entries pass as runtime Messages (the same shape the focused chat's resume
 * path replays); everything else (summaries, progress, metadata lines, and
 * any line outside the record format) returns null.
 */
export function foldWorkerRecord(rec: unknown, fallbackUuid: string): MessageType | null {
  if (!rec || typeof rec !== 'object') return null
  const env = rec as { schemaVersion?: unknown; payload?: unknown }
  if (typeof env.schemaVersion === 'number' && env.payload && typeof env.payload === 'object') {
    try {
      rec = recordToEntry(rec as never)
    } catch {
      return null
    }
  } else {
    // Not a MercuryRecord envelope — a retired-format line is never
    // rendered as conversation.
    return null
  }
  const r = rec as {
    type?: unknown
    uuid?: unknown
    timestamp?: unknown
    message?: { role?: unknown; content?: unknown }
  }
  if (r.type !== 'user' && r.type !== 'assistant' && r.type !== 'system') return null
  if (r.type !== 'system' && (!r.message || typeof r.message !== 'object')) return null
  // SR-038/095 (STABLE EVENT IDENTITIES): the record's own uuid keys every
  // row — a uuid-less record takes the caller's per-mount MONOTONIC key
  // (batch-relative keys collide the moment a second drain appends).
  const uuid = typeof r.uuid === 'string' && r.uuid.length > 0 ? r.uuid : fallbackUuid
  const out: Record<string, unknown> = { ...(rec as Record<string, unknown>), uuid }
  if (typeof r.timestamp !== 'string') out.timestamp = new Date(0).toISOString()
  if (r.type === 'assistant') {
    const msg = r.message as { content?: unknown }
    // A string-content assistant line normalizes to the one-block API shape
    // the renderers dispatch on.
    if (typeof msg.content === 'string') {
      out.message = { ...(r.message as Record<string, unknown>), content: [{ type: 'text', text: msg.content }] }
    } else if (!Array.isArray(msg.content)) {
      return null
    }
  }
  if (r.type === 'user') {
    const msg = r.message as { content?: unknown }
    if (typeof msg.content !== 'string' && !Array.isArray(msg.content)) return null
  }
  return out as unknown as MessageType
}

export interface TranscriptFold {
  messages: MessageType[]
  shed: number
}

/**
 * THE READER LAW (AGENTDIALS C3): last-write-wins per recordId. The journal
 * appends REVISIONS sharing one recordId (streaming snapshot stopReason:null
 * → final end_turn — by design; the byte-level pruner deliberately keeps a
 * settled pair whole), and the resume path already collapses them by
 * construction (the loader's Map keyed by uuid). This merge is the mirror
 * family's half: a folded message whose uuid the pane already holds
 * REPLACES in place — position kept, so live streaming still paints the
 * partial and the final lands at the same slot, never a second painted
 * message (the operator's "Finished counting" twice). Within-batch
 * revisions collapse the same way (the whole-file cold fold arrives as one
 * batch). Uuid-less records ride the caller's per-mount monotonic fallback
 * keys and always append. Pure — the pin drives it.
 */
export function mergeFoldedMessages<T extends { uuid: string }>(
  base: readonly T[],
  folded: readonly T[],
): T[] {
  const all = [...base]
  if (folded.length === 0) return all
  const slotByUuid = new Map<string, number>()
  for (let i = 0; i < all.length; i++) slotByUuid.set(all[i]!.uuid, i)
  for (const m of folded) {
    const at = slotByUuid.get(m.uuid)
    if (at !== undefined) {
      all[at] = m
    } else {
      slotByUuid.set(m.uuid, all.length)
      all.push(m)
    }
  }
  return all
}

/**
 * The PUSH-driven transcript fold (SR-090/095): a read-only byte cursor over
 * workerTranscriptPath({sessionId, workspaceId}), armed by fs.watch with a 5s
 * missed-event heartbeat. Torn-tail carry and shrink→refold live inside the
 * cursor contract (workerTranscript.ts); a rewound read repaints from
 * scratch. A session switch resets the fold (a stale transcript under a new
 * identity is a lie) — consumers paint their own not-yet-started line while
 * `fold` is null.
 */
export function useWorkerTranscriptFold(
  sessionId: string,
  workspaceId: string,
): { fold: TranscriptFold | null; malformed: number } {
  const [fold, setFold] = useState<TranscriptFold | null>(null)
  const [malformed, setMalformed] = useState(0)
  useEffect(() => {
    setFold(null)
    setMalformed(0)
    let cancelled = false
    let cursorRef: import('../../services/concourse/workerTranscript.js').TranscriptCursor | null = null
    let watcher: import('node:fs').FSWatcher | null = null
    let armTimer: ReturnType<typeof setInterval> | null = null
    let heartbeat: ReturnType<typeof setInterval> | null = null
    // Records missing a uuid fall back to a per-mount MONOTONIC key — never
    // a batch-relative index (stable identities across appended drains).
    const liftSeq = { n: 0 }
    const foldRecords = (records: unknown[], rewound: boolean, newlyMalformed: number): void => {
      const folded: MessageType[] = []
      for (const r of records) {
        const m = foldWorkerRecord(r, `attach-e${liftSeq.n++}`)
        if (m !== null) folded.push(m)
      }
      if (folded.length === 0 && !rewound && newlyMalformed === 0) return
      setFold(prev => {
        const base = rewound || prev === null ? [] : prev.messages
        // Last-write-wins per recordId (the reader law above): a revision
        // replaces its earlier paint in place; only genuinely new rows grow
        // the pane (and the shed accounting).
        const all = mergeFoldedMessages(base, folded)
        const shedNow = Math.max(0, all.length - RECORD_CAP)
        return {
          messages: shedNow > 0 ? all.slice(-RECORD_CAP) : all,
          shed: (rewound || prev === null ? 0 : prev.shed) + shedNow,
        }
      })
      if (newlyMalformed > 0) setMalformed(prev => prev + newlyMalformed)
    }
    void Promise.all([
      import('../../services/concourse/workerTranscript.js'),
      import('node:fs'),
    ]).then(
      ([wt, fs]) => {
        if (cancelled) return
        // Every session's transcript derives from its record's canonical
        // workspace (the one transcript-home law the daemon pins into the
        // session's runner).
        const path = wt.workerTranscriptPath({ sessionId, workspaceId })
        const drain = (): void => {
          if (cancelled) return
          if (cursorRef === null) {
            try {
              const first = wt.openWorkerTranscript(path)
              cursorRef = first.cursor
              foldRecords(first.records, true, first.malformed)
            } catch {
              setFold(prev => prev ?? { messages: [], shed: 0 })
              return
            }
          } else {
            const next = wt.readAfterCursor(cursorRef)
            cursorRef = next.cursor
            if (next.records.length > 0 || next.rewound) foldRecords(next.records, next.rewound, next.malformed)
          }
        }
        const arm = (): boolean => {
          try {
            watcher = fs.watch(path, () => drain())
            // An unlistened FSWatcher 'error' is an uncaught exception; the
            // 5s heartbeat below already carries a dead watch.
            watcher.on('error', () => {
              try {
                watcher?.close()
              } catch {
                /* already closed */
              }
              watcher = null
            })
            watcher.unref?.()
            return true
          } catch {
            return false
          }
        }
        drain()
        if (!arm()) {
          // The transcript may not exist yet (a warming worker) — re-try the
          // watch until the file lands; the drain rides each attempt.
          armTimer = setInterval(() => {
            drain()
            if (arm() && armTimer) {
              clearInterval(armTimer)
              armTimer = null
            }
          }, 1000)
          armTimer.unref?.()
        }
        // Missed-event guard only — the watch is the primary signal.
        heartbeat = setInterval(drain, 5000)
        heartbeat.unref?.()
      },
    )
    return () => {
      cancelled = true
      if (watcher) watcher.close()
      if (armTimer) clearInterval(armTimer)
      if (heartbeat) clearInterval(heartbeat)
    }
  }, [sessionId, workspaceId])
  return { fold, malformed }
}

/** The text a delivered USER frame carries (the dispatch door writes the
 *  prompt as one string, or a one-block text array) — the digest side of
 *  the attribution match. Non-text user rows (tool results, attachments)
 *  return '' and stay operator-side. */
function userTextOf(m: { type?: string; message?: { content?: unknown } }): string {
  if (m.type !== 'user') return ''
  const content = m.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content) && content.length === 1) {
    const b = content[0] as { type?: string; text?: string }
    if (b?.type === 'text' && typeof b.text === 'string') return b.text
  }
  return ''
}

/**
 * Three-party nameplates: the dispatch ledger
 * is the attribution truth — a row delivered to THIS session whose PERSISTED
 * ORIGIN (record.by) is a coordinator identity classifies its prompt DIGEST
 * as coordinator; the operator's own doors (composer, attach, redirect,
 * answer — all stamped by:'operator') stay the operator's. Pre-field rows
 * (no by) fall back to the id prefix rule (3-3-3 challenge: prefixes alone
 * mis-plated the operator's own redirect/answer as coordinator — origin is
 * the only sound truth). Re-read per fold, gated on the ledger file's
 * mtime+size+sessionId (the fold fires per streamed append; a byte-identical
 * ledger re-read is wasted paint-path work — and a long-mounted pane that
 * switches sessions must never keep the previous session's digests).
 */
export function useCoordinatorAttribution(
  sessionId: string,
  fold: TranscriptFold | null,
): (m: { type?: string }) => 'user' | 'coordinator' {
  const [coordDigests, setCoordDigests] = useState<ReadonlySet<string>>(new Set())
  const ledgerStampRef = useRef('')
  useEffect(() => {
    let cancelled = false
    void import('../../daemon/concourseDispatch.js').then(d => {
      if (cancelled) return
      try {
        // mtimeMs + size (3-3-3 validator): a coarse-granularity filesystem
        // (1 s mtime) could hide a same-second rewrite behind mtime alone.
        const st = statSync(d.concourseDispatchesPath())
        const stamp = `${sessionId}:${st.mtimeMs}:${st.size}`
        if (stamp === ledgerStampRef.current) return
        ledgerStampRef.current = stamp
      } catch {
        /* unreadable/absent ledger still resolves below (empty set) */
      }
      const next = new Set<string>()
      for (const r of Object.values(d.readConcourseDispatches())) {
        if (r.sessionId !== sessionId) continue
        const coordinatorMinted =
          r.by !== undefined
            ? r.by !== 'operator'
            : !(r.clientMessageId.startsWith('concourse-ui-') || r.clientMessageId.startsWith('attach-'))
        if (coordinatorMinted) next.add(r.promptDigest)
      }
      setCoordDigests(prev => {
        if (prev.size === next.size && [...next].every(x => prev.has(x))) return prev
        return next
      })
    })
    return () => {
      cancelled = true
    }
  }, [sessionId, fold])
  // The digest memo keeps sha256 out of the per-row render path (bounded
  // above RECORD_CAP; a wrap clears — correctness never depends on it).
  const digestMemoRef = useRef<Map<string, string>>(new Map())
  return useCallback(
    (m: { type?: string }): 'user' | 'coordinator' => {
      const text = userTextOf(m as { type?: string; message?: { content?: unknown } })
      if (text === '' || coordDigests.size === 0) return 'user'
      let dg = digestMemoRef.current.get(text)
      if (dg === undefined) {
        dg = createHash('sha256').update(text, 'utf8').digest('hex')
        if (digestMemoRef.current.size > 600) digestMemoRef.current.clear()
        digestMemoRef.current.set(text, dg)
      }
      return coordDigests.has(dg) ? 'coordinator' : 'user'
    },
    [coordDigests],
  )
}

/**
 * The REAL transcript pipeline (AR-1: the resume owners, not a lift) — the
 * byte-cursor drains stay the data source, but every record renders through
 * the focused chat's own message pipeline (normalize → reorder → group →
 * collapse → MessageRow dispatch), so markdown, nameplates, disclosure folds,
 * tool cards and turn spacing are inherited, never imitated. Pure: callers
 * wrap it in their own useMemo.
 */
export function deriveTranscriptRows(
  messages: MessageType[],
  tools: Tools,
): {
  collapsed: ReturnType<typeof collapseBackgroundBashNotifications>
  lookups: ReturnType<typeof buildMessageLookups>
  inProgress: Set<string>
} {
  const normalized = normalizeMessages(messages)
  const prepared = reorderMessagesInUI(
    normalized
      .filter(m => m.type !== 'progress')
      .filter(m => !isNullRenderingAttachment(m))
      .filter(m => shouldShowUserMessage(m, false)),
    [],
  )
  const { messages: grouped } = applyGrouping(prepared, tools, false)
  const collapsed = collapseBackgroundBashNotifications(
    collapseHookSummaries(collapseTeammateShutdowns(collapseReadSearchGroups(injectTurnReceipts(grouped), tools))),
    false,
  )
  const lookups = buildMessageLookups(normalized, messages)
  // The in-turn signal derived from the fold (AR-7): tool_use records the
  // worker has not answered yet — these rows keep their live treatment and
  // consumers show the working motion while any exist.
  const inProgress = new Set<string>()
  for (const id of lookups.toolUseByToolUseID.keys()) {
    if (!lookups.resolvedToolUseIDs.has(id)) inProgress.add(id)
  }
  return { collapsed, lookups, inProgress }
}
