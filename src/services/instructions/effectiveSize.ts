import { basename } from 'node:path'

import { SHARED_INSTRUCTION_FILE } from './adapters/agentsMd.js'
import type { InstructionSourceEntry } from './contracts.js'
import { NATIVE_INSTRUCTION_FILE_NAMES } from './nativeSource.js'
import {
  getInstructionFiles,
  onInstructionCacheInvalidated,
} from './engine.js'

export const PROJECT_INSTRUCTION_TRIM_LINE_THRESHOLD = 400

const ENTRY_BASENAMES_BY_RANK = [NATIVE_INSTRUCTION_FILE_NAMES[0], SHARED_INSTRUCTION_FILE, NATIVE_INSTRUCTION_FILE_NAMES[1]]
const ENTRY_BASENAMES = new Set(ENTRY_BASENAMES_BY_RANK)

export function measuredGuideName(files: readonly InstructionSourceEntry[]): string {
  const entries = new Set(
    files
      .filter(file => (file.type === 'Project' || file.type === 'Local') && file.content.trim() !== '')
      .map(file => basename(file.path)),
  )
  return ENTRY_BASENAMES_BY_RANK.find(name => entries.has(name)) ?? ENTRY_BASENAMES_BY_RANK[0]!
}

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
  guide: string
}

let snapshot: TrimChipSnapshot = { armed: false, effectiveLines: 0, guide: ENTRY_BASENAMES_BY_RANK[0]! }
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
        const files = await getInstructionFiles()
        const lines = measureEffectiveProjectInstructionLines(files)
        const guide = measuredGuideName(files)
        const armed = lines > PROJECT_INSTRUCTION_TRIM_LINE_THRESHOLD
        if (armed === snapshot.armed && lines === snapshot.effectiveLines && guide === snapshot.guide) return
        snapshot = { armed, effectiveLines: lines, guide }
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
