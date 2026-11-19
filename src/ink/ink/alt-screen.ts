import { logForDebugging } from '../../utils/debug.js'
import { resetPointerShape } from '../../utils/cockpit/pointerShape.js'
import reconciler from '../reconciler.js'
import { enterEditorBytes, exitEditorBytes, exitEditorRearmBytes, reenterAltBytes, reassertModesBytes, wakeReenterAltBytes } from '../root/screen-session.js'
import { termWrite } from '../terminalOut.js'
import { noteModeAcquired, noteModeReleased } from '../root/terminalModeLedger.js'
import { extendedKeysSupportedNow } from '../session/capabilities.js'
import { terminalQuerierFor, terminalQuerySettleMs } from '../session/querier.js'
import { streamTakesWrites } from '../session/delivery.js'
import { ERASE_SCREEN, CURSOR_HOME } from '../termio/csi.js'
import { ENABLE_MOUSE_TRACKING, DISABLE_MOUSE_TRACKING, ENTER_ALT_SCREEN } from '../termio/dec.js'
import { drainStdin } from './stdin.js'
import type Ink from '../ink.js'

const WATCHDOG_COMMIT_BUDGET = 12

const OVERWRITE_MIN_GAP_MS = 250

const ALT_SCREEN_SESSION_OWNER = 'alt-screen-session'

type SetAltScreenActiveReads = Pick<
  Ink,
  | 'options' | 'pendingAltEntry' | 'ledger' | 'altScreenActive' | 'mouseTracking' | 'wheelReportingConfirmed' | 'resetFramesForAltScreen'
  | 'repaintMainScreen'
>

export function setAltScreenActive(this: SetAltScreenActiveReads, active: boolean, mouseTracking: boolean): void {
  if (active === this.altScreenActive) return
  this.altScreenActive = active
  this.mouseTracking = active && mouseTracking
  this.wheelReportingConfirmed = false
  if (active) {
    this.resetFramesForAltScreen()
  } else {
    this.pendingAltEntry = null
    resetPointerShape(s => termWrite(this.options.stdout, s))
    this.repaintMainScreen()
    this.ledger.contaminate('blank-reset')
  }
}

export function registerTranscriptScrollTarget(this: Pick<Ink, 'transcriptScrollTarget'>, target: () => boolean): () => void {
  this.transcriptScrollTarget = target
  return () => {
    if (this.transcriptScrollTarget === target) this.transcriptScrollTarget = null
  }
}

export function registerArrowKeyOwner(this: Pick<Ink, 'arrowKeyOwners'>, owns: () => boolean): () => void {
  this.arrowKeyOwners.add(owns)
  return () => {
    this.arrowKeyOwners.delete(owns)
  }
}

export function arrowKeysOwned(this: Pick<Ink, 'arrowKeyOwners'>): boolean {
  for (const owns of this.arrowKeyOwners) if (owns()) return true
  return false
}

export function setMouseTrackingEnabled(this: Pick<Ink, 'options' | 'altScreenActive' | 'mouseTracking' | 'mouseTrackingPref' | 'wheelReportingConfirmed'>, on: boolean): void {
  this.mouseTrackingPref = on
  if (on === this.mouseTracking) return
  this.mouseTracking = on
  this.wheelReportingConfirmed = false
  if (!this.altScreenActive) return
  if (!on) resetPointerShape(s => termWrite(this.options.stdout, s))
  termWrite(this.options.stdout, on ? ENABLE_MOUSE_TRACKING : DISABLE_MOUSE_TRACKING)
  if (on) noteModeAcquired(ALT_SCREEN_SESSION_OWNER, 'mouse-tracking')
  else noteModeReleased(ALT_SCREEN_SESSION_OWNER, 'mouse-tracking')
}

export async function awaitTerminalQueries(this: Pick<Ink, 'options'>): Promise<void> {
  const querier = terminalQuerierFor(this.options.stdout)
  if (querier === undefined || querier.settled()) return
  await querier.whenSettled(terminalQuerySettleMs())
}

