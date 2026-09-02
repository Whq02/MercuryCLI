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

// ============================================================================
//  ConcourseHeader — the V2 reference header,
//  THEME-AWARE since (operator ruling, superseding SR-064's
//  fixed jellyfish): the identity mark renders the variant matching the
//  session's SELECTED critter — the same selection truth the REPL uses —
//  and the lockup ramp + bloom glow resolve at that critter's accent. The
//  concourse only FOLLOWS the selection; changing the critter stays the
//  REPL's job. The all-caps `MERCURY — SESSION CONCOURSE` lockup, the
//  breadcrumb whose DESTINATION crumbs are real controls while the active
//  crumb stays inert, and the context/clock cell are unchanged.
// ============================================================================

/** The concourse's identity — the session's SELECTED critter (
 *  superseding SR-064's fixed jellyfish): the def for the mark's shape, and
 *  the tokens resolved at the LIVE accent (override-beats-derived, exactly
 *  what the REPL's own critter surfaces wear), so the lockup ramp and the
 *  art's bloom glow live in the selected creature's hue family. With the
 *  jellyfish as the pool default, a fresh operator's concourse is
 *  byte-identical to the old fixed-jellyfish header. */
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

/** The V2 lockup, wearing the GRADIENT-GLOW identity treatment (operator
 *  ruling): the all-caps title walks the focal ramp —
 *  accent→bloom→ink across its full run — at the SELECTED critter's accent
 * Families that can't host
 *  the ramp (single-stop: light/daltonized/ansi) keep the zoom-verified
 *  flat info-cyan lockup byte-identically; NO_COLOR strips colour
 *  downstream. Motion is the bounded GREETING SHIMMER only (GLOW
 * amending SR-108's static-per-cell clause): ~10 s on first
 *  open, then the settled ramp forever — captures pin MERCURY_LIVE_GLYPHS=0
 *  and stay on the settled bytes, so the idle byte-silence census holds.
 *  Shared by the live header AND the pre-snapshot assembling shell so the
 *  title never splits grammars. */
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
  /** Operator (crumb everywhere): CONCOURSE is a real
   *  destination from the boot screens — clickable when a handler rides. */
  onConcourse?: () => void
  onMainRepl?: () => void
}): React.ReactNode {
  const t = useMercuryTokens();
  // THE CHAT IS A BRIDGE (the control-plane model): the FOCUSED CHAT crumb
  // is a destination only while a session is focused (or a landing is in
  // flight); with no chat it is inert and dim — never a control that lands
  // the boot menu under a chat's name. Re-read on the strip's own beat.
  useSyncExternalStore(subscribeSurfaceRoute, surfaceRouteVersion, surfaceRouteVersion);
  const chat = chatPresent();
  const dest = (id: string, label: string, onGo?: () => void): React.ReactNode => (
    <InteractiveRow id={`concourse:crumb:${id}`} directActivate hoverStyle="chrome-ink" {...(onGo ? { onActivate: onGo } : {})} flexShrink={0}>
      {hover => (
        // (the ratified chrome-hover contract): crumbs are compact
        // CHROME — hover speaks through ink brightening alone, never a
        // background slab (the surface2 slab is the body-row selection
        // grammar) and never underline (macOS AA fractures it into dots).
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
  /** SR-014/046: destination breadcrumbs are real route controls. */
  onBoot?: () => void
  onMainRepl?: () => void
  /** The width the header actually paints in. The split frame narrows the
   *  board to its own pane (80 columns at the floor) while the terminal
   *  stays wide — measured against the terminal, the responsive
   *  transforms below kept the full breadcrumb and the handle on an
   *  80-column row and the three ran together ("CONCOURSEBOOT › …"). Absent ⇒ the
   *  terminal's own width, byte-identical off-split. */
  columns?: number
}): React.ReactNode {
  const t = useMercuryTokens();
  const { columns: termColumns } = useTerminalSize();
  const columns = paneColumns ?? termColumns;
  // ONE PROJECT-NAME OWNER (L17, item 3): the header names NO project and
  // carries NO clock — the status rail's ground chip (the one that
  // switches) is THE name, and every chat carries its own timer. The 1 Hz
  // live-clock subscription left with the cell (zero wakeups here now).
  // Responsive transforms: below 110 the breadcrumb yields row 0 to the
  // lockup + the handle; below 92 the handle sheds too.
  const showBreadcrumb = columns >= 110;
  const showContextLabels = columns >= 92;
  // THEME-AWARE identity: the
  // mark is the SELECTED critter's square-dock variant, tinted at the live
  // accent — the same selection truth every REPL critter surface reads. The
  // bloom glow ramps the art's inks toward the
  // selected family's OWN derived bloom across the grid width — the art-cell
  // expression of the lockup's focal ramp. Collapses with the ramp: a
  // single-stop family renders the authored art untouched.
  const identity = useConcourseIdentity();
  // The compact crumb below 110 columns follows the same bridge law as the
  // full breadcrumb: a destination only while a chat exists.
  useSyncExternalStore(subscribeSurfaceRoute, surfaceRouteVersion, surfaceRouteVersion);
  const chat = chatPresent();
  // THE SQUARE TIER AT THE HEADER (the operator's screenshot
  // ask): the mark re-sources from the SQUARE family — the 11×6 square
  // DOCK grid rebinds onto the def's square slot exactly as the deck dock
  // mounts it (MiniCritter's pattern), so the header wears the same crisp
  // geometric cut-out silhouette the small berths and the 80x24 dock ship,
  // instead of the old lumpy 10×6 mid-scale mark. markCompact stays
  // authored; this was its one product mount. ONE surface only — every
  // other critter surface keeps its own grid byte-identically.
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
      {/* The SQUARE-FAMILY mark (operator ruling,
          superseding R1's mid-scale grid): the 11×6 square-dock grid renders
          3 terminal rows beside the 3-line text block — the same square
          grammar as the small berths and the deck dock, cut-out silhouette,
          tint/glow ramp kept. On the ground — no box. At 3 rows it costs
          the header band nothing beyond the text block it sits beside. */}
      <Box flexShrink={0} marginRight={1} flexDirection="column">
        <CritterArt def={markDef} square {...(glow !== undefined ? { glowToward: glow } : {})} />
      </Box>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        <Box height={1} overflow="hidden">
          <Box flexShrink={1} overflow="hidden">
            {/* The reference lockup (cell-wise plain caps; raster tracking is
                font, not cells) — ramped since the ruling. */}
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
            // IP-12 (degradation law: no primary navigation hidden while
            // decoration remains): narrow widths keep ONE compact clickable
            // crumb to the bypass — the full crumb returns at ≥110.
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
              {/* The operator's handle alone — the project name lives on
                  the status rail's ground chip (the ONE owner) and the
                  clock retired with item 3 (every chat has its own). G1:
                  a long handle clips, never pushes the lockup. */}
              <Text color={t.textSecondary} wrap="truncate-end">
                {snapshot.context.operatorHandle}
              </Text>
            </Box>
          ) : null}
        </Box>
        {/* the coordinator chip and the
            counts line are DELETED whole — every global fact paints once,
            on the status rail; a typed coordinator downgrade paints its
            warning there too. The header is lockup + crumb + context. */}
      </Box>
    </Box>
  );
}
