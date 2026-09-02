import { statSync, watch, type FSWatcher } from 'node:fs'
import { basename } from 'node:path'
import { useEffect, useRef, useState } from 'react'
import {
  readSessionFacts,
  readSessionTail,
  sessionFactsDir,
  sessionFactsPath,
  sessionTailDir,
  sessionTailPath,
} from '../../services/engine-connector/seatProjections.js'
import { workChipLine, workCounts } from '../../services/engine-connector/workCounts.js'
import type { WorkRowV1 } from '../../services/engine-connector/types.js'
import { sanitizeLabel, tailActivity } from '../../services/concourse/concourseSnapshot.js'
import { workerTranscriptPath } from '../../services/concourse/workerTranscript.js'
import { resolveWatchRoot } from '../../utils/watchRoot.js'
import { logForDebugging } from '../../utils/debug.js'

// ============================================================================
//  concourse/liveTiles — the board's ONE live-tile feed:
//  every board row's NOW cell subscribes here and
//  shows what its session is doing RIGHT NOW — the streaming reply's last
//  line (the daemon seat's session-tail projection, ≤40 ms cadence), the
//  tool it is running (the transcript tail's own truth), or nothing new
//  (the snapshot's summary stands).
//
//  Laws carried here:
//   · LIVE (line 2): one fs.watch over the session-tail dir + a 1 s
//     heartbeat for live rows — a tile follows its session within a second;
//   · CALM (line 3): emissions are CONTENT-KEYED — a listener fires only
//     when its session's derived line actually changed; idle rows register
//     nothing and are never read;
//   · NO SPEND, NO NETWORK (line 8): reads are the daemon's own files —
//     the tail projection and the session transcript — nothing else;
//   · HONEST UNDER LOAD (line 7): every read/derive is metered against a
//     per-second budget; over budget the store DEGRADES (tiles fall back
//     to the snapshot summary, the screen says so once) and probes its way
//     back — never a freeze.
//
//  The store is process-singular (the board mounts one route); provers
//  construct their own instances against scratch dirs with an injected
//  clock — the same code, deterministic time.
// ============================================================================

/** What a row's NOW cell paints live. 'still' = no live signal — the
 *  snapshot's own summary stands (an idle tile stays byte-identical). */
export type LiveTileNow =
  | { kind: 'streaming'; line: string }
  | { kind: 'tool'; line: string }
  | { kind: 'settled'; line: string }
  | { kind: 'still' }

const nowEquals = (a: LiveTileNow, b: LiveTileNow): boolean =>
  a.kind === b.kind && (a.kind === 'still' || (b.kind !== 'still' && a.line === (b as { line: string }).line))

/** The one-line clip the cell paints — the tail block's LAST non-empty
 *  line, whitespace collapsed, the TRAILING 56 kept (the newest words are
 *  the scroll; the cell renders truncate-start so they stay visible). */
export function lastLineOf(text: string): string {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const flat = (lines[i] ?? '').replace(/\s+/g, ' ').trim()
    if (flat.length > 0) return sanitizeLabel(flat.slice(-56))
  }
  return ''
}

/** The tile's ask copy (line 6): the obligation question often leads with
 *  the session's own quoted title — the row already names the session, so
 *  the tile keeps the actionable half. */
export function askTileCopy(title: string, question: string): string {
  const lead = `"${title}" asks to `
  return question.startsWith(lead) ? question.slice(lead.length) : question
}

/** A tail block older than this with no republish is not "streaming" any
 *  more (a seat that died mid-block must not freeze a tile on its last
 *  words) — the transcript activity takes over. */
const TAIL_FRESH_MS = 10_000
/** The freshness gate over one tail read — PURE, the prover drives it:
 *  text older than TAIL_FRESH_MS reads as null (a changed read, so the
 *  drain's stamp moves once), a fresh block passes untouched. */