export function drainUnsettledQueries(this: Pick<Ink, 'options'>): void {
  const querier = terminalQuerierFor(this.options.stdout)
  if (querier === undefined || querier.settled()) return
  drainStdin(this.options.stdin)
}

export function enterAlternateScreen(this: Pick<Ink, 'options' | 'editorHandoverDepth' | 'altScreenActive' | 'mouseTracking' | 'pause' | 'suspendStdin'>): void {
  this.pause()
  this.suspendStdin()
  this.editorHandoverDepth += 1;
  termWrite(
    this.options.stdout,
    enterEditorBytes({ altActive: this.altScreenActive, mouseTracking: this.mouseTracking }),
  )
}

type ExitAlternateScreenReads = Pick<
  Ink,
  | 'options' | 'ledger' | 'editorHandoverDepth' | 'altScreenActive' | 'mouseTracking' | 'wholeFrameDue' | 'resetFramesForAltScreen'
  | 'repaintMainScreen' | 'reassertScreenState' | 'resume' | 'resumeStdin'
>

export function exitAlternateScreen(this: ExitAlternateScreenReads): void {
  if (this.editorHandoverDepth === 0) {
    this.reassertScreenState('unmatched-exit-collapsed');
    return;
  }
  this.editorHandoverDepth -= 1;
  termWrite(
    this.options.stdout,
    exitEditorBytes({ altActive: this.altScreenActive, mouseTracking: this.mouseTracking }),
  )
  this.resumeStdin()
  if (this.altScreenActive) {
    this.resetFramesForAltScreen();
    this.wholeFrameDue = true;
  } else {
    this.repaintMainScreen()
    this.ledger.contaminate('blank-reset')
  }
  this.resume()
  termWrite(this.options.stdout, exitEditorRearmBytes(extendedKeysSupportedNow()))
}

type ReassertScreenStateReads = Pick<
  Ink,
  | 'options' | 'ledger' | 'isUnmounted' | 'altScreenActive' | 'wholeFrameDue' | 'screenReassertCount' | 'resetFramesForAltScreen' | 'repaint'
>

export function reassertScreenState(this: ReassertScreenStateReads, reason: string, opts: { repaint?: boolean }): void {
  if (this.isUnmounted) return
  this.screenReassertCount += 1
  logForDebugging(
    `Screen-state re-assert (${reason}): belief=${this.altScreenActive ? 'alt-screen' : 'main-screen'}`,
  )
  if (this.altScreenActive) {
    termWrite(this.options.stdout, ENTER_ALT_SCREEN);
    this.resetFramesForAltScreen();
    this.wholeFrameDue = true;
  }
  this.ledger.contaminate('self-heal');
  if (opts.repaint !== false) this.repaint();
}

export function armScreenWatchdog(this: Pick<Ink, 'watchdogCommitsRemaining' | 'zeroByteRenderStreak'>): void {
  this.watchdogCommitsRemaining = WATCHDOG_COMMIT_BUDGET
  this.zeroByteRenderStreak = 0
}

export function reenterAltScreen(this: Pick<Ink, 'options' | 'mouseTracking' | 'resetFramesForAltScreen'>): void {
  termWrite(this.options.stdout, reenterAltBytes(this.mouseTracking))
  this.resetFramesForAltScreen()
}

type ReassertTerminalModesReads = Pick<
  Ink,
  | 'options' | 'isTTY' | 'isUnmounted' | 'isPaused' | 'altScreenActive' | 'mouseTracking' | 'wholeFrameDue' | 'resetFramesForAltScreen'
  | 'scheduleRender'
>

export function reassertTerminalModes(this: ReassertTerminalModesReads, includeAltScreen: boolean): void {
  if (!this.isTTY) return
  if (this.isPaused || this.isUnmounted) return
  if (!streamTakesWrites(this.options.stdout)) return
  termWrite(
    this.options.stdout,
    reassertModesBytes({
      extendedKeys: extendedKeysSupportedNow(),
      altActive: this.altScreenActive,
      mouseTracking: this.mouseTracking,
    }),
  )
  if (includeAltScreen && this.altScreenActive) {
    termWrite(this.options.stdout, wakeReenterAltBytes(this.mouseTracking))
    this.resetFramesForAltScreen()
    this.wholeFrameDue = true
    this.scheduleRender()
  }
}

