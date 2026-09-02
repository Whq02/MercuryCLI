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


export type LiveTileNow =
  | { kind: 'streaming'; line: string }
  | { kind: 'tool'; line: string }
  | { kind: 'settled'; line: string }
  | { kind: 'still' }

const nowEquals = (a: LiveTileNow, b: LiveTileNow): boolean =>
  a.kind === b.kind && (a.kind === 'still' || (b.kind !== 'still' && a.line === (b as { line: string }).line))

export function lastLineOf(text: string): string {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const flat = (lines[i] ?? '').replace(/\s+/g, ' ').trim()
    if (flat.length > 0) return sanitizeLabel(flat.slice(-56))
  }
  return ''
}

export function askTileCopy(title: string, question: string): string {
  const lead = `"${title}" asks to `
  return question.startsWith(lead) ? question.slice(lead.length) : question
}

const TAIL_FRESH_MS = 10_000
export function gateTailFreshness(
  tail: { atMs: number; text: string | null } | null,
  nowMs: number,
): { atMs: number; text: string | null } | null {
  if (tail === null || tail.text === null) return tail
  return nowMs - tail.atMs < TAIL_FRESH_MS ? tail : { atMs: tail.atMs, text: null }
}
const DRAIN_COALESCE_MS = 80
const HEARTBEAT_MS = 1000
export const TILE_BUDGET_MS_PER_S = 40
const DEGRADE_WINDOWS = 2
const RECOVER_PROBES = 2
const PROBE_MS = 5000

interface TileEntry {
  sessionId: string
  workspaceId: string
  tailFile: string
  listeners: Set<() => void>
  now: LiveTileNow
  dirty: boolean
  transcriptStamp: string
  tailStamp: string
}

export interface LiveTileStoreDeps {
  tailDir: () => string
  tailPath: (sessionId: string) => string
  readTail: (sessionId: string) => { atMs: number; text: string | null } | null
  activity: (rec: { sessionId: string; workspaceId: string }) => { label: string; kind?: 'tool' | 'text' } | null
  transcriptPath: (rec: { sessionId: string; workspaceId: string }) => string
  nowMs: () => number
  forceDegrade: boolean
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
        }
        if (this.watcher === watcher) this.watcher = null
      })
      this.watcher = watcher
    } catch {
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
        const tailRaw = gateTailFreshness(this.deps.readTail(e.sessionId), this.deps.nowMs())
        const tailStamp = tailRaw === null ? 'none' : `${tailRaw.atMs}:${tailRaw.text === null ? 0 : tailRaw.text.length}`
        let transcriptStamp = 'none'
        try {
          const st = statSync(this.deps.transcriptPath({ sessionId: e.sessionId, workspaceId: e.workspaceId }))
          transcriptStamp = `${st.mtimeMs}:${st.size}`
        } catch {
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
    for (const e of this.entries.values()) {
      for (const l of [...e.listeners]) {
        try {
          l()
        } catch {
        }
      }
    }
  }

  _drainForTesting(): void {
    for (const e of this.entries.values()) e.dirty = true
    this.drain()
  }
}

const theStore = new LiveTileStore()

export function liveTileStore(): LiveTileStore {
  return theStore
}

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


export function workChipTextOf(facts: { work?: readonly WorkRowV1[] } | null): string | null {
  if (facts === null) return null
  const line = workChipLine(workCounts(facts.work ?? []))
  return line === null ? null : `${line} running`
}

export const CHIP_FRESH_MS = TAIL_FRESH_MS

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

export function workChipStore(): LiveTileStore {
  return theChipStore
}

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
