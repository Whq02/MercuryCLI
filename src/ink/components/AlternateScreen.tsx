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
  mouseTracking?: boolean;
}>;

const altScreenDepths = new WeakMap<object, { n: number }>()
const NO_INSTANCE_KEY = {}

export function AlternateScreen({
  children,
  mouseTracking = true,
}: Props): React.ReactNode {
  const size = useContext(TerminalSizeContext);
  const writeRaw = useContext(TerminalWriteContext);
  const inkFromContext = useContext(InkInstanceContext);

  const mouseTrackingRef = useRef(mouseTracking);
  mouseTrackingRef.current = mouseTracking;
  const outermostRef = useRef<boolean | null>(null);

  useInsertionEffect(() => {
    const ink = inkFromContext;
    if (!writeRaw) return;
    const depth = altScreenDepths.get(ink ?? NO_INSTANCE_KEY) ?? { n: 0 };
    altScreenDepths.set(ink ?? NO_INSTANCE_KEY, depth);

    const effectiveMouse = mouseTrackingRef.current && (ink?.isMouseTrackingPreferred?.() ?? true);

    const outermost = depth.n === 0
    outermostRef.current = outermost
    depth.n++
    if (outermost) {
      const launcherHolds = consumeLauncherAltHold();
      const armBytes =
        (effectiveMouse ? ENABLE_MOUSE_TRACKING : '') + ENABLE_ALTERNATE_SCROLL;
      if (launcherHolds) {
        writeRaw(RESET_SCROLL_REGION + '\x1b[0m' + armBytes);
      } else if (ink?.armAltScreenEntry) {
        ink.armAltScreenEntry(ENTER_ALT_SCREEN + RESET_SCROLL_REGION + '\x1b[2J\x1b[H' + armBytes);
      } else {
        writeRaw(ENTER_ALT_SCREEN + RESET_SCROLL_REGION + '\x1b[2J\x1b[H' + armBytes);
      }
      noteModeAcquired('alt-screen-session', 'alt-screen');
      noteModeAcquired('alt-screen-session', 'alternate-scroll');
      if (effectiveMouse) noteModeAcquired('alt-screen-session', 'mouse-tracking');
      ink?.setAltScreenActive(true, effectiveMouse);
      if (launcherHolds) ink?.armAltScreenTakeover();
    } else {
      writeRaw(RESET_SCROLL_REGION);
      ink?.repaintAfterNestedAltScreenClose?.();
    }

    return () => {
      depth.n = Math.max(0, depth.n - 1)
      if (depth.n === 0) {
        ink?.setAltScreenActive(false);
        ink?.clearTextSelection();
        writeRaw(DISABLE_ALTERNATE_SCROLL + DISABLE_MOUSE_TRACKING + EXIT_ALT_SCREEN);
        noteModeReleased('alt-screen-session', 'alt-screen');
        noteModeReleased('alt-screen-session', 'alternate-scroll');
        noteModeReleased('alt-screen-session', 'mouse-tracking');
      } else {
        ink?.clearTextSelection();
        ink?.repaintAfterNestedAltScreenClose?.();
      }
    };
  }, [writeRaw, inkFromContext]);

  const nested = outermostRef.current !== null
    ? !outermostRef.current
    : (altScreenDepths.get(inkFromContext ?? NO_INSTANCE_KEY)?.n ?? 0) > 0;
  const rows = size?.rows ?? 24;

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