export function repaintAfterNestedAltScreenClose(this: Pick<Ink, 'altScreenActive' | 'wholeFrameDue' | 'resetFramesForAltScreen' | 'scheduleRender'>): void {
  if (!this.altScreenActive) return
  this.resetFramesForAltScreen()
  this.wholeFrameDue = true
  this.scheduleRender()
}

export function armAltScreenTakeover(this: Pick<Ink, 'ledger' | 'wholeFrameDue'>): void {
  this.wholeFrameDue = true;
  this.ledger.contaminate('takeover')
}

export function armAltScreenEntry(this: Pick<Ink, 'pendingAltEntry' | 'ledger'>, bytes: string): void {
  this.pendingAltEntry = bytes
  this.ledger.contaminate('takeover')
}

type ForceRedrawReads = Pick<
  Ink,
  | 'options' | 'isTTY' | 'ledger' | 'isUnmounted' | 'isPaused' | 'altScreenActive' | 'wholeFrameDue' | 'resetFramesForAltScreen' | 'repaintMainScreen'
  | 'onRender'
>

export function forceRedraw(this: ForceRedrawReads): void {
  if (!this.isTTY || this.isUnmounted || this.isPaused) return
  if (this.altScreenActive) {
    this.resetFramesForAltScreen()
    this.wholeFrameDue = true
  } else {
    termWrite(this.options.stdout, ERASE_SCREEN + CURSOR_HOME)
    this.repaintMainScreen()
  }
  this.ledger.contaminate('force-redraw')
  this.onRender()
}

type RepaintAltScreenReads = Pick<
  Ink,
  | 'isTTY' | 'isUnmounted' | 'isPaused' | 'altScreenActive' | 'wholeFrameDue' | 'resetFramesForAltScreen' | 'onRender' | 'forceRedraw'
>

export function repaintAltScreen(this: RepaintAltScreenReads): void {
  if (!this.isTTY || this.isUnmounted || this.isPaused) return
  if (!this.altScreenActive) {
    this.forceRedraw()
    return
  }
  this.resetFramesForAltScreen()
  this.wholeFrameDue = true
  this.onRender()
}

type OverwriteScreenReads = Pick<
  Ink,
  | 'isUnmounted' | 'altScreenActive' | 'wholeFrameDue' | 'wholeFrameAt' | 'overwriteTimer' | 'scheduleRender' | 'overwriteScreen'
>

export function overwriteScreen(this: OverwriteScreenReads): void {
  if (!this.altScreenActive || this.isUnmounted || this.overwriteTimer !== null) return
  const wait = OVERWRITE_MIN_GAP_MS - (performance.now() - this.wholeFrameAt)
  if (wait > 0) {
    this.overwriteTimer = setTimeout(() => {
      this.overwriteTimer = null
      this.overwriteScreen()
    }, wait)
    this.overwriteTimer.unref?.()
    return
  }
  this.wholeFrameDue = true
  this.scheduleRender()
}

export function repaint(this: Pick<Ink, 'ledger' | 'altScreenActive' | 'resetFramesForAltScreen' | 'repaintMainScreen' | 'onRender'>): void {
  if (this.altScreenActive) {
    this.resetFramesForAltScreen()
  } else {
    this.repaintMainScreen()
    this.ledger.contaminate('blank-reset')
  }
  this.onRender()
}

export function pause(this: Pick<Ink, 'isPaused' | 'onRender' | 'drainUnsettledQueries'>): void {
  this.drainUnsettledQueries()
  reconciler.flushSyncWork()
  this.onRender()
  this.isPaused = true
}

export function resume(this: Pick<Ink, 'isPaused' | 'onRender'>): void {
  this.isPaused = false
  this.onRender()
}
