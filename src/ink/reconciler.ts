import { appendFileSync } from 'node:fs'
import { createContext } from 'react'
import createReconciler from 'react-reconciler'
import {
  DefaultEventPriority,
  DiscreteEventPriority,
  NoEventPriority,
} from 'react-reconciler/constants.js'
import {
  appendChildNode,
  clearLayoutNodeReferences,
  createNode,
  createTextNode,
  insertBeforeNode,
  markDirty,
  removeChildNode,
  setAttribute,
  setStyle,
  setTextNodeValue,
  setTextStyles,
  type DOMElement,
  type DOMNode,
  type DOMNodeAttribute,
  type ElementNames,
  type TextNode,
} from './dom.js'
import { EVENT_HANDLER_PROPS } from './events/event-handlers.js'
import { Dispatcher } from './events/dispatcher.js'
import applyStyles, { type Styles, type TextStyles } from './styles.js'
import { passedOver } from '../utils/passedOver.js'
import { startTimeout, stopTimeout } from '../utils/timers.js'
import { notBuilt, unbuilt, type Unbuilt } from '../pi/holes.js'

export const dispatcher: Unbuilt = unbuilt('src/ink/reconciler.ts:34')

export function recordLayoutMs(ms: number): void {
  return notBuilt('src/ink/reconciler.ts:40')
}
export function getLastYogaMs(): number {
  return notBuilt('src/ink/reconciler.ts:43')
}
export function markCommitStart(): void {
  return notBuilt('src/ink/reconciler.ts:46')
}
export function getLastCommitMs(): number {
  return notBuilt('src/ink/reconciler.ts:49')
}
export function resetProfileCounters(): void {
  return notBuilt('src/ink/reconciler.ts:52')
}

export function isDebugRepaintsEnabled(): boolean {
  return notBuilt('src/ink/reconciler.ts:57')
}

const COMMIT_LOG_PATH: string | undefined = undefined
let lastCommitEndMs = 0
let commitsThisSecond = 0
let maxGapThisSecond = 0
let secondWindowStart = 0
let instanceCreations = 0

function commitLog(line: string): void {
  if (!COMMIT_LOG_PATH) return
  try {
    appendFileSync(COMMIT_LOG_PATH, `${new Date().toISOString()} ${line}\n`)
  } catch (error) {
    passedOver(error)
  }
}

function noteCommit(reconcileMs: number): void {
  if (!COMMIT_LOG_PATH) return
  const now = performance.now()
  const gap = lastCommitEndMs === 0 ? 0 : now - lastCommitEndMs
  lastCommitEndMs = now
  if (gap > 30 || reconcileMs > 20 || instanceCreations > 50) {
    commitLog(
      `commit gap=${gap.toFixed(1)}ms reconcile=${reconcileMs.toFixed(1)}ms creations=${instanceCreations}`,
    )
  }
  commitsThisSecond++
  if (gap > maxGapThisSecond) maxGapThisSecond = gap
  if (now - secondWindowStart >= 1000) {
    if (secondWindowStart !== 0) {
      commitLog(
        `second commits=${commitsThisSecond} maxGap=${maxGapThisSecond.toFixed(1)}ms`,
      )
    }
    secondWindowStart = now
    commitsThisSecond = 0
    maxGapThisSecond = 0
  }
}

export function noteSlowLayout(
  ms: number,
  counters: { visited: number; measured: number; cacheHits: number; live: number },
): void {
  if (!COMMIT_LOG_PATH || ms <= 20) return
  commitLog(
    `slow-layout ${ms.toFixed(1)}ms visited=${counters.visited} measured=${counters.measured} cacheHits=${counters.cacheHits} live=${counters.live}`,
  )
}


type Props = Record<string, unknown>
type HostContext = { isInsideText: boolean }

const OUTSIDE_TEXT: HostContext = { isInsideText: false }
const INSIDE_TEXT: HostContext = { isInsideText: true }

const TEXT_HOST_ELEMENTS = new Set(['ink-text', 'ink-virtual-text', 'ink-link'])

function diffProps(oldProps: Props, newProps: Props): Props | null {
  let diff: Props | null = null
  for (const key of Object.keys(oldProps)) {
    if (key === 'children') continue
    if (!(key in newProps)) {
      ;(diff ??= {})[key] = undefined
    }
  }
  for (const [key, value] of Object.entries(newProps)) {
    if (key === 'children') continue
    if (oldProps[key] !== value) {
      ;(diff ??= {})[key] = value
    }
  }
  return diff
}

function findRoot(node: DOMElement): DOMElement {
  let current: DOMElement = node
  while (current.parentNode) current = current.parentNode
  return current
}

const reconciler: Unbuilt = unbuilt('src/ink/reconciler.ts:203')

function diffStyle(oldStyle: Styles, newStyle: Styles): Styles | null {
  let diff: Record<string, unknown> | null = null
  const oldRecord = oldStyle as Record<string, unknown>
  const newRecord = newStyle as Record<string, unknown>
  for (const key of Object.keys(oldRecord)) {
    if (!(key in newRecord)) (diff ??= {})[key] = undefined
  }
  for (const [key, value] of Object.entries(newRecord)) {
    if (oldRecord[key] !== value) (diff ??= {})[key] = value
  }
  return diff as Styles | null
}

dispatcher.discreteUpdates = <T,>(fn: () => T): T => {
  const previous = dispatcher.currentUpdatePriority
  dispatcher.currentUpdatePriority = DiscreteEventPriority
  try {
    return fn()
  } finally {
    dispatcher.currentUpdatePriority = previous
  }
}

export function flushPendingSyncWork(): void {
  reconciler.flushSyncWork()
}

export default reconciler
