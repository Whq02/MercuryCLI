import React, { useContext, useState, useSyncExternalStore } from 'react';
import { Box, MotionParkContext, Text } from '../ink.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import {
  currentSurfaceRoute,
  getRouteSurface,
  registerChatPresence,
  registerRouteSurface,
  stripKeyMapHint,
  subscribeSurfaceRoute,
  surfaceRouteId,
  surfaceRouteVersion,
} from '../context/surfaceRoute.js';
import { flagEnv } from '../substrate/flagRegistry.js';
import { logError } from '../utils/log.js';
import { crashReportDirDisplay, persistCrashReport } from '../utils/crashReport.js';
import { FAINT } from './mercuryPalette.js';
import { GLYPH } from './mercury-ui/glyphs.js';
import { exitChordNoticeText } from './PromptInput/ExitChordNotice.js';
import {
  hasFocusedSession,
  landingInFlight,
  subscribeFocusedSessionConnector,
} from '../services/engine-connector/focusedConnector.js';
import { useElevatedSurface } from './mercury-ui/useElevatedSurface.js';
import { useRegisterOverlay } from '../context/overlayContext.js';
import { RouteSurfaceScopeContext } from '../keybindings/RouteSurfaceScope.js';
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js';
import { useMainLoopModel } from '../hooks/useMainLoopModel.js';
import { estateGroundBg } from '../utils/mercuryTokens.js';
import { LiveTerminalSizeContext, TerminalSizeContext } from '../ink/components/TerminalSizeContext.js';
import { useViewportFloor } from '../ink/hooks/use-viewport-floor.js';
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js';
import { BootSplashScreen } from './BootSplashScreen.js';
import { MercuryFrame } from './MercuryFrame.js';
import { SurfaceExitChord, SurfaceExitChordNotice } from './SurfaceExitChord.js';

/**
 * SurfaceRouter — the render face of the one in-process
 * route owner (src/context/surfaceRoute.ts; handoff).
 *
 * The children (the root REPL tree) stay MOUNTED for the whole process
 * lifetime — a route away from 'repl' paints the registered surface in an
 * absolute, opaque, full-viewport host ABOVE it (the FullscreenLayout
 * modal-claim precedent: the subtree beneath keeps its state, scroll,
 * drafts, workers and raw-mode/alt-screen ownership; presentation transfer
 * is the only change, so a route swap is byte-silent on terminal modes —
 * byte-silent). Input parks the same way every command surface parks the
 * REPL: the HOST registers the MODAL overlay for the active surface's
 * lifetime (see RouteSurfaceHost), which stands down PromptInput, command
 * keybindings and cancel handling beneath it; surfaces stack their own
 * finer-grained overlays (pickers, lists) on top.
 *
 * The host registers with the elevated-surface oracle for exactly the
 * active surface's lifetime (alternate-scroll policy + the
 * oracle row ride this registration).
 */
/** The surface's own containment (prove-surface-boundary): the root REPL
 *  tree beneath stays mounted for the whole process lifetime — the recovery
 *  road was always there — so a render throw inside a route surface (the
 *  board's live-data walks, the Boot face) must cost THE SCREEN, never the
 *  process. Before this boundary, one throw here reached the app-root
 *  killer and ended every mounted chat. The catch persists a
 *  'surface'-origin crash report; the fallback owns the host viewport with
 *  an honest card whose moves are only the ones that truly fire — the
 *  present-moves strip resolver and the exit chord's one notice. */
class SurfaceErrorBoundary extends React.Component<
  { kind: string; children: React.ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, errorInfo: React.ErrorInfo): void {
    logError(error);
    persistCrashReport(error, errorInfo, 'surface');
  }

  override render(): React.ReactNode {
    if (this.state.failed) return <SurfaceCrashCard kind={this.props.kind} />;
    return this.props.children;
  }
}

/** The A5 fault-injection arm (drive-only): MERCURY_FAULT_INJECT_SURFACE
 *  names a route kind whose entry THROWS here — the boundary's FIRST child,
 *  inside it — so the crash card is CAPTURABLE by a driven run (the gate
 *  wants the card seen, not assumed; a real surface throw is not
 *  scriptable). Unset is byte-identical: this renders nothing. */
export function SurfaceFaultInjection({ kind }: { kind: string }): React.ReactNode {
  if (flagEnv('MERCURY_FAULT_INJECT_SURFACE') === kind) {
    throw new Error(`fault injection: surface '${kind}' (MERCURY_FAULT_INJECT_SURFACE)`)
  }
  return null
}

