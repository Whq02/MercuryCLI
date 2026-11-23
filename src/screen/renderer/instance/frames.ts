import { createScreen, CharPool, HyperlinkPool, migrateScreenPools } from '../cell-grid.js'
import { type Frame, emptyFrame, type Patch } from '../frame.js'
import { cursorPosition } from '../termio/csi.js'
import type ScreenInstance from '../screenInstance.js'

export const DEFAULT_COLUMNS = 80

export const DEFAULT_ROWS = 24

export function newEmptyFrame(this: Pick<ScreenInstance, 'stylePool' | 'charPool' | 'hyperlinkPool' | 'cachedColumns' | 'cachedRows'>): Frame {
  return emptyFrame(
    this.cachedRows,
    this.cachedColumns,
    this.stylePool,
    this.charPool,
    this.hyperlinkPool,
  )
}

export function buildParkPatch(this: Pick<ScreenInstance, 'cachedRows'>): Patch {
  return { type: 'stdout', content: cursorPosition(this.cachedRows, 1) }
}

export function liveSize(this: Pick<ScreenInstance, 'options'>): { columns: number; rows: number } {
  return {
    columns: this.options.stdout.columns || DEFAULT_COLUMNS,
    rows: this.options.stdout.rows || DEFAULT_ROWS,
  }
}

type ResetFramesForAltScreenReads = Pick<
  ScreenInstance,
  | 'stylePool' | 'charPool' | 'hyperlinkPool' | 'frontFrame' | 'backFrame' | 'cachedColumns' | 'cachedRows' | 'ledger' | 'displayCursor'
  | 'glassOverlay'
>

export function resetFramesForAltScreen(this: ResetFramesForAltScreenReads): void {
  const make = (): Frame => ({
    screen: createScreen(
      this.cachedColumns,
      this.cachedRows,
      this.stylePool,
      this.charPool,
      this.hyperlinkPool,
    ),
    viewport: { width: this.cachedColumns, height: this.cachedRows },
    cursor: { x: 0, y: 0, visible: true },
  })
  this.frontFrame = make()
  this.backFrame = make()
  this.glassOverlay = null
  this.ledger.syncAfterDeliberateReset()
  this.displayCursor = null
  this.ledger.contaminate('blank-reset')
}

type RepaintMainScreenReads = Pick<
  ScreenInstance,
  | 'stylePool' | 'charPool' | 'hyperlinkPool' | 'frontFrame' | 'backFrame' | 'ledger' | 'displayCursor' | 'glassOverlay'
>

export function repaintMainScreen(this: RepaintMainScreenReads): void {
  const rebuild = (frame: Frame): Frame =>
    emptyFrame(
      frame.viewport.height,
      frame.viewport.width,
      this.stylePool,
      this.charPool,
      this.hyperlinkPool,
    )
  this.frontFrame = rebuild(this.frontFrame)
  this.backFrame = rebuild(this.backFrame)
  this.glassOverlay = null
  this.ledger.syncAfterDeliberateReset()
  this.displayCursor = null
}

type ResetLineCountReads = Pick<
  ScreenInstance,
  | 'isTTY' | 'stylePool' | 'charPool' | 'hyperlinkPool' | 'frontFrame' | 'backFrame' | 'altScreenActive' | 'displayCursor'
>

export function resetLineCount(this: ResetLineCountReads): void {
  if (this.altScreenActive || !this.isTTY) return
  this.backFrame = this.frontFrame
  this.frontFrame = emptyFrame(
    this.frontFrame.viewport.height,
    this.frontFrame.viewport.width,
    this.stylePool,
    this.charPool,
    this.hyperlinkPool,
  )
  this.displayCursor = null
}

export function resetPools(this: Pick<ScreenInstance, 'charPool' | 'hyperlinkPool' | 'frontFrame' | 'backFrame' | 'lastPoolReset'>): void {
  this.charPool = new CharPool()
  this.hyperlinkPool = new HyperlinkPool()
  migrateScreenPools(this.frontFrame.screen, this.charPool, this.hyperlinkPool)
  this.backFrame.screen.charPool = this.charPool
  this.backFrame.screen.hyperlinkPool = this.hyperlinkPool
  this.lastPoolReset = Date.now()
}
