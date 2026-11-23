import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { useCallback, useRef, useState } from 'react'
import { foldWorkerRecord } from '../../sessions/transcripts/mirrorRecord.js'
import { basename, dirname } from 'node:path'
import { useLoad, useTimer } from '../effects/effects.js'
import type { Tools } from '../../tools/kit/tool.js'
import type { Message as MessageType } from '../../engine/message-shapes/message.js'
import {
  buildMessageLookups,
  normalizeMessages,
  reorderMessagesInUI,
  shouldShowUserMessage,
} from '../../engine/messages/messages.js'
import { applyGrouping } from '../messages/groupToolUses.js'
import { collapseReadSearchGroups } from '../messages/collapseReadSearch.js'
import { collapseBackgroundBashNotifications } from '../messages-list/foldShellNotices.js'
import { injectTurnReceipts } from '../cockpit/turnReceipt.js'
import { getMercuryTempDir } from '../../permissions/rules/filesystem.js'
import {
  isNullRenderingAttachment,
  isNullRenderingSystemRow,
} from '../messages/nullRenderingAttachments.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { errorMessage } from '../../platform/errors/errors.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { pollUntil } from '../../platform/async/deadline.js'
import { subscribeUiClock } from '../cockpit/uiClock.js'


const RECORD_CAP = 500

export { foldWorkerRecord } from '../../sessions/transcripts/mirrorRecord.js'

interface TranscriptFold {
  messages: MessageType[]
  shed: number
}

export function mergeFoldedMessages<T extends { uuid: string }>(
  base: readonly T[],
  folded: Iterable<T>,
  cap = Infinity,
  onShed?: () => void,
): T[] {
  const kept = new Map(base.map(row => [row.uuid, row]))
  const shed = new Set<string>()
  for (const row of folded) {
    if (shed.has(row.uuid)) continue
    kept.set(row.uuid, row)
    if (kept.size > cap) {
      const first = kept.keys().next().value!
      kept.delete(first)
      shed.add(first)
      onShed?.()
    }
  }
  return [...kept.values()]
}

export function openInitialWorkerTranscript(
  path: string,
  openFn: typeof import('../concourse-model/workerTranscript.js').openWorkerTranscript,
):
  | { ok: true; result: import('../concourse-model/workerTranscript.js').TranscriptReadResult }
  | { ok: false; error: string } {
  try {
    return { ok: true, result: openFn(path) }
  } catch (error) {
    logForDebugging(`[concourse] worker transcript unreadable (${path}): ${error}`)
    return { ok: false, error: errorMessage(error) }
  }
}

export function useWorkerTranscriptFold(
  sessionId: string,
  workspaceId: string,
): { fold: TranscriptFold | null; malformed: number; readError: string | null } {
  const [fold, setFold] = useState<TranscriptFold | null>(null)
  const [malformed, setMalformed] = useState(0)
  const [readError, setReadError] = useState<string | null>(null)
  useTimer(signal => {
    setFold(null)
    setMalformed(0)
    setReadError(null)
    let cursorRef: import('../concourse-model/workerTranscript.js').TranscriptCursor | null = null
    let watcher: import('node:fs').FSWatcher | null = null
    let heartbeat: (() => void) | null = null
    let liftSeq = 0
    let current: TranscriptFold | null = null
    void Promise.all([
      import('../concourse-model/workerTranscript.js'),
      import('node:fs'),
    ]).then(
      ([wt, fs]) => {
        if (signal.aborted) return
        const path = wt.workerTranscriptPath({ sessionId, workspaceId })
        const drain = (): void => {
          if (signal.aborted) return
          let pending: TranscriptFold | null = null
          let seq = liftSeq
          const receive = (records: Iterable<unknown>, rewound: boolean, alreadyShed = 0): void => {
            let changed = rewound || cursorRef === null
            let shed = alreadyShed + (rewound ? 0 : current?.shed ?? 0)
            function* messages(): Generator<MessageType> {
              for (const record of records) {
                const message = foldWorkerRecord(record, `attach-e${seq++}`)
                if (message !== null) {
                  changed = true
                  yield message
                }
              }
            }
            const kept = mergeFoldedMessages(rewound ? [] : current?.messages ?? [], messages(), RECORD_CAP, () => { shed++ })
            if (changed) pending = { messages: kept, shed }
          }
          const opened = openInitialWorkerTranscript(path, p => cursorRef === null
            ? wt.openWorkerTranscript(p, receive, RECORD_CAP)
            : wt.readAfterCursor(cursorRef, receive, RECORD_CAP))
          if (!opened.ok) {
            setReadError(opened.error)
            if (cursorRef === null) setFold(prev => prev ?? { messages: [], shed: 0 })
            return
          }
          if (cursorRef === null && pending === null) pending = { messages: [], shed: 0 }
          liftSeq = seq
          cursorRef = opened.result.cursor
          setReadError(null)
          if (pending !== null) {
            current = pending
            setFold(pending)
          }
          if (opened.result.malformed > 0) setMalformed(prev => prev + opened.result.malformed)
        }
        const arm = (): boolean => {
          try {
            watcher = fs.watch(dirname(path), (_event, filename) => { if (!filename || String(filename) === basename(path)) drain() })
            watcher.on('error', () => {
              try {
                watcher?.close()
              } catch (error) {
                passedOver(error)
              }
              watcher = null
            })
            watcher.unref?.()
            return true
          } catch (error) {
            passedOver(error)
            return false
          }
        }
        drain()
        if (!arm()) {
          let first = true
          void pollUntil(
            () => {
              if (first) {
                first = false
                return undefined
              }
              drain()
              return arm() ? true : undefined
            },
            1000,
            Infinity,
            () => false,
            { signal, onAbort: () => false, unref: true },
          )
        }
        heartbeat = subscribeUiClock(5000, drain)
      },
    )
    return () => {
      if (watcher) watcher.close()
      if (heartbeat) heartbeat()
    }
  }, [sessionId, workspaceId])
  return { fold, malformed, readError }
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
  useLoad(signal => {
    void import('../../daemon/concourse-workers/concourseDispatch.js').then(d => {
      if (signal.aborted) return
      try {
        const st = statSync(d.concourseDispatchesPath())
        const stamp = `${sessionId}:${st.mtimeMs}:${st.size}`
        if (stamp === ledgerStampRef.current) return
        ledgerStampRef.current = stamp
      } catch (error) {
        passedOver(error)
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
  const lookups = buildMessageLookups(normalized, messages)
  const inProgress = new Set<string>()
  for (const id of lookups.toolUseByToolUseID.keys()) {
    if (!lookups.resolvedToolUseIDs.has(id)) inProgress.add(id)
  }
  const { messages: grouped } = applyGrouping(prepared, tools, false)
  const collapsed = collapseBackgroundBashNotifications(
    collapseReadSearchGroups(injectTurnReceipts(grouped, getMercuryTempDir()), tools, inProgress),
    false,
  )
  return { collapsed, lookups, inProgress }
}