export function gateTailFreshness(
  tail: { atMs: number; text: string | null } | null,
  nowMs: number,
): { atMs: number; text: string | null } | null {
  if (tail === null || tail.text === null) return tail
  return nowMs - tail.atMs < TAIL_FRESH_MS ? tail : { atMs: tail.atMs, text: null }
}
/** Event coalescing: publishes arrive at ≤40 ms cadence; one drain per
 *  ~80 ms keeps the scroll continuous with half the paint churn. */
const DRAIN_COALESCE_MS = 80
/** The live heartbeat — missed events + transcript-tail (tool) refresh. */
const HEARTBEAT_MS = 1000
/** HONEST UNDER LOAD (line 7): the read/derive budget per 1 s window. Two
 *  consecutive over-budget windows degrade; two probe windows under HALF
 *  the budget recover (hysteresis — no flap). */
export const TILE_BUDGET_MS_PER_S = 40
const DEGRADE_WINDOWS = 2
const RECOVER_PROBES = 2
const PROBE_MS = 5000

interface TileEntry {
  sessionId: string
  workspaceId: string
  /** The tail projection file's basename (the watch event key). */
  tailFile: string
  listeners: Set<() => void>
  now: LiveTileNow
  dirty: boolean
  /** The transcript's last seen stat (tool-leg reads only on change). */
  transcriptStamp: string
  /** The last tail identity consumed (skip re-derives of the same publish). */
  tailStamp: string
}

export interface LiveTileStoreDeps {
  tailDir: () => string
  tailPath: (sessionId: string) => string
  readTail: (sessionId: string) => { atMs: number; text: string | null } | null
  activity: (rec: { sessionId: string; workspaceId: string }) => { label: string; kind?: 'tool' | 'text' } | null
  transcriptPath: (rec: { sessionId: string; workspaceId: string }) => string
  nowMs: () => number
  /** The degrade posture forced on (capture seam; registry-rowed). */
  forceDegrade: boolean
  /** Provers drive drains by hand with an injected clock — real timers and
   *  fs events would race the simulated time. The product always arms. */
  armMachinery: boolean
}

const defaultDeps = (): LiveTileStoreDeps => ({
  tailDir: () => sessionTailDir(),
  tailPath: (sessionId: string) => sessionTailPath(sessionId),
  readTail: (sessionId: string) => readSessionTail(sessionId),
  activity: rec => tailActivity(rec),
  transcriptPath: rec => workerTranscriptPath(rec),
  nowMs: () => Date.now(),
  forceDegrade: process.env['MERCURY_TILES_FORCE_DEGRADE'] === '1',
  armMachinery: true,
})

export class LiveTileStore {
  private readonly deps: LiveTileStoreDeps
  private readonly entries = new Map<string, TileEntry>()
  private readonly byFile = new Map<string, TileEntry>()
  private watcher: FSWatcher | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private drainTimer: ReturnType<typeof setTimeout> | null = null

  // ── the budget meter (line 7) ──
  private degraded: boolean
  private readonly degradeListeners = new Set<() => void>()
  private windowStartMs = 0
  private windowCostMs = 0
  private overStreak = 0
  private underStreak = 0
  private lastProbeMs = 0

