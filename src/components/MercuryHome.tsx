import { pathTailLabel } from '../utils/pathLabel.js'
import * as React from 'react'
import { useContext, useEffect, useId, useMemo, useState } from 'react'
import { claimHover, releaseHover, useHoverOwned } from './mercury-ui/useHoverOwned.js'
import { useDisplayedSessionModel } from '../hooks/useDisplayedSessionModel.js'
import { Box, Text } from '../ink.js'
import { CockpitActiveContext } from '../context/cockpitActiveContext.js'
import { useCwdState } from '../hooks/useCwdState.js'
import { findGitRoot } from '../utils/git.js'
import { isDeckPaneActive } from '../utils/fullscreen.js'
import {
  daemonSnapshot,
  fleetGauge,
  gitSnapshot,
  substrateSnapshot,
  traceSnapshot,
  type FleetData,
  type GitData,
  type Snapshot,
  type TraceData,
} from '../utils/cockpit/index.js'
import { HERO_ART_COLS, HERO_ART_LINES, SQUARE_ART_LINES, critterDefForKey, decideCritterForm, type CritterForm } from '../utils/cockpit/critterData.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { requestCommandDispatch } from '../utils/cockpit/helmFocus.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { BigWordmark, Sigil, Wordmark, wordmarkForm } from './mercury-ui/assets.js'
import { AnimatedCritterArt, BreathingDot } from './mercury-ui/AnimatedCritterArt.js'
import { HeroCompanionBubble, MiniCritter } from './mercury-ui/MiniCritter.js'
import { useCompanionEnabled } from './mercury-ui/useCompanion.js'
import { cycleSessionCritter, getSessionAccent, useSessionAccent } from './mercury-ui/sessionAccent.js'
import { GLYPH } from './mercury-ui/glyphs.js'
import { InteractiveRow } from './mercury-ui/InteractiveRow.js'

// ============================================================================
//  The transcript header, split two ways:
//
//  · MercuryHero — the LIVING mascot (the live session critter + accent plinth,
//    blink + click-to-morph). PERSISTENT: LogoHeader (Messages.tsx) mounts it
//    in EVERY state — fresh launch, mid-conversation, cockpit center column —
//    outside the hasTurns swap. Fixed-height + geometry-aware (contract in its
//    doc block below).
//  · MercuryHome — the fresh-session FURNITURE beneath it (the design-system
//    `full-home` card minus the hero): identity lockup (✶ sigil + Mercury
//    wordmark + ● ready) → an aligned session table (model · theme · realm ·
//    fleet on one 10-col gutter) → the prompt-hint row. Swapped for the
//    one-line MercuryBrandRow once real conversation exists.
//
//  The hero is the LIVE session critter (octopus default; /critter morphs it)
//  and the accent (wordmark, plinth, caret, rails) follows it too. (The separate
//  LAUNCH SPLASH — <config-home>/splash.mjs, the external pre-boot screen,
//  critter-selectable via MERCURY_CRITTER, default octopus — is NOT this in-app
//  welcome.) Glance data is honest snapshots.
// ============================================================================

/** The hero's height floor (terminal/center-column ROWS). Below it the block is
 *  ABSENT (authored-or-absent, — never the 13-wide flat sprite, never
 *  a glyph stand-in) and the lockup/brand line carries the identity. The same
 *  floor the pre-split landing used (tallHero), so the persistent hero appears
 *  at exactly the heights the fresh landing always showed it. */
const HERO_MIN_ROWS = 30

