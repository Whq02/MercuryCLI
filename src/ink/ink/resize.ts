import { refreshConsoleSize } from '../root/console-size.js'
import { resizeReassertBytes } from '../root/screen-session.js'
import { termWrite } from '../terminalOut.js'
import { RESIZE_SETTLE_MS } from '../constants.js'
import { syncOutputSupportedNow, syncOutputCapabilityNow } from '../session/capabilities.js'
import { writeDiffToTerminal } from '../session/delivery.js'
import { ENTER_ALT_SCREEN } from '../termio/dec.js'
import type Ink from '../ink.js'

export function handleResize(this: Pick<Ink, 'isRendering' | 'fittingConsoleBuffer' | 'settleResize'>): void {
  if (this.isRendering || this.fittingConsoleBuffer) return
  this.settleResize()
}

type SettleResizeReads = Pick<
  Ink,
  | 'cachedColumns' | 'cachedRows' | 'scheduler' | 'resizeSettleTimer' | 'liveSize' | 'paintResizeHold' | 'applySettledResize'
>

export function settleResize(this: SettleResizeReads): void {
  const { columns, rows } = this.liveSize()
  if (this.resizeSettleTimer === null) {
    if (columns === this.cachedColumns && rows === this.cachedRows) return
    this.scheduler.holdForSettle()
    this.paintResizeHold(columns, rows)
  } else {
    clearTimeout(this.resizeSettleTimer)
  }
  this.resizeSettleTimer = setTimeout(this.applySettledResize, RESIZE_SETTLE_MS)
}

export function handleWinch(this: Pick<Ink, 'options' | 'cachedColumns' | 'cachedRows' | 'resizeSettleTimer' | 'liveSize' | 'overwriteScreen'>): void {
  refreshConsoleSize(this.options.stdout)
  if (this.resizeSettleTimer !== null) return
  const { columns, rows } = this.liveSize()
  if (columns === this.cachedColumns && rows === this.cachedRows) this.overwriteScreen()
}

type PaintResizeHoldReads = Pick<
  Ink,
  | 'options' | 'isTTY' | 'frontFrame' | 'writer' | 'isPaused' | 'altScreenActive' | 'displayCursor' | 'wholeFrameDue'
>

export function paintResizeHold(this: PaintResizeHoldReads, columns: number, rows: number): void {
  if (!this.altScreenActive || this.isPaused || !this.isTTY || this.wholeFrameDue) return
  const patches = this.writer.holdingClipPaint(this.frontFrame, columns, rows)
  if (patches.length === 0) return
  writeDiffToTerminal(
    { stdout: this.options.stdout, stderr: this.options.stderr },
    patches,
    !syncOutputSupportedNow(),
  )
  this.displayCursor = null
}

export function consoleBufferOutlivesWindow(this: Pick<Ink, 'isTTY' | 'isPaused' | 'altScreenActive'>): boolean {
  return process.platform === 'win32' && !syncOutputCapabilityNow() && this.altScreenActive && !this.isPaused && this.isTTY
}

export function fitConsoleBufferToWindow(this: Pick<Ink, 'options' | 'fittingConsoleBuffer' | 'consoleBufferOutlivesWindow'>): void {
  if (!this.consoleBufferOutlivesWindow()) return
  termWrite(this.options.stdout, ENTER_ALT_SCREEN)
  this.fittingConsoleBuffer = true
  try {
    refreshConsoleSize(this.options.stdout)
  } finally {
    this.fittingConsoleBuffer = false
  }
}

type ApplySettledResizeReads = Pick<
  Ink,
  | 'scheduler' | 'currentTree' | 'resizeSettleTimer' | 'liveSize' | 'fitConsoleBufferToWindow' | 'applySize' | 'render'
>

export function applySettledResize(this: ApplySettledResizeReads): void {
  this.resizeSettleTimer = null
  this.fitConsoleBufferToWindow()
  const { columns, rows } = this.liveSize()
  this.applySize(columns, rows)
  this.scheduler.releaseSettleHold(false)
  if (this.currentTree !== null) this.render(this.currentTree)
}

type ApplySizeReads = Pick<
  Ink,
  | 'options' | 'isTTY' | 'cachedColumns' | 'cachedRows' | 'parkPatch' | 'isPaused' | 'altScreenActive' | 'mouseTracking' | 'wholeFrameDue'
  | 'buildParkPatch' | 'resetFramesForAltScreen'
>

export function applySize(this: ApplySizeReads, columns: number, rows: number): void {
  this.cachedColumns = columns
  this.cachedRows = rows
  this.parkPatch = this.buildParkPatch()
  if (this.altScreenActive && !this.isPaused && this.isTTY) {
    termWrite(this.options.stdout, resizeReassertBytes(this.mouseTracking))
    this.resetFramesForAltScreen()
    this.wholeFrameDue = true
  }
}

export function clearResizeSettle(this: Pick<Ink, 'scheduler' | 'resizeSettleTimer'>): void {
  if (this.resizeSettleTimer !== null) {
    clearTimeout(this.resizeSettleTimer)
    this.resizeSettleTimer = null
  }
  this.scheduler.releaseSettleHold(false)
}

export function reconcileSize(this: Pick<Ink, 'options' | 'handleResize'>): void {
  if (process.platform !== 'win32') return;
  if (!refreshConsoleSize(this.options.stdout)) this.handleResize();
}
