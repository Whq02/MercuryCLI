import { resetPointerShape } from '../../cockpit/pointerShape.js'
import { emptyFrame } from '../frame.js'
import { termWrite } from '../terminalOut.js'
import type { TeardownHost } from '../root/teardown.js'
import { stopSignalsSupported, POSIX_STOP_SIGNALS, isStopSignal, restoreTerminalForStop, continueRearmBytes } from '../root/stop-continue.js'
import { shutdownReleaseObligations } from '../root/terminalModeLedger.js'
import { extendedKeysSupportedNow } from '../terminal-session/capabilities.js'
import { writeAllSync, streamTakesWrites } from '../terminal-session/frameDelivery.js'
import { HIDE_CURSOR } from '../termio/dec.js'
import { supportsTabStatus } from '../termio/osc.js'
import { reenterAltScreen } from './alt-screen.js'
import { drainStdin } from './stdin.js'
import type Ink from '../screenInstance.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

export function attachStopListeners(this: Pick<Ink, 'stopListenersAttached' | 'stopForSignal'>): void {
  if (this.stopListenersAttached || !stopSignalsSupported()) return
  for (const signal of POSIX_STOP_SIGNALS) process.on(signal, this.stopForSignal)
  this.stopListenersAttached = true
}

export function detachStopListeners(this: Pick<Ink, 'stopListenersAttached' | 'stopForSignal'>): void {
  if (!this.stopListenersAttached) return
  for (const signal of POSIX_STOP_SIGNALS) process.off(signal, this.stopForSignal)
  this.stopListenersAttached = false
}

export function teardownHost(this: Pick<Ink, 'options' | 'altScreenActive'>): TeardownHost {
  return {
    altScreenActive: this.altScreenActive,
    tabStatusSupported: supportsTabStatus(),
    write: bytes => {
      writeAllSync(1, Buffer.from(bytes, 'utf8'))
    },
    drainStdin: () => drainStdin(this.options.stdin),
    resetPointer: resetPointerShape,
  }
}

type StopForSignalReads = Pick<
  Ink,
  | 'options' | 'isTTY' | 'isUnmounted' | 'altScreenActive' | 'rawModeOffForStop' | 'stopListenersAttached' | 'stopForSignal'
>

export function stopForSignal(this: StopForSignalReads, signal: NodeJS.Signals): void {
  if (!isStopSignal(signal)) return
  detachStopListeners.call(this)
  if (this.isTTY && !this.isUnmounted) {
    const receipt = restoreTerminalForStop(signal, teardownHost.call(this), this.options.stdin)
    this.rawModeOffForStop = receipt.rawModeOff
  }
  try {
    process.kill(process.pid, signal)
  } catch (error) {
    passedOver(error)
  }
  if (!this.isUnmounted) attachStopListeners.call(this)
}

type ResumeAfterContinueReads = Pick<
  Ink,
  | 'options' | 'isTTY' | 'stylePool' | 'charPool' | 'hyperlinkPool' | 'frontFrame' | 'backFrame' | 'cachedColumns' | 'cachedRows' | 'ledger'
  | 'isUnmounted' | 'altScreenActive' | 'mouseTracking' | 'displayCursor' | 'wholeFrameDue' | 'glassOverlay' | 'rawModeOffForStop'
  | 'stopListenersAttached' | 'scheduleRender' | 'armScreenWatchdog' | 'stopForSignal'
>

export function resumeAfterContinue(this: ResumeAfterContinueReads): void {
  if (!this.isTTY || this.isUnmounted) return
  if (this.rawModeOffForStop) {
    this.rawModeOffForStop = false
    try {
      this.options.stdin.setRawMode(true)
    } catch (error) {
      passedOver(error)
    }
  }
  attachStopListeners.call(this)
  if (streamTakesWrites(this.options.stdout)) {
    termWrite(
      this.options.stdout,
      continueRearmBytes({
        extendedKeys: extendedKeysSupportedNow(),
        altActive: this.altScreenActive,
        mouseTracking: this.mouseTracking,
      }),
    )
    if (shutdownReleaseObligations().includes('cursor-hidden')) {
      termWrite(this.options.stdout, HIDE_CURSOR)
    }
  }
  if (this.altScreenActive) {
    reenterAltScreen.call(this);
    this.armScreenWatchdog();
    this.wholeFrameDue = true
    this.scheduleRender()
    return
  }
  this.frontFrame = emptyFrame(
    this.frontFrame.viewport.height,
    this.frontFrame.viewport.width,
    this.stylePool,
    this.charPool,
    this.hyperlinkPool,
  )
  this.backFrame = emptyFrame(
    this.backFrame.viewport.height,
    this.backFrame.viewport.width,
    this.stylePool,
    this.charPool,
    this.hyperlinkPool,
  )
  this.ledger.syncAfterDeliberateReset()
  this.displayCursor = null
  this.ledger.contaminate('blank-reset')
  this.scheduleRender()
}