/**
 * MercuryHero — the PERSISTENT living mascot (the morphing-hero
 * program). ONE component owns the critter in EVERY transcript state — fresh
 * launch, mid-conversation, and the cockpit center column — so the session
 * critter never collapses to a static glyph: LogoHeader mounts it OUTSIDE the
 * hasTurns swap (the swap toggles only the FURNITURE below — wordmark scale,
 * session table, prompt-hint). /critter, click-to-morph, and the scribe glow
 * all land here live via useSessionAccent() → critterDefForKey(sa.key)
 * (shape) + sa.accent (hue) — a recolor keeps `key`, so the SHAPE morphs
 * identically whatever the hue.
 *
 * Geometry contract (why the cockpit rails can't move):
 *  · FIXED-HEIGHT art slot — the authored grids differ in height (crab,
 *    octopus and jellyfish 9 lines, the clam's compact shell 7), so the art
 *    bottom-anchors inside a height={HERO_ART_LINES} slot — a shorter
 *    creature sits on the plinth with its air above; a morph swaps pixels,
 *    never rows. Combined
 *    with the constant plinth row, the block's height is a constant — the
 *    hasTurns collapse and every critter swap leave the center column's row
 *    budget untouched.
 *  · CONTEXT-measured — useTerminalSize() reads the (possibly overridden)
 *    TerminalSizeContext, which in cockpit mode IS the center column; the hero
 *    never reads raw stdout size and never imports helmGeometry/useLayoutTier,
 *    so it can't re-enter the chrome/layout-tier math (railPlan stays the one
 *    owner of rail geometry).
 *  · Width floor — the 24-wide grid + its 2-col air needs HERO_ART_COLS+4;
 *    narrower contexts render nothing rather than clipped art.
 * Anti-junk floor: with turns present the whole header is hero + plinth + the
 * one-line brand row (~12 rows at the TOP of scrollback, mounted only while the
 * virtual list's render range starts at 0) — the 23-row landing (table, hints,
 * big wordmark) stays fresh-session-only, which is what the collapse
 * existed to guarantee.
 */
/**
 * The PINNED critter berth — the living mascot for the cockpit's
 * always-on-screen status card (operator directive: "have the
 * critter be pinned for it on full screen"). Renders the AUTHORED heroArt
 * grid (gaze + blink ride along) — in cockpit the scrollback hero is shed,
 * so the berth is the session's ONLY mascot and must carry the hero
 * treatment (operator regression report late: the flat 13-wide
 * grid here read as "the old ugly shape"). Below the hero's own named floors
 * (HERO_MIN_ROWS / HERO_ART_COLS+4, measured against the CENTER panel's size
 * override this component renders inside) the flat art is the honest
 * small-terminal fallback — a floor, not the default. Click cycles the
 * critter, same as the hero.
 * Pinned by scripts/critters/prove-berth-hero.ts (§MASCOT-DOWNGRADE).
 */
/** The berth critter's rendered width for a given CENTER-panel size — the
 *  ONE mirror of PinnedCritterBerth's heroFits gate, exported so the layout
 *  can width-budget the strip beside it (WorkCapsule) without re-deriving
 *  (and drifting from) the gate. Flat grid = 13 cols (critterData contract).
 */
/** The berth's form decision for a given CENTER-panel size — the one
 *  exported mirror for non-hook consumers (the width budget below).
 *  decideCritterForm stays the sole derivation (VP-01/02); this merely
 *  binds it to the SESSION critter's authored grids. (VP-14, operator
 *  ruling: the decision is the bare form — the diagnostic
 *  reason sentence was rendered nowhere and is deleted.) */
export function berthCritterForm(columns: number, rows: number): CritterForm {
  const rawDef = critterDefForKey(getSessionAccent().key)
  return decideCritterForm({ columns, rows }, !!rawDef.heroArt?.length)
}

export function berthCritterCols(columns: number, rows: number): number {
  // 3.6.5 (VP-02): the SAME decision the renderer takes — one owner, the
  // width budget can never drift from the form the berth actually renders.
  const form = berthCritterForm(columns, rows)
  return form === 'hero' || form === 'premium-compact' ? HERO_ART_COLS : 13
}

