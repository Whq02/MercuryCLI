// ============================================================================
//  services/concourse/sessionTitleMint — STAGE 3 of session-aware naming
//  (the ledger's L16): the model-minted short title, minted ONCE per session
//  at the SECOND ASSISTANT TURN, through the estate's existing small call
//  (utils/sessionTitle.generateSessionTitle — the summarization family's
//  querySmallFast shape; never a new request kind), stored on the record
//  through the daemon's set-title door (source 'minted' — it fills an EMPTY
//  title only, so a typed name always survives, and the daemon stamps
//  titleMintedAt exactly once so the mint never runs twice; the lead's
//  decision on the operator's "first or second or third turn — you decide":
//  the second, so a one-shot question never pays).
//
//  The watch lives in the visible process (it holds the credential), beats
//  on the daemon's delta stamp (a turn settle publishes it) plus a bounded
//  tick, and reads the transcript's own head to count turns — bounded, one
//  small call per session EVER on success. A mint that cannot run (no
//  credential, offline, a refusal) leaves no stamp and stage 2 stands — the
//  name never regresses; the in-process attempt memory keeps a failing mint
//  from hammering (one retry window per session per quarter hour).
// ============================================================================

import { basename, dirname } from 'node:path'
import { closeSync, openSync, readSync } from 'node:fs'
import { concourseDeltaPath, readSessionWorkers, type ConcourseWorkerRecordV1 } from '../../daemon/concourseSupervisor.js'
import { recordToEntry } from '../../fabric/entryCodec.js'
import { workerTranscriptPath } from './workerTranscript.js'
import { shouldMintTitle } from './sessionNaming.js'
import { logForDebugging } from '../../utils/debug.js'

/** The head window the turn counter and the description read — two turns
 *  live in it for any real chat; a longer first reply simply mints a beat
 *  later, when the second turn's head slice shows. */
const HEAD_BYTES = 48 * 1024
const RETRY_MS = 15 * 60_000
const SWEEP_CAP = 12

interface HeadFacts {
  assistantTurns: number
  /** The first user words and the first assistant words — the mint's
   *  description (bounded). */
  description: string
}

/** One bounded head read → the turn count (capped at 2 — the gate needs no
 *  more) and the description text. Fail-soft to zero turns. */
export function transcriptHeadFacts(rec: { sessionId: string; workspaceId: string }): HeadFacts {
  try {
    const path = workerTranscriptPath(rec)
    const fd = openSync(path, 'r')
    let head = ''
    try {
      const buf = Buffer.allocUnsafe(HEAD_BYTES)
      let got = 0
      while (got < HEAD_BYTES) {
        const r = readSync(fd, buf, got, HEAD_BYTES - got, got)
        if (r <= 0) break
        got += r
      }
      head = buf.subarray(0, got).toString('utf8')
    } finally {
      closeSync(fd)
    }
    let assistantTurns = 0
    const parts: string[] = []
    for (const line of head.split(String.fromCharCode(10))) {
      if (line.length < 8) continue
      let entry: unknown
      try {
        entry = JSON.parse(line)
      } catch {
        continue // the torn last line of the window
      }
      const env = entry as { schemaVersion?: unknown; payload?: unknown }
      if (typeof env.schemaVersion !== 'number' || env.payload === null || typeof env.payload !== 'object') continue
      let e: { type?: unknown; message?: { content?: unknown } }
      try {
        e = recordToEntry(entry as never) as { type?: unknown; message?: { content?: unknown } }
      } catch {
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
  } catch {
    return { assistantTurns: 0, description: '' }
  }
}

async function mintOne(rec: ConcourseWorkerRecordV1, description: string, signal: AbortSignal): Promise<boolean> {
  const { generateSessionTitle } = await import('../../utils/sessionTitle.js')
  const title = await generateSessionTitle(description, signal)
  if (title === null) return false
  try {
    const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
    const reply = (await daemonControlRpc(
      { op: 'sessionControl', action: 'set-title', sessionId: rec.sessionId, by: 'title-mint', title, titleSource: 'minted' } as never,
      { timeoutMs: 10_000 },
    )) as { ok?: boolean; outcome?: string }
    return reply.ok === true && reply.outcome === 'applied'
  } catch (e) {
    logForDebugging(`[session-title] mint store failed for ${rec.sessionId}: ${e}`)
    return false
  }
}

export interface TitleMintHandle {
  dispose(): void
  /** Proof seam — the attempt memory. */
  _attemptedForTesting(): ReadonlyMap<string, number>
}

/** The visible process's mint watch: one sweep per delta stamp and per tick;
 *  each sweep mints at most the gate's due sessions (bounded), one small
 *  call per session ever on success. */
export function startSessionTitleMintWatch(opts: { recordsDir?: string; tickMs?: number } = {}): TitleMintHandle {
  const attempted = new Map<string, number>()
  const abort = new AbortController()
  let alive = true
  let busy = false
  const beat = (): void => {
    if (!alive || busy) return
    busy = true
    void (async () => {
      try {
        const recs = Object.values(readSessionWorkers(opts.recordsDir))
          .filter(r => r.endedAt === undefined)
          .slice(0, SWEEP_CAP)
        for (const rec of recs) {
          if (!alive) break
          const last = attempted.get(rec.sessionId)
          if (last !== undefined && Date.now() - last < RETRY_MS) continue
          const facts = transcriptHeadFacts(rec)
          if (!shouldMintTitle(rec, facts.assistantTurns)) continue
          if (facts.description.trim().length === 0) continue
          attempted.set(rec.sessionId, Date.now())
          await mintOne(rec, facts.description, abort.signal)
        }
        for (const id of [...attempted.keys()]) {
          if (!recs.some(r => r.sessionId === id) && attempted.size > SWEEP_CAP * 4) attempted.delete(id)
        }
      } catch (e) {
        logForDebugging(`[session-title] mint sweep failed (next beat retries): ${e}`)
      } finally {
        busy = false
      }
    })()
  }
  let watcher: import('node:fs').FSWatcher | null = null
  void import('node:fs')
    .then(fs => {
      if (!alive) return
      const deltaPath = concourseDeltaPath(opts.recordsDir)
      const dir = dirname(deltaPath)
      const name = basename(deltaPath)
      try {
        fs.mkdirSync(dir, { recursive: true })
        watcher = fs.watch(dir, (_ev, file) => {
          if (file !== null && file !== name) return
          beat()
        })
        watcher.on('error', () => {
          try {
            watcher?.close()
          } catch {
            /* already closed */
          }
          watcher = null
        })
      } catch {
        /* no watcher on this transport — the tick still stands */
      }
    })
    .catch(() => {})
  const timer = setInterval(beat, opts.tickMs ?? 20_000)
  timer.unref?.()
  beat()
  return {
    dispose: () => {
      alive = false
      abort.abort()
      clearInterval(timer)
      try {
        watcher?.close()
      } catch {
        /* already closed */
      }
      watcher = null
    },
    _attemptedForTesting: () => attempted,
  }
}
