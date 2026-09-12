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
import {
  isNullRenderingAttachment,
  isNullRenderingSystemRow,
} from '../messages/nullRenderingAttachments.js'


export const RECORD_CAP = 500

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
  const uuid = typeof r.uuid === 'string' && r.uuid.length > 0 ? r.uuid : fallbackUuid
  const out: Record<string, unknown> = { ...(rec as Record<string, unknown>), uuid }
  if (typeof r.timestamp !== 'string') out.timestamp = new Date(0).toISOString()
  if (r.type === 'assistant') {
    const msg = r.message as { content?: unknown }
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
            watcher.on('error', () => {
              try {
                watcher?.close()
              } catch {
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
          armTimer = setInterval(() => {
            drain()
            if (arm() && armTimer) {
              clearInterval(armTimer)
              armTimer = null
            }
          }, 1000)
          armTimer.unref?.()
        }
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
        const st = statSync(d.concourseDispatchesPath())
        const stamp = `${sessionId}:${st.mtimeMs}:${st.size}`
        if (stamp === ledgerStampRef.current) return
        ledgerStampRef.current = stamp
      } catch {
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
      .filter(m => !isNullRenderingSystemRow(m))
      .filter(m => shouldShowUserMessage(m, false)),
    [],
  )
  const { messages: grouped } = applyGrouping(prepared, tools, false)
  const collapsed = collapseBackgroundBashNotifications(
    collapseHookSummaries(collapseTeammateShutdowns(collapseReadSearchGroups(injectTurnReceipts(grouped), tools))),
    false,
  )
  const lookups = buildMessageLookups(normalized, messages)
  const inProgress = new Set<string>()
  for (const id of lookups.toolUseByToolUseID.keys()) {
    if (!lookups.resolvedToolUseIDs.has(id)) inProgress.add(id)
  }
  return { collapsed, lookups, inProgress }
}