export function PinnedCritterBerth(): React.ReactNode {
  const tok = useMercuryTokens()
  const sa = useSessionAccent()
  const { columns, rows } = useTerminalSize()
  const rawDef = critterDefForKey(sa.key)
  // MEMOIZED, both variants: fresh def objects per render made
  // CritterArt's memo miss on every berth commit (size ticks, hover moves,
  // accent epochs) and re-reconcile the whole hero grid for zero pixel
  // change. Stable identities restore the memo bail; the hover swap flips
  // between two INTERNED objects instead of minting a third every frame.
  const def = React.useMemo(
    () => ({ ...rawDef, hue: sa.accent, hueDeep: sa.accentDeep }),
    [rawDef, sa.accent, sa.accentDeep],
  )
  const hoverDef = React.useMemo(
    () => ({ ...def, hue: tok.accentSoft }),
    [def, tok.accentSoft],
  )
  // 3.6.5: the form decides over the CENTER panel's actual
  // allocation — the 120×30 cockpit (28-row center) now carries the hero
  // grid in the compact arrangement (a deliberate premium tier), never the
  // accidental 13-wide legacy fallback the old landing-floor reuse produced.
  const form = decideCritterForm({ columns, rows }, !!rawDef.heroArt?.length)
  const heroFits = form === 'hero' || form === 'premium-compact'
  // the berth is a pointer target, so it
  // must LOOK like one — the kernel's function-child carries hover to the
  // SAME-ROW hint (never a new row, never a slab behind transparent art:
  // hover ink only). directActivate: one click morphs to the next critter,
  // matching the hero; picks STICK.
  return (
    <InteractiveRow
      id="berth:critter"
      directActivate
      onActivate={cycleSessionCritter}
      flexDirection="column"
      flexShrink={0}
    >
      {hover => (
        <Box flexDirection="column" flexShrink={0} justifyContent="center">
          {/* Fixed, bottom-aligned art slot per FORM (hero 9 · square 6 — the
              MercuryHero treatment): the authored grids differ by up to 2 rows
              per critter, and without the slot a click-morph moved the whole
              berth's height (continuity pass). Bottom-anchored so
              the plinth row never shifts. The hover AFFORDANCE is the art
              itself brightening toward the belly highlight — no new row, no
              slab behind transparent sprite cells (the rule); the
              art IS the pointer target, so the art carries the signal.
              THE SUB-HERO TIER IS THE SQUARE CRITTER (chat-feel item 5): the
              compact geometric variant with gaze-tracked eyes — the flat
              13-wide sprite retired from this berth; the hero berth is
              byte-identical. */}
          <Box
            height={heroFits ? HERO_ART_LINES : SQUARE_ART_LINES}
            flexDirection="column"
            justifyContent="flex-end"
          >
            <AnimatedCritterArt def={hover ? hoverDef : def} hero={heroFits} square={!heroFits} />
          </Box>
        </Box>
      )}
    </InteractiveRow>
  )
}

