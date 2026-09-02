import React, { useSyncExternalStore } from 'react';
import { Box, Text, useTheme } from '../../ink.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { chatPresent, subscribeSurfaceRoute, surfaceRouteVersion } from '../../context/surfaceRoute.js';
import { critterDefForKey, squareDockArtFor } from '../../utils/cockpit/critterData.js';
import { resolveMercuryTokens } from '../../utils/mercuryTokens.js';
import { CritterArt } from '../mercury-ui/CritterArt.js';
import { rampSegments } from '../mercury-ui/focalRamp.js';
import { useGreetingShimmer } from '../mercury-ui/useGreetingShimmer.js';
import { InteractiveRow } from '../mercury-ui/InteractiveRow.js';
import { displayWidth } from '../mercury-ui/glyphs.js';
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js';
import { useSessionAccent } from '../mercury-ui/sessionAccent.js';
import type { ConcourseSnapshotV1 } from './contracts.js';


function useConcourseIdentity(): {
  markKey: string;
  accent: string;
  accentDeep: string;
  tokens: ReturnType<typeof resolveMercuryTokens>;
} {
  const [theme] = useTheme();
  const sa = useSessionAccent();
  return {
    markKey: sa.key,
    accent: sa.accent,
    accentDeep: sa.accentDeep,
    tokens: resolveMercuryTokens(theme, sa.accent),
  };
}

export function ConcourseLockup(): React.ReactNode {
  const t = useMercuryTokens();
  const ramp = useConcourseIdentity().tokens.focalRamp;
  const shimmer = useGreetingShimmer(ramp, displayWidth('MERCURY — SESSION CONCOURSE'));
  if (ramp.length <= 1) {
    return (
      <Text bold color={t.info} wrap="truncate-end">
        MERCURY — SESSION CONCOURSE
      </Text>
    );
  }
  return (
    <Text wrap="truncate-end">
      {rampSegments('MERCURY — SESSION CONCOURSE', ramp, { shimmer }).map((s, i) => (
        <Text key={i} bold color={s.color}>
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

export function Breadcrumb({
  active,
  onBoot,
  onConcourse,
  onMainRepl,
}: {
  active: ConcourseSnapshotV1['breadcrumb']['active']
  onBoot?: () => void
  onConcourse?: () => void
  onMainRepl?: () => void
}): React.ReactNode {
  const t = useMercuryTokens();
  useSyncExternalStore(subscribeSurfaceRoute, surfaceRouteVersion, surfaceRouteVersion);
  const chat = chatPresent();
  const dest = (id: string, label: string, onGo?: () => void): React.ReactNode => (
    <InteractiveRow id={`concourse:crumb:${id}`} directActivate hoverStyle="chrome-ink" {...(onGo ? { onActivate: onGo } : {})} flexShrink={0}>
      {hover => (
        <Text color={hover ? t.info : t.textMuted}>
          {label}
        </Text>
      )}
    </InteractiveRow>
  );
  return (
    <Box flexShrink={0}>
      {active === 'boot' ? (
        <Text bold color={t.info}>BOOT</Text>
      ) : (
        dest('boot', 'BOOT', onBoot)
      )}
      <Text color={t.textMuted}> › </Text>
      {active === 'concourse' ? (
        <Text bold color={t.info}>CONCOURSE</Text>
      ) : onConcourse !== undefined ? (
        dest('concourse', 'CONCOURSE', onConcourse)
      ) : (
        <Text color={t.textMuted}>CONCOURSE</Text>
      )}
      <Text color={t.textMuted}> › </Text>
      {active === 'main-repl' ? (
        <Text bold color={t.info}>FOCUSED CHAT</Text>
      ) : chat ? (
        dest('main-repl', 'FOCUSED CHAT', onMainRepl)
      ) : (
        <Text color={t.textMuted}>FOCUSED CHAT</Text>
      )}
    </Box>
  );
}

export function ConcourseHeader({
  snapshot,
  onBoot,
  onMainRepl,
  columns: paneColumns,
}: {
  snapshot: ConcourseSnapshotV1
  onBoot?: () => void
  onMainRepl?: () => void
  columns?: number
}): React.ReactNode {
  const t = useMercuryTokens();
  const { columns: termColumns } = useTerminalSize();
  const columns = paneColumns ?? termColumns;
  const showBreadcrumb = columns >= 110;
  const showContextLabels = columns >= 92;
  const identity = useConcourseIdentity();
  useSyncExternalStore(subscribeSurfaceRoute, surfaceRouteVersion, surfaceRouteVersion);
  const chat = chatPresent();
  const markDef = React.useMemo(
    () => ({
      ...critterDefForKey(identity.markKey),
      hue: identity.accent,
      hueDeep: identity.accentDeep,
      square: squareDockArtFor(identity.markKey),
    }),
    [identity.markKey, identity.accent, identity.accentDeep],
  );
  const glow = identity.tokens.focalRamp.length > 1 ? identity.tokens.accentSoft : undefined;
  return (
    <Box flexDirection="row" flexShrink={0} overflow="hidden">
      {
}
      <Box flexShrink={0} marginRight={1} flexDirection="column">
        <CritterArt def={markDef} square {...(glow !== undefined ? { glowToward: glow } : {})} />
      </Box>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        <Box height={1} overflow="hidden">
          <Box flexShrink={1} overflow="hidden">
            {
}
            <ConcourseLockup />
          </Box>
          {showBreadcrumb ? (
            <>
              <Box flexGrow={1} />
              <Breadcrumb
                active={snapshot.breadcrumb.active}
                {...(onBoot ? { onBoot } : {})}
                {...(onMainRepl ? { onMainRepl } : {})}
              />
            </>
          ) : (
            <>
              <Box flexGrow={1} />
              {chat ? (
                <InteractiveRow id="concourse:crumb:main-repl" directActivate hoverStyle="chrome-ink" {...(onMainRepl ? { onActivate: onMainRepl } : {})} flexShrink={0}>
                  {hover => <Text color={hover ? t.info : t.textMuted}>FOCUSED CHAT ›</Text>}
                </InteractiveRow>
              ) : (
                <Text color={t.textMuted}>FOCUSED CHAT ›</Text>
              )}
            </>
          )}
          <Box flexGrow={1} />
          {showContextLabels ? (
            <Box flexShrink={1} marginLeft={1} overflow="hidden">
              {
}
              <Text color={t.textSecondary} wrap="truncate-end">
                {snapshot.context.operatorHandle}
              </Text>
            </Box>
          ) : null}
        </Box>
        {
}
      </Box>
    </Box>
  );
}
