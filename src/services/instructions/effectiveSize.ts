// ============================================================================
//  instructions/effectiveSize.ts — the effective-size measure behind the
//  standing trim chip.
//
//  EFFECTIVE loaded project-instruction content = the entry file(s) PLUS
//  everything the import law pulls in: composed entries of Project/Local
//  type that either ARE a native instruction file (MERCURY.md ·
//  MERCURY.local.md, any home) or were composed through an @import chain
//  (they carry `parent`). Rules-directory files are deliberately outside the
//  measure — the chip's advice is "trim mercury.md", and rules are not that
//  file's weight. A 3-line pointer at a 600-line guide measures 603: the
//  pointer law means the ENTRY's cost is whatever it pulls in.
//
//  The chip arms past PROJECT_INSTRUCTION_TRIM_LINE_THRESHOLD effective
//  lines and disarms when the estate is tightened. Push, not poll: the
//  measure re-runs when the engine's discovery cache is invalidated (the
//  /memory dialog, worktree moves, compaction reloads — every path that
//  could change what is loaded), via the engine's invalidation hook.
// ============================================================================
import { basename } from 'node:path'

import type { InstructionSourceEntry } from './contracts.js'
import {
  getInstructionFiles,
  onInstructionCacheInvalidated,
} from './engine.js'

/** The ~400-line bar: past this many effective loaded lines the standing
 *  trim chip arms. A notice only — nothing ever auto-edits the estate. */
export const PROJECT_INSTRUCTION_TRIM_LINE_THRESHOLD = 400

/** The native entry-file names, by basename (either project-config home). */
const ENTRY_BASENAMES = new Set(['MERCURY.md', 'MERCURY.local.md'])

/** Pure measure over composed entries: line count of the project
 *  instruction estate as loaded (entry files + their import chains). */
export function measureEffectiveProjectInstructionLines(
  files: readonly InstructionSourceEntry[],
): number {
  let lines = 0
  for (const file of files) {
    if (file.type !== 'Project' && file.type !== 'Local') continue
    if (!ENTRY_BASENAMES.has(basename(file.path)) && file.parent === undefined) continue
    const content = file.content.trim()
    if (content === '') continue
    lines += content.split('\n').length
  }
  return lines
}

export type TrimChipSnapshot = {
  armed: boolean
  effectiveLines: number
}

let snapshot: TrimChipSnapshot = { armed: false, effectiveLines: 0 }
const subscribers = new Set<() => void>()
let engineHookArmed = false
let measureScheduled = false

function scheduleMeasure(): void {
  if (measureScheduled) return
  measureScheduled = true
  queueMicrotask(() => {
    measureScheduled = false
    void (async () => {
      try {
        const lines = measureEffectiveProjectInstructionLines(
          await getInstructionFiles(),
        )
        const armed = lines > PROJECT_INSTRUCTION_TRIM_LINE_THRESHOLD
        if (armed === snapshot.armed && lines === snapshot.effectiveLines) return
        snapshot = { armed, effectiveLines: lines }
        for (const cb of subscribers) cb()
      } catch {
        // A failed measure keeps the last honest snapshot; the next
        // invalidation re-tries. The chip must never take down a render.
      }
    })()
  })
}

/** useSyncExternalStore subscribe: arms the engine invalidation hook once,
 *  kicks a measure per new subscriber, and re-measures on every discovery
 *  cache invalidation while anyone is mounted. */
export function subscribeTrimChip(cb: () => void): () => void {
  subscribers.add(cb)
  if (!engineHookArmed) {
    engineHookArmed = true
    onInstructionCacheInvalidated(() => {
      if (subscribers.size > 0) scheduleMeasure()
    })
  }
  scheduleMeasure()
  return () => {
    subscribers.delete(cb)
  }
}

/** useSyncExternalStore snapshot — stable object identity between changes. */
export function getTrimChipSnapshot(): TrimChipSnapshot {
  return snapshot
}
