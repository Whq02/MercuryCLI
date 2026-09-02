import React, { type PropsWithChildren, useContext, useInsertionEffect, useLayoutEffect, useRef, useState } from 'react';
import { InkInstanceContext } from './InkInstanceContext.js';
import { consumeLauncherAltHold } from '../launcherAltHold.js';
import { DISABLE_ALTERNATE_SCROLL, DISABLE_MOUSE_TRACKING, ENABLE_ALTERNATE_SCROLL, ENABLE_MOUSE_TRACKING, ENTER_ALT_SCREEN, EXIT_ALT_SCREEN } from '../termio/dec.js';
import { noteModeAcquired, noteModeReleased } from '../root/terminalModeLedger.js';
import { TerminalWriteContext } from '../useTerminalNotification.js';
import { RESET_SCROLL_REGION } from '../termio/csi.js';
import { VIEWPORT_FLOOR_COLS, viewportFloorVerdict, type ViewportFloorVerdict } from '../viewportFloor.js';
import Box from './Box.js';
import Text from './Text.js';
import { TerminalSizeContext, type TerminalSize } from './TerminalSizeContext.js';
type Props = PropsWithChildren<{
  /** Request SGR mouse reporting (wheel + click/drag) while mounted. On unless set false. */
  mouseTracking?: boolean;
}>;

/**
 * Hosts its children inside the terminal's alternate screen buffer, sized
 * to the visible viewport. For as long as it stays mounted it:
 *
 * - switches to the alt screen (DEC private mode 1049), wipes it, and puts
 *   the cursor at home
 * - caps its own height at the terminal's row count — the alt screen has no
 *   native scrollback, so taller content must scroll itself via flexbox
 *   `overflow: scroll`
 * - can turn on SGR mouse reporting, with wheel input arriving as
 *   `ParsedKey` events and click/drag feeding the Ink instance's selection
 *   state
 *
 * Unmounting switches mouse reporting back off and leaves the alt screen,
 * so the primary buffer reappears untouched — which is what makes the
 * component safe for transient fullscreen surfaces like the ctrl+o
 * transcript overlay.
 *
 * The Ink instance hears about the mode through `setAltScreenActive()`:
 * the renderer then pins the cursor inside the viewport (a cursor-restore
 * LF below the last row would scroll the buffer), and signal-exit cleanup
 * knows to leave the alt screen even on paths where this component's own
 * unmount never runs.
 *
 * Hand-written (no React-Compiler `_c` memo cache)
 * so Mercury can honor the operator's `/mouse off` toggle: the effective
 * mouse-tracking state is the component's request AND the Ink instance's
 * global bookkeeping (`isMouseTrackingEnabled()` — the `/mouse` seam).
 * Without the AND, any AlternateScreen view (/monitor, /helm, ctrl+o)
 * silently re-enabled SGR tracking after `/mouse off` and left the
 * bookkeeping stale at 'off', so `/mouse` then LIED about the state while
 * native select/copy stayed broken (audit finding C3). The pref is read
 * once per mount — toggling `/mouse` mid-view applies its own escapes
 * live, so the two writers stay consistent either way.
 */
// REENTRANCY DEPTH (fable scroll investigation — THE primary
// viewport-lock break): the fullscreen REPL wraps the whole session in a root
// <AlternateScreen>, and NavigablePanes + the detail panes (/workflows
// board drill-downs, the ctrl+o overlay lineage) each mount their OWN nested
// instance. Every instance would otherwise write the FULL teardown on unmount —
// DISABLE_ALTERNATE_SCROLL + DISABLE_MOUSE_TRACKING + EXIT_ALT_SCREEN — so one
// esc on a pane dropped the ENTIRE session to the main screen, disarmed, with
// scrollback bleeding above the live cockpit (the operator's "lock is not
// persistent"), and zeroed ink's altScreenActive/altScreenMouseTracking so
// every later re-assert belt early-returned. The alt screen is a PROCESS-level
// terminal state, so its lifecycle is owned at process level: only the 0→1
// mount enters/arms, only the 1→0 unmount exits/disarms; nested mounts just
// clear+home within the already-armed screen and nested unmounts hand the
// (still-armed) screen back with a clear — the outer view repaints its full
// frame on the next render. The depth is PER INSTANCE (a WeakMap keyed by
// the tree's own Ink instance — the old module-global depth cross-talked
// between instances in one process; contract rigs hit it constantly).
const altScreenDepths = new WeakMap<object, { n: number }>()
// Trees rendered without a provider (bare unit mounts) share one fallback key.
const NO_INSTANCE_KEY = {}

