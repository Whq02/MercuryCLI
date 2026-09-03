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

export function SurfaceFaultInjection({ kind }: { kind: string }): React.ReactNode {
  if (flagEnv('MERCURY_FAULT_INJECT_SURFACE') === kind) {
    throw new Error(`fault injection: surface '${kind}' (MERCURY_FAULT_INJECT_SURFACE)`)
  }
  return null
}

function SurfaceCrashCard({ kind }: { kind: string }): React.ReactElement {
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
  const liveSizeCtx = useContext(LiveTerminalSizeContext);
  const baseSizeCtx = useContext(TerminalSizeContext);
  const liveSize = liveSizeCtx ?? baseSizeCtx;
  const surface = useViewportFloor(liveSize, true);
  return (
    <>
      {
}
      <MotionParkContext.Provider value={entry !== undefined}>
        <TerminalSizeContext.Provider value={surface.surfaceSize}>{children}</TerminalSizeContext.Provider>
      </MotionParkContext.Provider>
      {entry ? (
        <RouteSurfaceHost key={surfaceRouteId(route)} kind={route.kind} frame={entry.frame}>
          {
}
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

function SurfaceOverlayClaim({ kind }: { kind: string }): React.ReactNode {
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
  const model = useMainLoopModel();
  const t = useMercuryTokens();
  const ground = estateGroundBg(t);
  const [exitChordArmed, setExitChordArmed] = useState(false);
  const hostLiveSize = useContext(LiveTerminalSizeContext);
  const hostBaseSize = useContext(TerminalSizeContext);
  const floor = useViewportFloor(hostLiveSize ?? hostBaseSize, true);
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

registerRouteSurface('boot-settings', {
  render: () => <BootSplashScreen />,
});
import './concourse/ConcourseRoute.js';
registerChatPresence({
  present: () => hasFocusedSession() || landingInFlight(),
  subscribe: subscribeFocusedSessionConnector,
});