function SurfaceCrashCard({ kind }: { kind: string }): React.ReactElement {
  // The present moves for THIS stop — empty when nothing moves; the exit
  // chord's sentence is always true (SurfaceExitChord mounts in the host,
  // above this card, and survives the surface's crash).
  const moves = [stripKeyMapHint(), exitChordNoticeText(null)].filter(s => s !== '').join(' · ');
  return (
    <Box flexDirection="column" flexGrow={1} alignItems="center" justifyContent="center" gap={1}>
      <Text color={FAINT}>
        {GLYPH.warn} this screen ({kind}) could not be painted — everything beneath it is untouched
      </Text>
      <Text color={FAINT}>crash report: {crashReportDirDisplay()}</Text>
      <Text color={FAINT}>{moves}</Text>
    </Box>
  );
}

export function SurfaceRouter({ children }: { children: React.ReactNode }): React.ReactNode {
  useSyncExternalStore(subscribeSurfaceRoute, surfaceRouteVersion, surfaceRouteVersion);
  const route = currentSurfaceRoute();
  const entry = getRouteSurface(route.kind);
  // THE VIEWPORT FLOOR, at the REPL's own reading: the REPL reads the
  // terminal size ABOVE the alternate-screen host it mounts and hands its
  // transcript that width as a prop, so a freeze inside the host alone left
  // the transcript re-laying at the under-floor width (its heights
  // rescaled twice, its resting pin landed a turn away on the way back).
  // The surface size the REPL subtree sees is frozen HERE, from the one
  // latch; the hosts beneath judge the floor on the live size.
  const liveSize = useContext(LiveTerminalSizeContext) ?? useContext(TerminalSizeContext);
  const surface = useViewportFloor(liveSize, true);
  // #43 (family): the surface-cycle chord HANDLERS live in
  // GlobalKeybindingHandlers (useGlobalKeybindings.tsx), NOT here — this
  // component mounts ABOVE KeybindingSetup, where useKeybinding has no
  // context and silently registers nothing (the driven LOOK
  // caught exactly that). The REPL subtree beneath stays mounted while a
  // surface owns the frame, so its Global handlers fire from every surface.
  return (
    <>
      {/* Motion parking at the route seam: a covered root cockpit does no
          animation work — the park provider stays MOUNTED and only its VALUE
          switches (the FullscreenLayout M3 law: mount-switching a provider
          would remount the transcript). The host re-provides false so the
          covering surface's own primitives never park themselves. */}
      <MotionParkContext.Provider value={entry !== undefined}>
        <TerminalSizeContext.Provider value={surface.surfaceSize}>{children}</TerminalSizeContext.Provider>
      </MotionParkContext.Provider>
      {entry ? (
        <RouteSurfaceHost key={surfaceRouteId(route)} kind={route.kind} frame={entry.frame}>
          {/* The keybinding scope (RouteSurfaceScope): bindings mounted
              INSIDE this surface are live while it owns the frame; the
              parked REPL beneath keeps the default 'repl' scope and stays
              inert (the covered-REPL gate in useKeybinding). The surface
              also gets its OWN KeybindingSetup: the REPL's provider mounts
              inside the REPL screen (beneath this router), so without one
              here every useKeybinding in a route surface — a standard
              consent card's Select (↑↓/↵/esc) inline in the coordinator
              pane — had no context and silently registered nothing (the
              driven git-offer capture: ↓ never moved the cursor). Same
              bindings file, its own registry; the parked REPL's registry is
              untouched. */}
          <RouteSurfaceScopeContext.Provider value={route.kind}>
            <KeybindingSetup>
              <SurfaceErrorBoundary kind={route.kind}>
                <SurfaceFaultInjection kind={route.kind} />
                <MotionParkContext.Provider value={false}>{entry.render(route)}</MotionParkContext.Provider>
              </SurfaceErrorBoundary>
            </KeybindingSetup>
          </RouteSurfaceScopeContext.Provider>
        </RouteSurfaceHost>
      ) : null}
    </>
  );
}

// The input-parking half of the router's contract, enforced AT THE HOST
// relied on each surface registering its own
// modal overlay, the Concourse never did, and every Chat-context chord — the
// shift+tab mode carousel above all — kept firing into the parked REPL
// beneath the surface. The host claim makes the parking structural for every
// registered surface.
//
// REGISTRATION ORDER IS LOAD-BEARING: overlay
// registration rides layout effects, which flush CHILD-BEFORE-PARENT — a
// claim in RouteSurfaceHost's own body would land ON TOP of the surface's
// own mount-time overlays (Boot Settings' list registered first, the host
// out-ranked it, and the list — which correctly declines Esc when it is not
// the top overlay — went Esc-dead in the booted product). As the host's
// FIRST CHILD this leaf completes before the surface subtree, so the claim
// sits above the parked REPL and BENEATH every overlay the surface itself
// registers (its lists/pickers stack on top, exactly the contract).
function SurfaceOverlayClaim({ kind }: { kind: string }): React.ReactNode {
  // ownsPageKeys (phase-2 surface parity, the CU-11/AR-5 scroll law): route
  // surfaces render REAL paged viewports (the attached transcript + the
  // coordinator conversation ride the ScrollBox pane), so the parked REPL's
  // transcript scroller must YIELD PageUp/PageDown while a surface owns the
  // frame — without this the page keys scrolled the INVISIBLE transcript
  // beneath the opaque host (one key, one owner — MINI-TEMPER item 2).
  useRegisterOverlay(`surface:${kind}`, true, { ownsPageKeys: true });
  return null;
}