export function AlternateScreen({
  children,
  mouseTracking = true,
}: Props): React.ReactNode {
  const size = useContext(TerminalSizeContext);
  const writeRaw = useContext(TerminalWriteContext);
  const inkFromContext = useContext(InkInstanceContext);

  // LIFETIME ≠ ARMING (continuity pass): the alt-screen lifetime
  // effect must never re-run because the mouse preference changed — the REPL
  // root passes the LIVE isMouseTrackingEnabled() as this prop, so having it
  // in the effect deps made every /mouse toggle tear the WHOLE buffer down
  // (depth 1→0: EXIT_ALT_SCREEN) and re-enter it — a full-screen flash for a
  // pure input-mode change whose escapes the /mouse live setter already owns.
  // The prop is read through a ref at mount time only (the documented "pref
  // is read once per mount" contract — the deps would otherwise contradict it).
  const mouseTrackingRef = useRef(mouseTracking);
  mouseTrackingRef.current = mouseTracking;
  // Whether THIS instance is the outermost mount — decided once, when the
  // lifecycle effect claims the depth. The depth record alone cannot say so
  // on a later render: the outermost instance's own claim leaves it at 1.
  const outermostRef = useRef<boolean | null>(null);

  // useInsertionEffect (not useLayoutEffect): react-reconciler calls
  // resetAfterCommit between the mutation and layout commit phases, and
  // Ink's resetAfterCommit triggers onRender. With useLayoutEffect, that
  // first onRender fires BEFORE this effect — writing a full frame to the
  // main screen with altScreen=false. That frame is preserved when we
  // enter alt screen and revealed on exit as a broken view. Insertion
  // effects fire during the mutation phase, before resetAfterCommit, so
  // ENTER_ALT_SCREEN reaches the terminal before the first frame does.
  useInsertionEffect(() => {
    const ink = inkFromContext;
    if (!writeRaw) return;
    const depth = altScreenDepths.get(ink ?? NO_INSTANCE_KEY) ?? { n: 0 };
    altScreenDepths.set(ink ?? NO_INSTANCE_KEY, depth);

    // The operator's /mouse toggle gates the component-level request
    // (mount-time read; mid-life /mouse flips write their own escapes).
    // The operator's /mouse PREFERENCE gates the mount (not the live state:
    // an alt-screen exit drops live tracking, and reading that drop here made
    // the next mount — the fresh-boot walk→REPL handoff — mouseless for the
    // whole session; /mouse off stays honored because only the /mouse seam
    // writes the preference).
    const effectiveMouse = mouseTrackingRef.current && (ink?.isMouseTrackingPreferred?.() ?? true);

    const outermost = depth.n === 0
    outermostRef.current = outermost
    depth.n++
    if (outermost) {
      // LAUNCHER HOLD TAKEOVER (the boot black-beat fix): when
      // the splash already holds the alternate buffer (its "taking the
      // deck…" frame + MERCURY_ALT_HELD marker), do NOT re-enter (?1049h is a
      // buffer clear on iTerm2) and do NOT 2J — either wipes the hold long
      // before React's first frame exists. Arm only (margins, mouse,
      // alternate-scroll) and let ink's takeover seam prepend the erase
      // ATOMICALLY inside the first frame's write: hold text → full first
      // frame, one paint, no black beat.
      const launcherHolds = consumeLauncherAltHold();
      // Defensive DECSTBM reset: CSI ?1049h does NOT clear scroll margins,
      // so a region left by a prior pty occupant (crashed vim/less) makes
      // relative moves clamp — the permanent stale-rows class (recon).
      // Alternate-scroll rides the WHOLE alt-screen life (not the mouse
      // toggle): inert under SGR tracking, it takes over when /mouse off
      // drops tracking — the wheel becomes ↑/↓ for the app instead of the
      // emulator sliding its window over the cockpit (the "not locked"
      // class,).
      const armBytes =
        (effectiveMouse ? ENABLE_MOUSE_TRACKING : '') + ENABLE_ALTERNATE_SCROLL;
      if (launcherHolds) {
        // The splash already holds the buffer: never re-enter (?1049h is a
        // buffer clear on iTerm2) and never 2J — arm only; ink's takeover
        // seam folds the erase into the first frame's write.
        writeRaw(RESET_SCROLL_REGION + '\x1b[0m' + armBytes);
      } else if (ink?.armAltScreenEntry) {
        // No hold: DEFER the whole entry (switch + wipe + arming) into the
        // first non-empty composed frame's atomic write — the surface below
        // (the trust dialog, any main-screen face) stays visible until the
        // alt face exists: one paint, no black beat, no torn intermediate
        // (the onboarding blank-and-torn class).
        ink.armAltScreenEntry(ENTER_ALT_SCREEN + RESET_SCROLL_REGION + '\x1b[2J\x1b[H' + armBytes);
      } else {
        // Bare unit mounts (no instance): the immediate write.
        writeRaw(ENTER_ALT_SCREEN + RESET_SCROLL_REGION + '\x1b[2J\x1b[H' + armBytes);
      }
      // (the partition): the outermost session notes its
      // debts. A launcher takeover is an ownership TRANSFER — consume above
      // released the 'launcher-splash' import, this session now owes the
      // exit (same bytes either way). Nested mounts note nothing: the
      // process-level obligation is already open.
      noteModeAcquired('alt-screen-session', 'alt-screen');
      noteModeAcquired('alt-screen-session', 'alternate-scroll');
      if (effectiveMouse) noteModeAcquired('alt-screen-session', 'mouse-tracking');
      ink?.setAltScreenActive(true, effectiveMouse);
      if (launcherHolds) ink?.armAltScreenTakeover();
    } else {
      // Nested: the screen is already entered + armed by the outermost
      // instance — take the surface WITHOUT a standalone eager 2J (the old
      // clear blanked the terminal for the whole gap until the pane's first
      // frame). Never re-write ENTER_ALT_SCREEN (iTerm2 treats a repeat
      // ?1049h as a buffer clear — the blank-flicker class) and never touch
      // the arm state. The deferred seam below resets the frame model AND
      // folds ERASE_SCREEN inside the pane's first composed frame's atomic
      // BSU/ESU write — outer view → pane in ONE paint.
      writeRaw(RESET_SCROLL_REGION);
      ink?.repaintAfterNestedAltScreenClose?.();
    }

    return () => {
      depth.n = Math.max(0, depth.n - 1)
      if (depth.n === 0) {
        ink?.setAltScreenActive(false);
        ink?.clearTextSelection();
        // DISABLE_MOUSE_TRACKING unconditionally: /mouse may have ARMED
        // tracking after this mount captured effectiveMouse=false, and
        // disabling un-armed tracking is a harmless reset — never leave the
        // emulator tracking after the buffer exits.
        writeRaw(DISABLE_ALTERNATE_SCROLL + DISABLE_MOUSE_TRACKING + EXIT_ALT_SCREEN);
        // The trio settles with the bytes just written (mouse included even
        // when the /mouse toggle armed it after mount — same unconditional
        // polarity as the write above).
        noteModeReleased('alt-screen-session', 'alt-screen');
        noteModeReleased('alt-screen-session', 'alternate-scroll');
        noteModeReleased('alt-screen-session', 'mouse-tracking');
      } else {
        // Nested close: the session stays in the (still-armed) alt screen.
        // NO standalone 2J — the pane's pixels stay visible until the outer
        // view's next composed frame swaps in with the erase folded inside
        // its atomic write (the same deferred seam as the open path).
        // Selection state from the pane is dropped either way.
        ink?.clearTextSelection();
        ink?.repaintAfterNestedAltScreenClose?.();
      }
    };
    // mouseTracking is DELIBERATELY absent (read via ref above): the alt
    // screen's lifetime must not cycle on an input-mode preference.
  }, [writeRaw, inkFromContext]);

  // NESTED instances cap, never force: a drill-in pane hosted inside a
  // bottom-anchored slot would otherwise render height={rows} regardless of the
  // slot, pushing its own tail past the layout and deadening the viewport's
  // bottom band (the seat-inspector dead-tail class — SeatInspectorPane,
  // DispatchDetailPane, HistoryDetailPane, AgentInspectorPane,
  // RunDetailPane all mount nested instances). The OUTERMOST instance keeps
  // the hard height — the root surface must fill the screen. Depth is read
  // at render from the same per-instance record the lifecycle effect keys;
  // the outer instance's effect has always run by the time a drill-in pane
  // renders (panes mount on later commits). Once the effect has claimed the
  // depth the ref is the fact — the record alone reads the outermost
  // instance's own claim as nesting.
  const nested = outermostRef.current !== null
    ? !outermostRef.current
    : (altScreenDepths.get(inkFromContext ?? NO_INSTANCE_KEY)?.n ?? 0) > 0;
  const rows = size?.rows ?? 24;

  // THE VIEWPORT FLOOR (the outermost instance only — a nested pane lives
  // inside a surface that already fits): under the minimum width the host
  // paints ONE line naming the minimum and the way back, and nothing else.
  // The surface beneath stays MOUNTED but out of layout (display none — the
  // layout engine zeroes the subtree, so no measurement effect ever reads a
  // too-small geometry), with its size context FROZEN at the last size that
  // fit: on the way back to that size nothing about it changed — no rescale
  // of the transcript's height cache, no remount — and the settled repaint
  // shows every scroll position and draft where it was. The latch is
  // committed state (the pure verdict reads it), so the exit band settles
  // exactly like the cockpit's chrome latch and a render is never impure.
  const [surfaceUp, setSurfaceUp] = useState(false);
  const verdict: ViewportFloorVerdict =
    nested || size === null ? { fits: true } : viewportFloorVerdict(size.columns, size.rows, surfaceUp);
  useLayoutEffect(() => {
    if (surfaceUp !== verdict.fits) setSurfaceUp(verdict.fits);
  }, [surfaceUp, verdict.fits]);
  const lastFitRef = useRef<TerminalSize | null>(null);
  if (verdict.fits && size !== null) lastFitRef.current = size;
  const surfaceSize: TerminalSize | null = verdict.fits
    ? size
    : lastFitRef.current ?? (size === null ? null : { columns: VIEWPORT_FLOOR_COLS, rows: size.rows });

  return (
    <>
      {verdict.fits ? null : (
        <Box flexDirection="column" height={rows} width="100%" flexShrink={0} justifyContent="center" paddingX={1}>
          <Text color="ansi:yellow" bold>
            {verdict.line}
          </Text>
        </Box>
      )}
      <Box
        flexDirection="column"
        {...(nested ? { maxHeight: rows } : { height: rows })}
        width="100%"
        flexShrink={0}
        {...(verdict.fits ? {} : { display: 'none' as const })}
      >
        <TerminalSizeContext.Provider value={surfaceSize}>{children}</TerminalSizeContext.Provider>
      </Box>
    </>
  );
}
