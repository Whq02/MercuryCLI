
import { historyHead, historyRange } from '../../utils/sessionStorage/historyParts.js'
import { readSessionWorkers, type ConcourseWorkerRecordV1 } from '../../daemon/concourseWorkers.js'
import { subscribeConcourseDelta } from '../../daemon/concourseWorkers/store.js'
import { recordToEntry } from '../../fabric/entryCodec.js'
import type { MercuryRecord } from '../../fabric/record.js'
import { workerTranscriptPath } from './workerTranscript.js'
import { shouldMintTitle } from './sessionNaming.js'
import { logForDebugging } from '../../utils/debug.js'
import { passedOver } from '../../utils/passedOver.js'
import { startInterval, startTimeout, stopInterval, stopTimeout } from '../../utils/timers.js'

const HEAD_BYTES = 48 * 1024
const RETRY_MS = 15 * 60_000
const SWEEP_CAP = 12

interface HeadFacts {
  assistantTurns: number
  description: string
}

export function transcriptHeadFacts(rec: { sessionId: string; workspaceId: string }): HeadFacts {
  try {
    const path = workerTranscriptPath(rec)
    const extent = historyHead(path)
    const size = extent.before + extent.end - extent.start
    const head = size === 0 ? '' : historyRange(extent, 0, Math.min(size, HEAD_BYTES)).toString('utf8')
    let assistantTurns = 0
    const parts: string[] = []
    for (const line of head.split(String.fromCharCode(10))) {
      if (line.length < 8) continue
      let entry: unknown
      try {
        entry = JSON.parse(line)
      } catch (error) {
        passedOver(error)
        continue
      }
      const env = entry as { schemaVersion?: unknown; payload?: unknown }
      if (typeof env.schemaVersion !== 'number' || env.payload === null || typeof env.payload !== 'object') continue
      let e: { type?: unknown; message?: { content?: unknown } }
      try {
        e = recordToEntry(entry as MercuryRecord) as { type?: unknown; message?: { content?: unknown } }
      } catch (error) {
        passedOver(error)
        continue
      }
      if (e.type !== 'user' && e.type !== 'assistant') continue
      const content = e.message?.content
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
                .filter((b): b is { type: 'text'; text: string } => !!b && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
                .map(b => b.text)
                .join(' ')
            : ''
      if (e.type === 'assistant') assistantTurns += 1
      if (text.trim().length > 0 && parts.length < 4) parts.push(text.replace(/\s+/g, ' ').trim().slice(0, 300))
      if (assistantTurns >= 2 && parts.length >= 3) break
    }
    return { assistantTurns, description: parts.join(String.fromCharCode(10)).slice(0, 1000) }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { assistantTurns: 0, description: '' }
    }
    throw error
  }
}

async function mintOne(rec: ConcourseWorkerRecordV1, description: string, signal: AbortSignal): Promise<boolean> {
  const { generateSessionTitle } = await import('./sessionTitle.js')
  const title = await generateSessionTitle(description, signal)
  if (title === null) return false
  try {
    const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
    const reply = await daemonControlRpc(
      { op: 'sessionControl', action: 'set-title', sessionId: rec.sessionId, by: 'title-mint', title, titleSource: 'minted' },
      { timeoutMs: 10_000 },
    )
    return reply.ok === true && reply.outcome === 'applied'
  } catch (e) {
    logForDebugging(`[session-title] mint store failed for ${rec.sessionId}: ${e}`)
    return false
  }
}

interface TitleMintHandle {
  dispose(): void
  _attemptedForTesting(): ReadonlyMap<string, number>
}

export function startSessionTitleMintWatch(opts: { recordsDir?: string; tickMs?: number } = {}): TitleMintHandle {
  const attempted = new Map<string, number>()
  const abort = new AbortController()
  let alive = true
  let busy = false
  let pending = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  const clearRetryTimer = (): void => {
    if (retryTimer !== null) {
      stopTimeout(retryTimer)
      retryTimer = null
    }
  }
  const scheduleRetry = (atMs: number): void => {
    clearRetryTimer()
    if (!alive) return
    retryTimer = startTimeout(() => {
      retryTimer = null
      beat()
    }, Math.max(1, atMs - Date.now()))
    retryTimer.unref?.()
  }
  const beat = (): void => {
    if (!alive) return
    if (busy) {
      pending = true
      return
    }
    busy = true
    void (async () => {
      let nextRetryAt: number | null = null
      const noteRetryAt = (at: number): void => {
        if (nextRetryAt === null || at < nextRetryAt) nextRetryAt = at
      }
      try {
        const recs = Object.values(readSessionWorkers(opts.recordsDir))
          .filter(r => r.endedAt === undefined)
          .slice(0, SWEEP_CAP)
        for (const rec of recs) {
          if (!alive) break
          if (!shouldMintTitle(rec, Number.POSITIVE_INFINITY)) continue
          const last = attempted.get(rec.sessionId)
          if (last !== undefined && Date.now() - last < RETRY_MS) {
            noteRetryAt(last + RETRY_MS)
            continue
          }
          let facts: HeadFacts
          try {
            facts = transcriptHeadFacts(rec)
          } catch (e) {
            logForDebugging(`[session-title] transcript read failed for ${rec.sessionId}: ${e}`)
            continue
          }
          if (!shouldMintTitle(rec, facts.assistantTurns)) continue
          if (facts.description.trim().length === 0) continue
          const attemptedAt = Date.now()
          attempted.set(rec.sessionId, attemptedAt)
          const minted = await mintOne(rec, facts.description, abort.signal)
          if (!minted) noteRetryAt(attemptedAt + RETRY_MS)
        }
        for (const id of [...attempted.keys()]) {
          if (!recs.some(r => r.sessionId === id) && attempted.size > SWEEP_CAP * 4) attempted.delete(id)
        }
        if (nextRetryAt !== null) scheduleRetry(nextRetryAt)
        else clearRetryTimer()
      } catch (e) {
        logForDebugging(`[session-title] mint sweep failed (next beat retries): ${e}`)
      } finally {
        busy = false
        if (pending && alive) {
          pending = false
          beat()
        }
      }
    })()
  }
  const unsubDelta = subscribeConcourseDelta(beat, opts.recordsDir)
  const timer = startInterval(beat, opts.tickMs ?? 20_000)
  timer.unref?.()
  beat()
  return {
    dispose: () => {
      alive = false
      abort.abort()
      stopInterval(timer)
      clearRetryTimer()
      unsubDelta()
    },
    _attemptedForTesting: () => attempted,
  }
}
