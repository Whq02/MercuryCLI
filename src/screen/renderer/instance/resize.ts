import { refreshConsoleSize } from '../root/console-size.js'
import { resizeReassertBytes } from '../root/screen-session.js'
import { termWrite } from '../terminalOut.js'
import { RESIZE_SETTLE_MS } from '../constants.js'
import { syncOutputSupportedNow, syncOutputCapabilityNow } from '../terminal-session/capabilities.js'
import { writeDiffToTerminal } from '../terminal-session/frameDelivery.js'
import { ENTER_ALT_SCREEN } from '../termio/dec.js'
import { liveSize, buildParkPatch, resetFramesForAltScreen } from './frames.js'
import type ScreenInstance from '../screenInstance.js'
import { startTimeout, stopTimeout } from '../../../platform/async/timers.js'
import { consoleSizeNeedsPolling } from '../../../platform/host-os/terminal.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'

type HandleResizeReads = Pick<
  ScreenInstance,
  | 'options' | 'isTTY' | 'frontFrame' | 'cachedColumns' | 'cachedRows' | 'writer' | 'scheduler' | 'isPaused' | 'isRendering' | 'altScreenActive'
  | 'displayCursor' | 'wholeFrameDue' | 'resizeSettleTimer' | 'fittingConsoleBuffer' | 'applySettledResize'
>

export function handleResize(this: HandleResizeReads): void {
  if (this.isRendering || this.fittingConsoleBuffer) return
  settleResize.call(this)
}

type SettleResizeReads = Pick<
  ScreenInstance,
  | 'options' | 'isTTY' | 'frontFrame' | 'cachedColumns' | 'cachedRows' | 'writer' | 'scheduler' | 'isPaused' | 'altScreenActive' | 'displayCursor'
  | 'wholeFrameDue' | 'resizeSettleTimer' | 'applySettledResize'
>

export function settleResize(this: SettleResizeReads): void {
  const { columns, rows } = liveSize.call(this)
  if (this.resizeSettleTimer === null) {
    if (columns === this.cachedColumns && rows === this.cachedRows) return
    paintResizeHold.call(this, columns, rows)
  } else {
    stopTimeout(this.resizeSettleTimer)
  }
  if (settleHoldPaints.call(this)) this.scheduler.releaseSettleHold(true)
  else this.scheduler.holdForSettle()
  this.resizeSettleTimer = startTimeout(this.applySettledResize, RESIZE_SETTLE_MS)
}

export function settleHoldPaints(this: Pick<ScreenInstance, 'options' | 'isTTY' | 'cachedRows' | 'isPaused' | 'altScreenActive' | 'wholeFrameDue'>): boolean {
  return this.altScreenActive && this.isTTY && !this.wholeFrameDue && liveSize.call(this).rows === this.cachedRows && !consoleBufferOutlivesWindow.call(this)
}

export function handleWinch(this: Pick<ScreenInstance, 'options' | 'cachedColumns' | 'cachedRows' | 'resizeSettleTimer' | 'overwriteScreen'>): void {
  refreshConsoleSize(this.options.stdout)
  if (this.resizeSettleTimer !== null) return
  const { columns, rows } = liveSize.call(this)
  if (columns === this.cachedColumns && rows === this.cachedRows) this.overwriteScreen()
}

type PaintResizeHoldReads = Pick<
  ScreenInstance,
  | 'options' | 'isTTY' | 'frontFrame' | 'writer' | 'isPaused' | 'altScreenActive' | 'displayCursor' | 'wholeFrameDue'
>

function paintResizeHold(this: PaintResizeHoldReads, columns: number, rows: number): void {
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

export function consoleBufferOutlivesWindow(this: Pick<ScreenInstance, 'isTTY' | 'isPaused' | 'altScreenActive'>): boolean {
  return consoleSizeNeedsPolling() && !syncOutputCapabilityNow() && this.altScreenActive && !this.isPaused && this.isTTY
}

function fitConsoleBufferToWindow(this: Pick<ScreenInstance, 'options' | 'isTTY' | 'isPaused' | 'altScreenActive' | 'fittingConsoleBuffer'>): void {
  if (!consoleBufferOutlivesWindow.call(this)) return
  termWrite(this.options.stdout, ENTER_ALT_SCREEN)
  this.fittingConsoleBuffer = true
  try {
    refreshConsoleSize(this.options.stdout)
  } finally {
    this.fittingConsoleBuffer = false
  }
}

type ApplySettledResizeReads = Pick<
  ScreenInstance,
  | 'options' | 'isTTY' | 'stylePool' | 'charPool' | 'hyperlinkPool' | 'frontFrame' | 'backFrame' | 'cachedColumns' | 'cachedRows' | 'parkPatch'
  | 'scheduler' | 'ledger' | 'currentTree' | 'isPaused' | 'altScreenActive' | 'mouseTracking' | 'displayCursor' | 'wholeFrameDue' | 'resizeSettleTimer'
  | 'glassOverlay' | 'resizeEraseDue' | 'fittingConsoleBuffer' | 'render'
>

export function applySettledResize(this: ApplySettledResizeReads): void {
  this.resizeSettleTimer = null
  fitConsoleBufferToWindow.call(this)
  const { columns, rows } = liveSize.call(this)
  applySize.call(this, columns, rows)
  this.scheduler.releaseSettleHold(false)
  if (this.currentTree !== null) this.render(this.currentTree)
}

type ApplySizeReads = Pick<
  ScreenInstance,
  | 'options' | 'isTTY' | 'stylePool' | 'charPool' | 'hyperlinkPool' | 'frontFrame' | 'backFrame' | 'cachedColumns' | 'cachedRows' | 'parkPatch'
  | 'ledger' | 'isPaused' | 'altScreenActive' | 'mouseTracking' | 'displayCursor' | 'wholeFrameDue' | 'resizeEraseDue' | 'currentTree' | 'glassOverlay'
>

export function applySize(this: ApplySizeReads, columns: number, rows: number): void {
  const shrank = columns < this.cachedColumns || rows < this.cachedRows
  this.cachedColumns = columns
  this.cachedRows = rows
  this.parkPatch = buildParkPatch.call(this)
  if (this.altScreenActive && !this.isPaused && this.isTTY) {
    this.resizeEraseDue = shrank && this.currentTree !== null && hostEnv().TERM_PROGRAM === 'Apple_Terminal'
    termWrite(this.options.stdout, resizeReassertBytes(this.mouseTracking))
    resetFramesForAltScreen.call(this)
    this.wholeFrameDue = true
  }
}

export function clearResizeSettle(this: Pick<ScreenInstance, 'scheduler' | 'resizeSettleTimer'>): void {
  if (this.resizeSettleTimer !== null) {
    stopTimeout(this.resizeSettleTimer)
    this.resizeSettleTimer = null
  }
  this.scheduler.releaseSettleHold(false)
}

export function reconcileSize(this: Pick<ScreenInstance, 'options' | 'handleResize'>): void {
  if (!consoleSizeNeedsPolling()) return;
  if (!refreshConsoleSize(this.options.stdout)) this.handleResize();
}