  constructor(deps: Partial<LiveTileStoreDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps }
    this.degraded = this.deps.forceDegrade
  }

  /** Register one board row. Returns the unsubscribe; the machinery runs
   *  only while at least one row is registered. */
  register(sessionId: string, workspaceId: string, onChange: () => void): () => void {
    let e = this.entries.get(sessionId)
    if (!e) {
      e = {
        sessionId,
        workspaceId,
        tailFile: basename(this.deps.tailPath(sessionId)),
        listeners: new Set(),
        now: { kind: 'still' },
        dirty: true,
        transcriptStamp: '',
        tailStamp: '',
      }
      this.entries.set(sessionId, e)
      this.byFile.set(e.tailFile, e)
    }
    e.workspaceId = workspaceId
    e.listeners.add(onChange)
    this.start()
    this.scheduleDrain()
    return () => {
      const entry = this.entries.get(sessionId)
      if (!entry) return
      entry.listeners.delete(onChange)
      if (entry.listeners.size === 0) {
        this.entries.delete(sessionId)
        this.byFile.delete(entry.tailFile)
      }
      if (this.entries.size === 0) this.stop()
    }
  }

  readTile(sessionId: string): LiveTileNow {
    if (this.degraded) return { kind: 'still' }
    return this.entries.get(sessionId)?.now ?? { kind: 'still' }
  }

  isDegraded(): boolean {
    return this.degraded
  }

  onDegradeChange(l: () => void): () => void {
    this.degradeListeners.add(l)
    return () => this.degradeListeners.delete(l)
  }

  private start(): void {
    if (!this.deps.armMachinery) return
    if (this.heartbeat !== null) return
    const t = setInterval(() => {
      for (const e of this.entries.values()) e.dirty = true
      this.drain()
    }, HEARTBEAT_MS)
    t.unref?.()
    this.heartbeat = t
    try {
      const dir = this.deps.tailDir()
      const watcher = watch(resolveWatchRoot(dir), (_ev, filename) => {
        if (filename === undefined || filename === null) {
          for (const e of this.entries.values()) e.dirty = true
        } else {
          const e = this.byFile.get(String(filename))
          if (e === undefined) return
          e.dirty = true
        }
        this.scheduleDrain()
      })
      watcher.on('error', () => {
        try {
          watcher.close()
        } catch {
          /* already closed */
        }
        if (this.watcher === watcher) this.watcher = null
        // the heartbeat carries a dead watcher
      })
      this.watcher = watcher
    } catch {
      /* no watch transport (the dir may not exist yet) — the heartbeat
         carries it and start() re-arms on the next first registration */
    }
  }

  private stop(): void {
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer)
      this.drainTimer = null
    }
    try {
      this.watcher?.close()
    } catch {
      /* already closed */
    }
    this.watcher = null
  }

  private scheduleDrain(): void {
    if (this.drainTimer !== null) return
    const t = setTimeout(() => {
      this.drainTimer = null
      this.drain()
    }, DRAIN_COALESCE_MS)
    t.unref?.()
    this.drainTimer = t
  }

  /** One derive for one session — the tail was already read this drain. */
  private derive(e: TileEntry, tail: { atMs: number; text: string | null } | null): LiveTileNow {
    if (tail !== null && tail.text !== null && this.deps.nowMs() - tail.atMs < TAIL_FRESH_MS) {
      const line = lastLineOf(tail.text)
      if (line.length > 0) return { kind: 'streaming', line }
    }
    const act = this.deps.activity({ sessionId: e.sessionId, workspaceId: e.workspaceId })
    if (act !== null && act.label.length > 0)
      return act.kind === 'tool' ? { kind: 'tool', line: act.label } : { kind: 'settled', line: act.label }
    return { kind: 'still' }
  }

  /** Drain every dirty entry, metered. Over budget: degrade instead of
   *  falling behind; while degraded, periodic probes measure the honest
   *  cost of one full drain and recovery follows two cheap ones. */
  private drain(probe = false): void {
    const now = this.deps.nowMs()
    if (this.degraded && !probe) {
      if (this.deps.forceDegrade) return
      if (now - this.lastProbeMs >= PROBE_MS) {
        this.lastProbeMs = now
        this.drain(true)
      }
      return
    }
    if (this.windowStartMs === 0) this.windowStartMs = now
    let cost = 0
    for (const e of this.entries.values()) {
      if (!e.dirty) continue
      e.dirty = false
      const t0 = this.deps.nowMs()
      let next: LiveTileNow
      try {
        // Skip identical work: the tail publish stamp and the transcript
        // stat gate the two reads (a heartbeat over an unchanged session
        // costs two stats, no derive).
        // THE GATE AT THE READ (FN-017 rank 5): a tail block older than
        // TAIL_FRESH_MS with no republish reads as no text, so the stamp
        // changes ONCE and the derive falls through to the transcript
        // activity — the chip store's own law (workChipStoreDeps). With the
        // gate only inside derive(), an unchanged file was stamp-skipped on
        // every heartbeat and a wedged seat's tile kept painting its last
        // streamed words as live for as long as the wedge lasted.
        const tailRaw = gateTailFreshness(this.deps.readTail(e.sessionId), this.deps.nowMs())
        const tailStamp = tailRaw === null ? 'none' : `${tailRaw.atMs}:${tailRaw.text === null ? 0 : tailRaw.text.length}`
        let transcriptStamp = 'none'
        try {
          const st = statSync(this.deps.transcriptPath({ sessionId: e.sessionId, workspaceId: e.workspaceId }))
          transcriptStamp = `${st.mtimeMs}:${st.size}`
        } catch {
          /* unwritten transcript */
        }
        if (tailStamp === e.tailStamp && transcriptStamp === e.transcriptStamp) {
          cost += this.deps.nowMs() - t0
          continue
        }
        e.tailStamp = tailStamp
        e.transcriptStamp = transcriptStamp
        next = this.derive(e, tailRaw)
      } catch (err) {
        logForDebugging(`[concourse] live-tile derive failed for ${e.sessionId} (kept last): ${err}`)
        cost += this.deps.nowMs() - t0
        continue
      }
      cost += this.deps.nowMs() - t0
      if (!nowEquals(next, e.now)) {
        e.now = next
        for (const l of [...e.listeners]) {
          try {
            l()
          } catch (err) {
            logForDebugging(`[concourse] live-tile listener threw (ignored): ${err}`)
          }
        }
      }
    }
    // ── the meter ──
    if (probe) {
      if (cost < TILE_BUDGET_MS_PER_S / 2) {
        this.underStreak += 1
        if (this.underStreak >= RECOVER_PROBES) this.setDegraded(false)
      } else {
        this.underStreak = 0
      }
      return
    }
    this.windowCostMs += cost
    if (now - this.windowStartMs >= 1000) {
      if (this.windowCostMs > TILE_BUDGET_MS_PER_S) {
        this.overStreak += 1
        if (this.overStreak >= DEGRADE_WINDOWS) this.setDegraded(true)
      } else {
        this.overStreak = 0
      }
      this.windowStartMs = now
      this.windowCostMs = 0
    }
  }

  private setDegraded(v: boolean): void {
    if (this.degraded === v) return
    this.degraded = v
    this.overStreak = 0
    this.underStreak = 0
    this.lastProbeMs = this.deps.nowMs()
    for (const l of [...this.degradeListeners]) {
      try {
        l()
      } catch (err) {
        logForDebugging(`[concourse] live-tile degrade listener threw (ignored): ${err}`)
      }
    }
    // Every tile repaints into (or out of) the summary posture.
    for (const e of this.entries.values()) {
      for (const l of [...e.listeners]) {
        try {
          l()
        } catch {
          /* logged above */
        }
      }
    }
  }

  /** Prover door: the heartbeat's own gesture — mark every entry dirty and
   *  drain once (injected-clock instances drive time by hand). */
  _drainForTesting(): void {
    for (const e of this.entries.values()) e.dirty = true
    this.drain()
  }
}