export function MercuryHero(): React.ReactNode {
  const tok = useMercuryTokens()
  // Hooks are UNCONDITIONAL — the
  // geometry gate returns null after them, so a mid-session resize that crosses
  // the floor flips the render, never the hook order.
  const sa = useSessionAccent()
  const { columns, rows } = useTerminalSize()
  const heroHoverId = useId()
  const heroHover = useHoverOwned(heroHoverId)
  // Epoch-subscribed gate: a /companion flip repaints this header instantly.
  const companionOn = useCompanionEnabled()
  // Shape from the live key, hue from the folded accent derivation (override →
  // scribe glow) — the unify: sprite, plinth and wordmark re-tint
  // together, and the shape follows /critter whatever the hue. MEMOIZED
  // a
  // fresh def per render made CritterArt's memo miss on every header commit.
  const rawDef = critterDefForKey(sa.key)
  const heroDef = React.useMemo(
    () => ({ ...rawDef, hue: sa.accent, hueDeep: sa.accentDeep }),
    [rawDef, sa.accent, sa.accentDeep],
  )
  if (rows < HERO_MIN_ROWS || columns < HERO_ART_COLS + 4) {
    // The SUB-HERO tier: when the big mascot
    // doesn't fit but the SESSION COMPANION is armed, its authored MINI form
    // takes the slot — the tiny critter above the conversation, speaking
    // beside its art. When the DECK STRIP is up it owns the creature (the
    // companion DOCK — operator round-3: "on minimised it should live
    // here"), so this transcript-top mount yields — one creature on screen.
    // Companion off ⇒ null exactly as before (byte-identical landing).
    if (companionOn && !isDeckPaneActive() && rows >= 10 && columns >= 40) {
      return (
        <Box paddingX={1} marginTop={1} flexShrink={0} justifyContent="center">
          <MiniCritter cols={columns} />
        </Box>
      )
    }
    return null
  }
  const accent = sa.accent
  const heroCols = HERO_ART_COLS
  return (
    // flexShrink={0}: in the side-by-side header row
    // the furniture column flex-grows beside this block — without the pin the
    // hero column shrinks below its plinth width and the rule WRAPS (a stray
    // `──◆` fragment under the real one, seen in the first 160-col capture).
    <Box flexDirection="column" paddingX={1} marginTop={1} flexShrink={0}>
      {/* No hover slab behind the mascot (operator, a raised panel
          reads as a BG COLOR MISMATCH through the sprite's transparent holes).
          The mascot floats on the night canvas; the plinth hint is the whole
          hover affordance. The companion's speech bubble (opt-in) floats in
          the air BESIDE the art column — a row sibling, so speaking never
          shifts the plinth or anything below (the stability contract). */}
      <Box flexDirection="row" alignItems="flex-end">
        <Box
          flexDirection="column"
          paddingX={2}
          paddingBottom={1}
          width={heroCols + 4}
          alignItems="center"
          flexShrink={0}
          onMouseEnter={() => claimHover(heroHoverId)}
          onMouseLeave={() => releaseHover(heroHoverId)}
          onClick={cycleSessionCritter}
        >
          {/* The FIXED-HEIGHT slot: bottom-anchored so every critter SITS on the
              plinth and a shorter grid gets its air on top. */}
          <Box height={HERO_ART_LINES} flexDirection="column" justifyContent="flex-end">
            <AnimatedCritterArt def={heroDef} hero={true} />
          </Box>
        </Box>
        {/* The bubble YIELDS to the companion dock exactly like the sub-hero
            mini above (operator round-3 "one creature on screen", extended to
            one VOICE): with the deck strip up its CompanionSpeechLine already
            carries the quip — a second bubble here doubled it (seen at 80
            cols, premium-pass render). */}
        {companionOn && columns >= HERO_ART_COLS + 44 && !isDeckPaneActive() ? (
          <Box
            height={HERO_ART_LINES}
            flexDirection="column"
            justifyContent="center"
            flexShrink={0}
            paddingBottom={1}
          >
            <HeroCompanionBubble />
          </Box>
        ) : null}
      </Box>
      {/* Hover hint lives INSIDE the plinth row (dashes swap for text) — a
          conditional extra row would shift the whole column and repaint
          everything below on every pointer crossing (the 'moves up and down'
          flicker). Same row count always. */}
      {/* The plinth rule wears IDENTITY DEPTH:
          it frames the identity art but must recede behind it, not compete
          with the mascot at full accent chroma. */}
      {heroHover ? (
        <Text>
          <Text color={sa.accentDeep}>{' ' + GLYPH.mission + '─'}</Text>
          <Text color={tok.textMuted}>{' click ⇒ next critter '}</Text>
          <Text color={sa.accentDeep}>{'─'.repeat(Math.max(0, heroCols - 21)) + GLYPH.mission}</Text>
        </Text>
      ) : (
        <Text color={sa.accentDeep}>
          {' ' + GLYPH.mission + '─'.repeat(heroCols + 2) + GLYPH.mission}
        </Text>
      )}
    </Box>
  )
}

/**
 * The turns-state brand FURNITURE under the persistent hero — under the
 * single-brand law this is the LEGACY BANNER-HEADER brought back:
 * with the cockpit's triple Mercury retired (the center band's `SESSION:
 * Mercury` and the lanes-rail brand block both dropped, operator directive),
 * the transcript header is THE one place the product wordmark appears. The
 * block MERCURY banner (the landing's own half-block letterforms) renders
 * when the terminal has height+width for it; below the geometry floor it
 * yields to the compact ✶ lockup — still the single appearance. The mascot is
 * NOT here — MercuryHero stays mounted above in every state — and the compact
 * form deliberately carries the ✶ sigil, not the static crab glyph: the
 * critter never "collapses to the crab". A SIBLING component, not a
 * MercuryHome prop — the swap happens mid-mount and MercuryHome's hooks must
 * not run conditionally.
 */
