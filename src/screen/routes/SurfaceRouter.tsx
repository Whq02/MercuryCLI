import React, { useContext, useInsertionEffect, useState, useSyncExternalStore } from 'react';
import { InkInstanceContext } from '../renderer/elements/InkInstanceContext.js';
import { Box, MotionParkContext, Text } from '../themedRenderer.js';
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js';
import {
  currentSurfaceRoute,
  getRouteSurface,
  registerChatPresence,
  registerRouteSurface,
  stripKeyMapHint,
  subscribeSurfaceRoute,
  surfaceRouteId,
  surfaceRouteVersion,
} from './surfaceRoute.js';
import { flagEnv } from '../../platform/substrate/flagRegistry.js';
import { logError } from '../../platform/logs/errorLog.js';
import { crashReportDirDisplay, persistCrashReport } from '../../platform/logs/crashReport.js';
import { FAINT } from '../theme/mercuryPalette.js';
import { GLYPH } from '../theme/glyphs.js';
import { EXIT_CHORD_HINT } from '../composer/ExitChordNotice.js';
import {
  hasFocusedSession,
  landingInFlight,
  subscribeFocusedSessionConnector,
} from '../../engine/connector/focusedConnector.js';
import { useElevatedSurface } from '../widgets/useElevatedSurface.js';
import { useRegisterOverlay } from '../overlays/overlayHooks.js';
import { RouteSurfaceScopeContext } from '../keys/RouteSurfaceScope.js';
import { KeybindingSetup } from '../keys/KeybindingProviderSetup.js';
import { useEngineModel } from '../model-picker/useEngineModel.js';
import { estateGroundBg } from '../theme/mercuryTokens.js';
import { LiveTerminalSizeContext, TerminalSizeContext } from '../renderer/elements/TerminalSizeContext.js';
import { useMercuryTokens } from '../widgets/useMercuryTokens.js';
import { BootSplashScreen } from '../boot-face/BootSplashScreen.js';
import { MercuryFrame } from '../frame-chips/MercuryFrame.js';
import { SurfaceExitChord, SurfaceExitChordNotice } from './SurfaceExitChord.js';
import { registerConcourseRoute } from '../concourse/ConcourseRoute.js';

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
  const moves = [stripKeyMapHint(), EXIT_CHORD_HINT].filter(s => s !== '').join(' · ');
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
  const routeId = surfaceRouteId(route);
  const ink = useContext(InkInstanceContext);
  useInsertionEffect(() => {
    ink?.repaintAfterNestedAltScreenClose();
  }, [ink, routeId]);
  const entry = getRouteSurface(route.kind);
  const liveSizeCtx = useContext(LiveTerminalSizeContext);
  const baseSizeCtx = useContext(TerminalSizeContext);
  const liveSize = liveSizeCtx ?? baseSizeCtx;
  return (
    <>
      {}
      <MotionParkContext.Provider value={entry !== undefined}>
        <TerminalSizeContext.Provider value={liveSize}>{children}</TerminalSizeContext.Provider>
      </MotionParkContext.Provider>
      {entry ? (
        <RouteSurfaceHost key={surfaceRouteId(route)} kind={route.kind} frame={entry.frame}>
          {}
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
  const model = useEngineModel();
  const t = useMercuryTokens();
  const ground = estateGroundBg(t);
  const [exitChordArmed, setExitChordArmed] = useState(false);
  const hostLiveSize = useContext(LiveTerminalSizeContext);
  const hostBaseSize = useContext(TerminalSizeContext);
  const hostSize = hostLiveSize ?? hostBaseSize;
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
      {...(ground !== undefined ? { backgroundColor: ground } : {})}
    >
      <TerminalSizeContext.Provider value={hostSize}>
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

registerConcourseRoute();
registerRouteSurface('boot-settings', {
  render: () => <BootSplashScreen />,
});
registerChatPresence({
  present: () => hasFocusedSession() || landingInFlight(),
  subscribe: subscribeFocusedSessionConnector,
});