const theStore = new LiveTileStore()

/** The one process store (the route mounts one board). */
export function liveTileStore(): LiveTileStore {
  return theStore
}

/** A board row's live NOW — 'still' while the row has no live signal (or
 *  the store is degraded): the snapshot summary stands. `live` gates the
 *  whole subscription: idle/queued/stopped rows register nothing, read
 *  nothing, and repaint never (the CALM law). */
export function useLiveTile(
  sessionId: string,
  workspaceId: string | undefined,
  live: boolean,
): { now: LiveTileNow; degraded: boolean } {
  const [, bump] = useState(0)
  const active = live && workspaceId !== undefined && !sessionId.startsWith('dispatch:')
  useEffect(() => {
    if (!active) return
    const unsub = theStore.register(sessionId, workspaceId ?? '', () => bump(v => v + 1))
    const unsubDeg = theStore.onDegradeChange(() => bump(v => v + 1))
    return () => {
      unsub()
      unsubDeg()
    }
  }, [sessionId, workspaceId, active])
  return {
    now: active ? theStore.readTile(sessionId) : { kind: 'still' },
    degraded: theStore.isDegraded(),
  }
}

// ── the WORK CHIP feed ──────────────────────────────────────────────────────
//  The selected row's one small line naming its running work — "● 1
//  workflow · 2 agents running" in the estate's amber. The SAME store
//  class over the daemon's session-FACTS projection instead of the tail
//  (the deps are the whole difference — extend, never fork): one fs.watch
//  over the facts dir + the 1 s heartbeat, content-keyed emissions, the
//  budget meter and the degrade posture all inherited. The runner's facts
//  republish at 1 Hz while its work runs (the daemon's work poll), so the
//  freshness gate holds exactly while the work is live and the chip fades
//  when a runner goes quiet — a dead engine's rows never claim motion.
//  The counts derive through the ONE counting law (workCounts), so the
//  chip, /tasks and the agents view can never disagree.

