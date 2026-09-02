import { basename } from 'node:path'

import type { InstructionSourceEntry } from './contracts.js'
import {
  getInstructionFiles,
  onInstructionCacheInvalidated,
} from './engine.js'

export const PROJECT_INSTRUCTION_TRIM_LINE_THRESHOLD = 400

const ENTRY_BASENAMES = new Set(['MERCURY.md', 'MERCURY.local.md'])

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
      }
    })()
  })
}

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

export function getTrimChipSnapshot(): TrimChipSnapshot {
  return snapshot
}