function RouteSurfaceHost({
  children,
  kind,
  frame,
}: {
  children: React.ReactNode;
  kind: string;
  frame?: 'inherit';
}): React.ReactNode {
  const { columns, rows } = useTerminalSize();
  const elevatedRef = useElevatedSurface();
  // AR-10: a frame-inheriting surface composes
  // the persistent MercuryFrame band at the host's bottom — the SAME live
  // stores feed it as the (covered) REPL's own mount, so usage/mode/model
  // telemetry never disappears while a worker is being driven. The model
  // rides the same shared hook the REPL uses; presentation-only, so the
  // route seam stays byte-silent on terminal modes.
  const model = useMainLoopModel();
  // THE ESTATE GROUND (C1-HYBRID, operator-ruled): every route surface's
  // host OWNS its viewport — the flat NIGHT canvas (the splash's own VOID,
  // so the canonical Boot face equals the launcher on ANY terminal). The
  // Concourse shell paints its graded field OVER this; the attached worker
  // and the Boot face inherit it as their ground.
  const t = useMercuryTokens();
  const ground = estateGroundBg(t);
  // THE ONE EXIT LAW (ledger L22): the exit chord's listener mounts here,
  // AHEAD of the surface subtree — registration order is the emitter's
  // dispatch order, so it counts every ctrl+c before a screen or a card can
  // consume it — and its notice paints LAST (later siblings paint on top):
  // one row at the bottom-left of this viewport, the REPL's own words. The
  // chat route mounts no host, so the REPL composer's chord stays the only
  // one there.
  const [exitChordArmed, setExitChordArmed] = useState(false);
  // THE VIEWPORT FLOOR: this host paints OVER the alternate screen's own
  // host (the REPL beneath owns the buffer), so under the minimum it yields
  // the frame — the surface stays mounted, out of layout, frozen at the
  // last size that fit — and the one line the alternate-screen host paints
  // shows through. Both hosts read the floor's one latch, so they agree on
  // every column of a drag. The display is named in both states: a style
  // key left absent is never re-applied. The context's own size object is
  // what the hook freezes and re-provides, so consumers keep its identity
  // while the window fits.
  const floor = useViewportFloor(useContext(LiveTerminalSizeContext) ?? useContext(TerminalSizeContext), true);
  return (
    <Box
      ref={elevatedRef}
      position="absolute"
      top={0}
      left={0}
      width={columns}
      height={rows}
      flexDirection="column"
      overflow="hidden"
      opaque={true}
      display={floor.fits ? 'flex' : 'none'}
      {...(ground !== undefined ? { backgroundColor: ground } : {})}
    >
      <TerminalSizeContext.Provider value={floor.surfaceSize}>
        <SurfaceOverlayClaim kind={kind} />
        <SurfaceExitChord onPendingChange={setExitChordArmed} />
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          {children}
        </Box>
        {frame === 'inherit' ? <MercuryFrame model={model} routeSurface /> : null}
        <SurfaceExitChordNotice pending={exitChordArmed} />
      </TerminalSizeContext.Provider>
    </Box>
  );
}

// ── surface registrations ───────────────────────────────────────────────────
// Boot Settings + the Concourse pair (registered from its own
// module; the registry keeps the router's decision logic untouched).
// Operator: the BOOT destination renders the AUTHORED splash
// sibling (BootSplashScreen); the settings projection lives one layer
// inside it ('s'), esc returning to the splash face.
registerRouteSurface('boot-settings', {
  render: () => <BootSplashScreen />,
});
import './concourse/ConcourseRoute.js';
// The strip's chat stop reads the focused slot through this seam (the
// router never imports the slot module — the resolver's Off path carries
// zero supervisor modules); registered here beside the surfaces so every
// boot journey that hosts the router (launchRepl, the --resume picker's
// in-place swap) counts the chat. A landing in flight counts: the chat is
// milliseconds from existing and the strip may already move onto it.
registerChatPresence({
  present: () => hasFocusedSession() || landingInFlight(),
  subscribe: subscribeFocusedSessionConnector,
});
