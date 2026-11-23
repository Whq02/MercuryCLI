import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { getCellLayoutCounters } from '../layout/cellLayout.js'
import { recordLayoutMs, noteSlowLayout } from '../reconciler.js'
import { COMMIT_TEE_PATH, teeCommitGeometry } from './tees.js'
import type Ink from '../screenInstance.js'

type CalculateLayoutReads = Pick<
  Ink,
  | 'cachedColumns' | 'cachedRows' | 'rootNode' | 'lastAssignedWidth' | 'lastAssignedMaxHeight' | 'layoutCounters' | 'isUnmounted' | 'altScreenActive'
>

export function calculateLayout(this: CalculateLayoutReads): void {
  if (this.isUnmounted) return
  const layout = this.rootNode.layoutNode
  if (!layout) return
  if (this.lastAssignedWidth !== this.cachedColumns) {
    layout.setWidth(this.cachedColumns)
    this.lastAssignedWidth = this.cachedColumns
  }
  const maxHeight = this.altScreenActive ? this.cachedRows : null
  if (this.lastAssignedMaxHeight !== maxHeight) {
    layout.setMaxHeight(maxHeight ?? Number.NaN)
    this.lastAssignedMaxHeight = maxHeight
  }
  const started = performance.now()
  layout.calculateLayout(this.cachedColumns, undefined)
  const elapsed = performance.now() - started
  recordLayoutMs(elapsed)
  this.layoutCounters = getCellLayoutCounters()
  noteSlowLayout(elapsed, this.layoutCounters)
  if (COMMIT_TEE_PATH) teeCommitGeometry.call(this, elapsed)
}

export function layoutAfterCommit(this: Pick<Ink, 'isUnmounted' | 'layoutListeners' | 'calculateLayout'>): void {
  if (this.isUnmounted) return
  this.calculateLayout()
  for (const listener of this.layoutListeners) {
    try {
      listener()
    } catch (error) {
      logForDebugging(`layout listener threw (ignored): ${error}`, { level: 'warn' })
    }
  }
}

export function subscribeLayout(this: Pick<Ink, 'layoutListeners'>, listener: () => void): () => void {
  this.layoutListeners.add(listener)
  return () => {
    this.layoutListeners.delete(listener)
  }
}