/** The chip's derived line (before the glyph), or null for a session
 *  running nothing. Exported for the chip prover. */
export function workChipTextOf(facts: { work?: readonly WorkRowV1[] } | null): string | null {
  if (facts === null) return null
  const line = workChipLine(workCounts(facts.work ?? []))
  return line === null ? null : `${line} running`
}

/** The chip's freshness window — the tail's twin. The runner republishes
 *  its facts at 1 Hz while its work runs, so live work is always inside
 *  it; a runner that stopped answering fades out of it. */
export const CHIP_FRESH_MS = TAIL_FRESH_MS

/** The chip store's deps: the facts projection stands where the tail
 *  stood; no transcript leg (an empty path never stats), no activity. The
 *  freshness gate is applied HERE (the read), not only in the derive: an
 *  unchanged file is stamp-skipped by the drain, so a quiet runner's chip
 *  must change its READ (text → null) to fade on the heartbeat. */
export function workChipStoreDeps(nowMs: () => number = () => Date.now()): Partial<LiveTileStoreDeps> {
  return {
    tailDir: () => sessionFactsDir(),
    tailPath: (sessionId: string) => sessionFactsPath(sessionId),
    readTail: (sessionId: string) => {
      const facts = readSessionFacts(sessionId)
      if (facts === null) return null
      const fresh = nowMs() - facts.atMs < CHIP_FRESH_MS
      return { atMs: facts.atMs, text: fresh ? workChipTextOf(facts) : null }
    },
    activity: () => null,
    transcriptPath: () => '',
    nowMs,
  }
}

const theChipStore = new LiveTileStore(workChipStoreDeps())

/** The chip store (the route mounts one board). */
export function workChipStore(): LiveTileStore {
  return theChipStore
}

/** The SELECTED board row's work chip line — null while the row runs
 *  nothing (no chip, no noise) or is not a live session. `active` gates the
 *  whole subscription exactly like the tile's: only the selected, real
 *  session row registers (one registration at a time). */
export function useWorkChip(sessionId: string, active: boolean): string | null {
  const [, bump] = useState(0)
  const on = active && sessionId !== '' && !sessionId.startsWith('dispatch:')
  useEffect(() => {
    if (!on) return
    const unsub = theChipStore.register(sessionId, '', () => bump(v => v + 1))
    const unsubDeg = theChipStore.onDegradeChange(() => bump(v => v + 1))
    return () => {
      unsub()
      unsubDeg()
    }
  }, [sessionId, on])
  if (!on) return null
  const now = theChipStore.readTile(sessionId)
  return now.kind === 'still' ? null : now.line
}

/** The footer's one truth (line 7): the board says the degrade ONCE. */
export function useLiveTilesDegraded(): boolean {
  const [v, setV] = useState(theStore.isDegraded())
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    const unsub = theStore.onDegradeChange(() => {
      if (mounted.current) setV(theStore.isDegraded())
    })
    setV(theStore.isDegraded())
    return () => {
      mounted.current = false
      unsub()
    }
  }, [])
  return v
}