export function MercuryBrandRow(): React.ReactNode {
  const tok = useMercuryTokens()
  // ONE form law with the landing's bigHero (wordmarkForm): the two
  // home states must agree at every terminal size — height bar 34 rows, and
  // 48 cols keeps the 42-cell banner from wrapping.
  const { rows, columns } = useTerminalSize()
  const banner = wordmarkForm(columns, rows) === 'banner'
  return (
    // flexShrink=0 (with BigWordmark's own): identity art never shrinks under
    // a flex squeeze — the bars above pick the FORM; the layout must never
    // truncate the picked form mid-glyph (product-study r3).
    <Box paddingX={1} marginTop={1} flexShrink={0}>
      {banner ? (
        <BigWordmark />
      ) : (
        <Text>
          <Sigil size="inline" />
          <Text> </Text>
          <Wordmark />
        </Text>
      )}
    </Box>
  )
}

export function MercuryHome(): React.ReactNode {
  const tok = useMercuryTokens()
  // Scribe-aware display resolver — under the two-stream router this names
  // both streams instead of the stale mainLoopModel.
  const model = useDisplayedSessionModel().label
  // The ground beat (Law 9): a concourse repo pick repaints this dir row in
  // the move's own frame window — no first-message heal.
  const cwd = useCwdState()
  const dir = pathTailLabel(cwd)

  const [git, setGit] = useState<Snapshot<{ data: GitData }> | null>(null)
  const [fleet, setFleet] = useState<Snapshot<{ data: FleetData }> | null>(null)
  const [trace, setTrace] = useState<Snapshot<{ data: TraceData }> | null>(null)
  // The /init signpost gate: true when the SESSION composed no project-scope
  // instruction source (the same discovery the prompt reads — memoized, so
  // this is a cache read at mount). Paired with the project gate below so the
  // hint never shows in a non-project cwd; probing creates nothing. The
  // project test is the engine's own findGitRoot walk — sync and race-free
  // (the async git snapshot above loses its boot race in fresh homes and
  // reads null for real repos).
  const [projectScopeEmpty, setProjectScopeEmpty] = useState(false)
  // A derivation, not mount-pinned state: the project test follows the
  // ground beat (a repo pick moves the ground; the /init hint gate must
  // answer for the NEW folder).
  const isProjectCwd = useMemo((): boolean => {
    try {
      return findGitRoot(cwd) !== null
    } catch {
      return false
    }
  }, [cwd])
  useEffect(() => {
    let alive = true
    gitSnapshot().then(s => alive && setGit(s))
    fleetGauge().then(s => alive && setFleet(s))
    traceSnapshot().then(s => alive && setTrace(s))
    void import('../services/instructions/engine.js')
      .then(engine => engine.getInstructionFiles())
      .then(files => {
        if (!alive) return
        setProjectScopeEmpty(
          !files.some(f => f.type === 'Project' || f.type === 'Local'),
        )
      })
      .catch(() => {})
    return () => {
      alive = false
    }
    // Re-probes on the ground beat (the MercuryFrame re-probe law): a repo
    // pick that repaints the dir row must not keep the OLD repo's branch
    // chip beside it. The alive flag drops any stale in-flight snapshot.
  }, [cwd])

  const substrate = substrateSnapshot()
  const daemon = daemonSnapshot()
  // Shed the fleet/trace/substrate/daemon glance line ONLY when the Helm cockpit's
  // rails are ACTUALLY on screen. We read CockpitActiveContext (set true by HelmHome
  // on its wide, rails-showing branch) rather than the terminal width — because
  // HelmHome overrides TerminalSizeContext to the narrower CENTER column for its
  // subtree, so a `columns >= HELM_HOME_MIN_COLS` check HERE would read ~70 and
  // wrongly KEEP the line (a dup with the rail). Narrow fallback provides no context
  // → false → the line stays (rails hidden, no data loss). Mirrors the deck dedup.
  const helmHome = useContext(CockpitActiveContext)
  // The pinned DeckPane is on screen on the deck-strip home (fullscreen, deck
  // enabled, cockpit not showing) — the session table's model/git owners there.
  // Same derivation shape as MercuryFrame's deckPresent.
  const deckPresent = isDeckPaneActive() && !helmHome

  // The ACCENT follows the LIVE session critter (TERRA for crab, violet for
  // octopus…) via the folded derivation (override → scribe glow) — wordmark,
  // table accents and the ❯ caret re-tint on /critter and on a scribe flip
  // together. The MASCOT itself lives
  // in MercuryHero (mounted above this furniture by LogoHeader in every state).
  const sa = useSessionAccent()
  const accent = sa.accent
  // bigHero: the block MERCURY wordmark; below it the compact ✶ sigil +
  // wordmark lockup. ONE form law with MercuryBrandRow (wordmarkForm,
  // One form law — rows alone would otherwise wrap the 42-cell banner in a tall-narrow
  // terminal). (The hero's own >=30 floor is MercuryHero's — HERO_MIN_ROWS
  // above; the split-gate lesson.)
  const { rows: termRows, columns: termCols } = useTerminalSize()
  const bigHero = wordmarkForm(termCols, termRows) === 'banner'
  const critterLabel = sa.name.charAt(0).toUpperCase() + sa.name.slice(1)
  // Click sweep (task #66): the session-table rows and the standing-by line
  // were dead to the mouse — each clickable row now dispatches its owning
  // surface (the SessionTabs requestCommandDispatch idiom) with the kernel's
  // shared hover affordance. One global owner, not one state per row.
  // each glance row is a directActivate kernel row (one click
  // dispatches its owning surface); hover rides the ONE global owner via
  // InteractiveRow — the hand-rolled onClick/claimHover factory is absent.
  const rowClick = (key: string, command: string): { id: string; directActivate: true; onActivate: () => void } => ({
    id: `home:row:${key}`,
    directActivate: true,
    onActivate: () => requestCommandDispatch(command),
  })

  // Realm line: dir + branch · state (honest from git).
  const branch = git?.data.git?.branchName
  const gitState = git == null ? '…' : git.data.git == null ? 'no git' : git.data.git.isClean ? 'clean' : 'uncommitted'

  // Fleet glance — honest: agent health dots when in a team, else "no fleet".
  const agents = fleet?.state === 'live' ? fleet.data.health.length : 0
  const traceCount = trace?.state === 'live' ? trace.data.total : 0

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* (1) — the HERO renders ABOVE this furniture (MercuryHero, mounted by
          LogoHeader in every transcript state; authored-or-absent + fixed
          height live there). This component is the fresh-session furniture
          only: lockup → ready → session table → prompt-hint. */}

      {/* (2) IDENTITY LOCKUP — the BIG block "MERCURY" wordmark (a visual-weight type
          scale; the terminal can't resize the font, so "bigger" = more cells) when there's
          height for it, else the compact ✶ sigil + Mercury wordmark; then the tagline +
          the live ● ready. */}
      <Box flexDirection="column" marginTop={1}>
        {bigHero ? (
          <BigWordmark />
        ) : (
          <Box>
            <Sigil size="inline" />
            <Text> </Text>
            <Wordmark />
          </Box>
        )}
        {/* No tagline (operator: the slogan register — "mission
            control · forged, not wrapped" and its class — is off-putting;
            copy is design material and this line carried no information).
            The ready line ADVERTISES "/ for commands" — clicking it opens the
            deck (keydead honesty: an affordance named is an affordance wired). */}
        <InteractiveRow {...rowClick('standing-by', '/deck')}>
          <BreathingDot />
          <Text color={tok.success}> ready</Text>
          <Text color={tok.textMuted}>
            {' · type a prompt, or '}
            <Text color={tok.info}>/</Text>
            {' for commands'}
          </Text>
        </InteractiveRow>
      </Box>

      {/* (3) SESSION TABLE — model · theme · realm · fleet share ONE 10-col gutter so
          they read as one aligned briefing. `theme` names the live session critter.
          DATUM-DEDUP (QoL): on the deck-strip home the pinned DeckPane
          already shows model (header row) + branch·state (git row), so the table
          sheds the `model` row and the realm row's git tail there — the same
          single-owner discipline the helmHome gate below applies to the fleet
          line. `theme` and the realm DIR stay (the deck shows neither). */}
      <Box marginTop={1} flexDirection="column">
        {!deckPresent ? (
          <InteractiveRow {...rowClick('model', '/model')}>
            <Text>
              <Text color={tok.textMuted}>{'  model   '}</Text>
              <Text color={tok.textPrimary}>{model}</Text>
            </Text>
          </InteractiveRow>
        ) : null}
        <InteractiveRow {...rowClick('theme', '/critter')}>
          <Text>
            <Text color={tok.textMuted}>{'  theme   '}</Text>
            <Text color={accent}>{critterLabel}</Text>
          </Text>
        </InteractiveRow>
        <Text wrap="truncate-end">
          <Text color={tok.textMuted}>{'  dir     '}</Text>
          <Text color={tok.textPrimary}>{dir}</Text>
          {!deckPresent && branch ? (
            <Text>
              <Text color={tok.textMuted}>{'   ' + GLYPH.branch}</Text>
              <Text color={tok.textPrimary}>{branch}</Text>
            </Text>
          ) : null}
          {!deckPresent ? <Text color={tok.textMuted}> · {gitState}</Text> : null}
        </Text>
        {/* A2.2 dedup: the cockpit rails own fleet/trace/substrate/ctx (helmHome),
            and the deck strip's ops row owns daemon/fleet/trace (deckPresent) —
            shed this line when EITHER owner is on screen. Inline-classic keeps it. */}
        {!helmHome && !deckPresent ? (
          <InteractiveRow {...rowClick('fleet', '/fleet')}>
          <Text wrap="truncate-end">
            <Text color={tok.textMuted}>{'  fleet   '}</Text>
            {agents > 0 ? (
              <Text color={tok.success}>{'● '.repeat(Math.min(agents, 3)).trim()} </Text>
            ) : (
              <Text color={tok.textMuted}>○ </Text>
            )}
            <Text color={tok.textSecondary}>{agents > 0 ? `${agents} agents` : 'no fleet'}</Text>
            <Text color={tok.textMuted}> · trace </Text>
            <Text color={tok.textSecondary}>{traceCount}</Text>
            <Text color={tok.textMuted}> · substrate </Text>
            <Text color={tok.textSecondary}>
              {substrate.data.active}/{substrate.data.total}
            </Text>
            <Text color={tok.textMuted}> · daemon </Text>
            <Text color={daemon.state === 'live' ? tok.success : tok.textMuted}>
              {daemon.state === 'live' ? 'on' : 'off'}
            </Text>
          </Text>
          </InteractiveRow>
        ) : null}
        {/* The /init signpost — one calm line, only in a PROJECT cwd (a git
            repo) whose composed project scope is empty (no MERCURY.md
            anywhere the loader looks). Fresh-session furniture ⇒ shown once
            per session; creates nothing; clicking dispatches /init like every
            other advertised affordance here. */}
        {projectScopeEmpty && isProjectCwd ? (
          <InteractiveRow {...rowClick('init-signpost', '/init')}>
            <Text wrap="truncate-end">
              <Text color={tok.textMuted}>{'  no MERCURY.md here · '}</Text>
              <Text color={tok.info}>/init</Text>
              <Text color={tok.textMuted}> studies the repo and writes it</Text>
            </Text>
          </InteractiveRow>
        ) : null}
      </Box>

      {/* (4) PROMPT-HINT row — plain register (operator: the old
          field-brief phrasing — "state the objective — ↵ dispatches" — was the
          off-putting slogan class; say what the keys do). truncate-end so the
          command list never wraps. */}
      {/* Default cross-axis stretch (no percent): a width="100%" child of
          this padded root resolved against the BORDER-BOX (the A2 class), so
          the truncate budget crossed the padding by two columns. */}
      <Box marginTop={1}>
        <Text wrap="truncate-end">
          <Text color={accent}>❯ </Text>
          <Text color={tok.textPrimary}>↵</Text>
          <Text color={tok.textSecondary}> sends</Text>
          {/* Flagship surfaces FIRST (workflows/health were invisible from
              the landing — the nav audit; the seat board that once
              led this line retired with the router party); truncate-end sheds
              the tail on narrow columns, so priority order IS the responsive
              behavior. /fleet stays off the landing (hidden unless swarms are
              on — a dead-affordance risk) to hold the width. */}
          <Text color={tok.textMuted}>{'  ·  /workflows /teammates /saturn /health /cockpit /trace'}</Text>
        </Text>
      </Box>
    </Box>
  )
}
