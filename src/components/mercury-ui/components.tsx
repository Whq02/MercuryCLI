// ============================================================================
//  mercury-ui/components — the shared warm-ink primitives.
//
//  Every Mercury command-center surface renders from these so the look is one
//  system (terminal-ui-design): round-TERRA shell, Crab header, geometric
// glyphs, the honest-state spine. Rules: props only — no env/file/git
//  reads here (data arrives via utils/cockpit snapshots); long content truncates
//  via displayWidth math; lists are bounded by the caller; every state badge
//  covers the full 8-state taxonomy; all components hold at 80 columns.
// ============================================================================

import * as React from 'react'
import { isTopOverlayNow, useRegisterOverlay } from '../../context/overlayContext.js'
import { useElevatedSurface } from './useElevatedSurface.js'
import { Box, MotionParkContext, Text, useInput, useTheme } from '../../ink.js'
import { useCwdState } from '../../hooks/useCwdState.js'
import { formatFreshness, freshnessTone } from '../../utils/cockpit/freshness.js'
import { quantizedNow, subscribeUiClock } from '../../utils/cockpit/uiClock.js'
import { useMercuryTokens } from './useMercuryTokens.js'
import { markTransitionEnd } from '../../utils/observability/frictionStopwatch.js'
import { resolveMercuryTokens, spectralRampFor } from '../../utils/mercuryTokens.js'
import { Crab, Wordmark } from './assets.js'
import { rampSegments } from './focalRamp.js'
import { useGreetingShimmer } from './useGreetingShimmer.js'
import { useSessionAccent } from './sessionAccent.js'
import { GLYPH, SPARK, displayWidth, padTo, truncateToWidth } from './glyphs.js'
import { InteractiveRow } from './InteractiveRow.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useIsInsideModal, useModalOrTerminalSize, useModalScrollRef } from '../../context/modalContext.js'
import ScrollBox, { type ScrollBoxHandle } from '../../ink/components/ScrollBox.js'
import { composeFooterHint, packFooter } from './footerHint.js'
import { gaugeColorOf, stateStyleOf, type SnapshotState } from './theme.js'

// Identity accent + every ink/surface/state colour now resolve through the
// ADAPTIVE token layer: each component calls useMercuryTokens()
// — a SUBSCRIBED hook (theme + accent), so a live /theme, /critter or
// /accent change re-tints the whole kit in the same committed frame. Dark is
// byte-identical to the old fixed constants (dark tokens ≡ mercuryPalette);
// light/daltonized/ansi finally get their OWN legible mapping. The status
// spine keeps fixed MEANING (success/warning/failure roles) in every family.

// When a surface is rendered inside the cockpit tower, the tower wraps it in
// <CockpitEmbeddedContext.Provider value={true}> so EVERY CommandCenter beneath
// it (incl. a surface's loading/empty variants) renders body-only — one shared
// shell, no double border/header/footer, no competing esc/← input. No per-surface
// threading needed. Default false ⇒ standalone surfaces are byte-identical.
export const CockpitEmbeddedContext = React.createContext(false)


// --- shell + structure ------------------------------------------------------

// The command-center shell: round-TERRA frame + `<Crab/> Mercury — view`
// header + a muted-ink `{footer} · esc / ← close` footer (close-hint follows
// `closeKeys` — pass 'esc' on a captureInput-false esc-only child so we don't
// advertise a dead `← close`). Binds esc AND ← →onClose unless `captureInput`
// is false (an arrow-key child owns its own input then). Return is deliberately NOT a close key: the
// keystroke that launches a slash command IS Enter, and it can leak into the
// freshly-mounted panel (incl. a gallery specimen opened with ↵) and instantly
// dismiss it — so close on esc only (full-* cards say "esc / ← close").
/** THE product-identity lockup line — live-accent crab +
 *  the ramped title run + optional data subtitle. Every product-identity
 *  header renders THIS component; a surface that needs the line without the
 *  CommandCenter shell (its own bordered geometry, e.g. the /model picker)
 *  consumes it directly. Hand-composing crab glyphs + accent "Mercury" text
 *  is the imitation class the lockup census
 *  (scripts/consistency-census/gen-lockup-census.ts) ratchets against.
 *
 *  MAIN-HEADER GLOW: the whole `Mercury — VIEW`
 *  title walks ONE continuous focal ramp — accent→bloom→ink across the full
 *  run, resolved at the EFFECTIVE accent exactly like the Wordmark (R5) — so
 *  every main header wears the splash wordmark's identity material. Families
 *  that can't host the ramp (single-stop: light/daltonized/ansi) keep the
 *  pre-ruling presentation byte-identically — flat-accent bold Wordmark +
 *  muted view label. The subtitle stays DATA (muted dot + primary ink),
 *  never identity; it truncates rather than wrapping the brand row. */
export function ProductLockup({
  view,
  subtitle,
}: {
  view: string
  subtitle?: string
}): React.ReactNode {
  const t = useMercuryTokens()
  const { accent } = useSessionAccent()
  const [theme] = useTheme()
  const ramp = accent === t.accent ? t.focalRamp : resolveMercuryTokens(theme, accent).focalRamp
  // The greeting shimmer: opening a surface mounts its
  // header, so the title run greets for ~10 s and settles into the exact
  // static ramp below; re-opening re-mounts ⇒ a fresh greeting. The
  // single-stop families never reach the ramped arm, so the flat fallback
  // stays byte-identical (span 1 disables the hook on that arm too).
  const title = `Mercury — ${view}`
  const shimmer = useGreetingShimmer(ramp, displayWidth(title))
  return (
    <Box>
      <Crab />
      <Text> </Text>
      {ramp.length > 1 ? (
        <Text>
          {rampSegments(title, ramp, { shimmer }).map((s, i) => (
            <Text key={i} bold color={s.color}>
              {s.text}
            </Text>
          ))}
        </Text>
      ) : (
        <Text>
          <Wordmark />
          <Text color={t.textMuted}> — {view}</Text>
        </Text>
      )}
      {subtitle ? (
        <Text wrap="truncate-end">
          <Text color={t.textMuted}> · </Text>
          <Text color={t.textPrimary}>{subtitle}</Text>
        </Text>
      ) : null}
    </Box>
  )
}

export function CommandCenter({
  view,
  subtitle,
  footer,
  onClose,
  captureInput = true,
  closeKeys = 'esc-arrow',
  embedded: embeddedProp = false,
  specimen = false,
  elevated = false,
  children,
}: {
  view: string
  subtitle?: string
  footer?: string
  onClose: () => void
  captureInput?: boolean
  /** Footer close-hint override. The footer advertises `← close` ONLY when
   *  CommandCenter itself binds ← — i.e. `captureInput && !embedded` (the shell
   *  owns input). On a captureInput-false surface CommandCenter binds nothing:
   *  the child owns input and, by convention (useInteractiveList + the Mercury*
   *  pickers), binds esc ONLY and leaves ← unbound (or bound to tab-switch, e.g.
   *  the capability center) — so the footer renders ` · esc close` and never a
   *  dead-or-wrong `← close`. Pass 'esc' to force esc-only even on a captureInput
   *  surface (rare). */
  closeKeys?: 'esc-arrow' | 'esc'
  /** Hosted inside the cockpit tower: render ONLY the body — the tower owns the
   *  border, header, footer, and ALL input (esc/tab/←/→). No own useInput. Set
   *  via the prop OR the CockpitEmbeddedContext (the tower uses the context so it
   *  needn't thread this through every surface). */
  embedded?: boolean
  /** DESIGN-SPECIMEN surfaces (planned/gated designs realised in-terminal — the
   *  /parity · /orch · /settings galleries + their planned siblings) render a
   *  one-line banner under the header so they can never be mistaken for broken
   *  live product (uniqueness-program P6 / capability-matrix perception debt). */
  specimen?: boolean
  /** LUSTRE L1 — this center is a FOCUSED LAYER over retained context (the
   *  quick-open overlays): register its rect as elevated so the compositor
   *  recedes everything outside it while it's open. Standalone branch only —
   *  an embedded body rides its tower's registration. */
  elevated?: boolean
  children: React.ReactNode
}): React.ReactNode {
  const t = useMercuryTokens()
  const embedded = embeddedProp || React.useContext(CockpitEmbeddedContext)
  const elevatedRef = useElevatedSurface()
  // Friction stopwatch: this shell mounting IS the screen switch landing —
  // one real sample against the dispatch-seam start mark (no pending start
  // ⇒ records nothing; an embedded body is not a screen switch).
  React.useEffect(() => {
    if (!embedded) markTransitionEnd('screen-switch')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Input-owning centers are OVERLAY INSTANCES on the ownership stack: esc
  // routes to the TOP layer only (a select/picker stacked over this center
  // takes the esc; the pop-stamp keeps this center from ALSO closing on the
  // same keypress), and CancelRequestHandler stands down while the center
  // is open — esc backs out one level, it never doubles as turn-cancel.
  const overlayToken = useRegisterOverlay(`center:${view}`, captureInput && !embedded)
  useInput(
    (_i, key) => {
      if (key.escape || key.leftArrow) {
        if (overlayToken !== null && !isTopOverlayNow(overlayToken)) return
        onClose()
      }
    },
    { isActive: captureInput && !embedded },
  )
  // Rides the ground beat (Law 9): the shell footer's default dir chip
  // repaints on a repo pick, not on the next unrelated re-render.
  const groundCwd = useCwdState()
  const dir = groundCwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || groundCwd
  // /0205: append the close hint ONLY when the footer prop doesn't already
  // advertise one — otherwise the captureInput=false callers that bake their own
  // 'esc close/cancel/keep/dismiss' (the capability center, EffortCallout, the two
  // AutoDefault dialogs, /copy) and the SessionManagerView empty-state would render
  // a doubled/contradictory close tail. A footer with NO close token is byte-identical
  // to before. Logic lives in composeFooterHint (proved in prove-footer-dedup.ts).
  // The one-line law at the shell CHOKEPOINT: every hosted footer packs to
  // the live inner width (complete segments, close hint reserved, no dangling
  // separator) — a narrow terminal sheds optional hints instead of wrapping
  // the surface and oscillating the dialog height.
  const cols = useTerminalSize().columns
  // The budget is the LIVE inner width, floored at zero only (MINI-TEMPER
  // item 3): the old Math.max(10, …) floor claimed cells a <14-col terminal
  // does not possess — packFooter now projects the close hint down ('esc',
  // then '') instead of overflowing.
  const footerText = packFooter(
    composeFooterHint(footer ?? dir, { closeKeys, captureInput }),
    Math.max(0, cols - 4),
  )
  // THE FOOTER STAYS ON SCREEN. The modal slot bounds its pane to the
  // terminal and clips the overflow at the bottom — a body taller than the
  // slot (the /help general tab at 30 rows, /logins with its readiness
  // block, the /accounts board) used to take the footer's close hint off
  // screen with it. Inside a modal the body is a scroll box capped at the
  // slot's rows minus this shell's own chrome (border 2 · lockup 1 ·
  // specimen banner · footer 2), registered as the slot's scroll target;
  // the wheel scrolls it, PageUp/PageDown page it while it overflows, and
  // the header and footer stay put. A body that fits keeps its natural
  // height (a cap, never a fixed height — short surfaces stay short).
  const insideModal = useIsInsideModal()
  const termRows = useTerminalSize().rows
  const slotRows = useModalOrTerminalSize({ rows: termRows, columns: cols }).rows
  const bodyCap = Math.max(1, slotRows - (5 + (specimen ? 1 : 0)))
  const bodyRef = React.useRef<ScrollBoxHandle | null>(null)
  const modalScrollRef = useModalScrollRef()
  React.useLayoutEffect(() => {
    if (!insideModal || embedded || !modalScrollRef) return
    modalScrollRef.current = bodyRef.current
    return () => {
      modalScrollRef.current = null
    }
  }, [insideModal, embedded, modalScrollRef])
  useInput(
    (_i, key) => {
      const body = bodyRef.current
      if (!body || !(key.pageUp || key.pageDown)) return
      const viewport = body.getViewportHeight()
      if (body.getFreshScrollHeight() <= viewport) return
      body.scrollBy((key.pageUp ? -1 : 1) * Math.max(1, viewport - 1))
    },
    { isActive: insideModal && !embedded },
  )
  if (embedded) {
    // Embedded in the cockpit tower (CockpitView owns the frame/header/tab-strip/
    // footer + input): render BODY-ONLY — a border here double-frames every /cockpit
    // tab. The Helm drill-in path does NOT set the
    // embedded context, so it renders the STANDALONE branch below and keeps its round
    // frame (fleet.png); only /cockpit tabs are embedded. The specimen banner is
    // honesty chrome, not framing — it must survive embedding (audit U17).
    // No width="100%" (the SectionHeader rule below): a percent width
    // resolves against the owner's PADDED box, so inside the tower's
    // bordered, padded frame the body overran the right border; a column
    // child already stretches to the content width.
    return (
      <Box flexDirection="column">
        {specimen ? (
          <Box>
            <Text wrap="truncate-end">
              <Text color={t.textSecondary} bold>{GLYPH.mission} DESIGN SPECIMEN</Text>
              <Text color={t.textMuted}> — a planned/gated design realised in-terminal, not live product</Text>
            </Text>
          </Box>
        ) : null}
        {children}
      </Box>
    )
  }
  return (
    // the shell border is STRUCTURE (borderStrong), not a
    // full identity frame — pre-AURORA every command-center overlay (~60
    // views) wore a full round accent border, so "accent border" stopped
    // meaning focus. Identity stays with the crab + wordmark lockup the
    // header already carries; focused sub-panes keep their localized accent.
    // No width="100%" (the SectionHeader rule below): a percent width
    // resolves against the host's PADDED box, so the modal slot's padded
    // wrapper would otherwise hand every center the full terminal width from one
    // column in — one column too wide, right border off-screen. A column
    // child stretches to its owner's content width, which is the width
    // every host actually provides.
    <Box ref={elevated ? elevatedRef : undefined} flexDirection="column" borderStyle="round" borderColor={t.borderStrong} paddingX={1}>
      <ProductLockup view={view} subtitle={subtitle} />
      {specimen ? (
        <Box>
          <Text wrap="truncate-end">
            <Text color={t.textSecondary} bold>{GLYPH.mission} DESIGN SPECIMEN</Text>
            <Text color={t.textMuted}> — a planned/gated design realised in-terminal, not live product</Text>
          </Text>
        </Box>
      ) : null}
      {insideModal ? (
        <ScrollBox ref={bodyRef} flexDirection="column" maxHeight={bodyCap}>
          {children}
        </ScrollBox>
      ) : (
        children
      )}
      {/* Advertise only the close key(s) ACTUALLY bound for this surface.
          Default 'esc-arrow' (shell owns input, or a child binds esc+←).
          'esc' on a captureInput-false esc-only child whose ← is unbound or
          does something else (a tabbed view may switch tabs on ←) — so
          we never render a dead-or-wrong `← close`. The row is a CLICK
          target through the ONE kernel: a registered direct
          control — one click closes, hover paints, geometry never moves. */}
      <InteractiveRow id={`center:${view}:close`} directActivate onActivate={onClose} flexDirection="column">
        {/* Hover-hierarchy: footer chrome hovers through INK (the
            function child keeps the marginTop spacer row — bare Text would
            delete it — and suppresses the body-row surface2 slab). */}
        {hover => (
          <Box marginTop={1}>
            <Text color={hover ? t.info : t.textMuted}>{footerText}</Text>
          </Box>
        )}
      </InteractiveRow>
    </Box>
  )
}

// A nested bordered panel (fullscreen rails / sub-cards). Accent → TERRA frame,
// else a neutral dune-less muted-ink frame. Title is a bold heading inside. `raised`
// (opt-in, default off) fills the bounded box with the surface surface so the design
// system's night-canvas → ash-panel depth language reads in supporting terminals
// (truecolor/256). Colour-strip safe: depth is decorative, the border carries it.
export function Panel({
  title,
  accentBorder,
  raised = false,
  children,
}: {
  title?: string
  accentBorder?: boolean
  raised?: boolean
  children: React.ReactNode
}): React.ReactNode {
  const t = useMercuryTokens()
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={accentBorder ? t.accent : t.textMuted}
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      backgroundColor={raised ? t.surface1 : undefined}
      paddingX={1}
    >
      {title ? (
        // Panel titles are informational headings — the info channel,
        // so N panels never read as N competing identity headings.
        <Text bold color={t.info}>
          {title}
        </Text>
      ) : null}
      {children}
    </Box>
  )
}

// Section heading: primary-ink-bold label + a subtle-border hairline rule filling the
// remaining row width (a flexGrow borderBottom box — width-aware, no char
// counting). Flare pass: demoted from bold-ACCENT to bold-primary-ink so
// the accent stays scarce (shell title, cursors, status meaning) — a panel of
// N sections does not read as N competing red headings — and the rule gives
// every section a physical edge, which is what makes a panel read as built
// from parts instead of floating labels.
export function SectionHeader({
  children,
  count,
  marginTop = 1,
}: {
  children: string
  count?: number
  marginTop?: number
}): React.ReactNode {
  const t = useMercuryTokens()
  // No width="100%": a percent width resolves against the parent's PADDED
  // box, so inside any bordered container (CommandCenter) the trailing rule
  // overran the right border by the padding width (caught live in the
  // shell-detail card). A row child of a column container
  // already stretches to the CONTENT width (Yoga align-items: stretch) —
  // exactly the full-width rule every call site wants.
  return (
    <Box marginTop={marginTop} flexDirection="row">
      <Text bold color={t.textPrimary}>
        {children}
      </Text>
      {typeof count === 'number' ? <Text color={t.textMuted}> ({count})</Text> : null}
      <Box
        flexGrow={1}
        height={1}
        marginLeft={1}
        borderStyle="single"
        borderColor={t.borderSubtle}
        borderTop={false}
        borderLeft={false}
        borderRight={false}
      />
    </Box>
  )
}

// Bold informational heading without a wrapping Box (inline use). Mirrors the
// hand-rolled `Heading` in Deck/Fleet/Trace so migration is a swap.
// headings are information/navigation, not identity — they ride
// the info channel (OASIS in dark) so the accent stays scarce and meaningful.
export function Heading({ children }: { children: string }): React.ReactNode {
  const t = useMercuryTokens()
  return (
    <Text bold color={t.info}>
      {children}
    </Text>
  )
}

// The muted-ink ` │ ` segment separator used in the statusbar and inline strips.
export function Sep(): React.ReactNode {
  const t = useMercuryTokens()
  return <Text color={t.textMuted}> {GLYPH.sep} </Text>
}

// A horizontal rule; a label centers a caption in the rule. Default colour is
// muted-ink (the rule reads as chrome); pass `color` to tint the whole rule — e.g.
// the warm-ink session accent for the supercode-activation divider. The default
// is unchanged, so every existing caller stays muted-ink.
export function Divider({
  label,
  width = 40,
  color,
}: {
  label?: string
  width?: number
  color?: string
}): React.ReactNode {
  const t = useMercuryTokens()
  const ink = color ?? t.textMuted
  // Same narrow-geometry floor as the gauge: a terminal-derived width must
  // degrade to an empty rule, never a negative repeat.
  width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0
  if (!label) {
    return <Text color={ink}>{'─'.repeat(width)}</Text>
  }
  const side = Math.max(1, Math.floor((width - displayWidth(label) - 2) / 2))
  return (
    <Text color={ink}>
      {'─'.repeat(side)} {label} {'─'.repeat(side)}
    </Text>
  )
}

// --- state spine ------------------------------------------------------------

// The honest-state badge: glyph + (optionally) the state word, coloured by the
// taxonomy. `label` overrides the word; `mono` keeps the label primary-ink/secondary-ink.
// useNowTick — a wall-clock tick for any surface whose rows derive ages
// from Date.now() (extracted from PartyBoard, the freshness gold standard).
// Without it ages FREEZE between store writes (a 15s heartbeat ⇒ a "↻ Ns ago"
// header is stale most of the time). The tick doubles as a scheduler wake
// pump: a store update whose commit parked while the app idled paints within
// one tick (the idle-parked-commits arm).
//
// Since the ticks ride the SHARED uiClock: one timer per distinct
// cadence for every consumer (N age rows would otherwise run N private intervals),
// quantized so an unchanged tick value bails out of the setState (output-edge
// dedupe), and skipped during active scroll drain like every well-behaved
// background interval.
export function useNowTick(ms: number | null = 1000): number {
  // Motion parking: a consumer whose painted cells are fully covered by an opaque
  // claims-modal parks its tick (MotionParkContext) — covered age rows and
  // clocks are pure compose waste. The wake-pump role survives: the modal's
  // own consumers ride the value={false} reset, input events flush parked
  // commits, and modal close repaints every context consumer, so a covered
  // update can never stay stale once anything is visible again. Unpark (and
  // first mount) seeds the quantized value immediately, so a reopened
  // surface never shows a frozen age for a beat.
  const parked = React.useContext(MotionParkContext)
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    // null/0 ⇒ no interval (a conditional consumer parks the tick without
    // breaking the rules of hooks — the merged-telemetry glance).
    if (!ms || parked) return
    setNow(quantizedNow(ms))
    return subscribeUiClock(ms, () => setNow(quantizedNow(ms)))
  }, [ms, parked])
  return now
}

// FreshnessLine — the shared "how fresh is what you're looking at" label:
// `source · ↻ Ns ago`, muted-ink while fresh, warning + an explicit "stale" word
// once older than staleMs. Data arrives via props (now from useNowTick, at
// from the feed's stamp) so the component stays pure; the math lives in
// utils/cockpit/freshness.ts (bun-loadable, table-proved).
export function FreshnessLine({
  at,
  now,
  source,
  staleMs = 60_000,
}: {
  at: number
  now: number
  source?: string
  staleMs?: number
}): React.ReactNode {
  const t = useMercuryTokens()
  const stale = freshnessTone(now, at, staleMs) === 'stale'
  return (
    <Text color={stale ? t.warning : t.textMuted}>
      {source ? `${source} · ` : ''}
      {formatFreshness(now, at)}
      {stale ? ' · stale' : ''}
    </Text>
  )
}

export function StateBadge({
  state,
  label,
  mono = false,
}: {
  state: SnapshotState
  label?: string
  mono?: boolean
}): React.ReactNode {
  const t = useMercuryTokens()
  const s = stateStyleOf(t, state)
  const text = label ?? s.label
  return (
    <Text>
      <Text color={s.color}>{s.glyph}</Text>
      <Text color={mono ? t.textSecondary : s.color}> {text}</Text>
    </Text>
  )
}

// A bare status dot — pass an explicit glyph+color (task/health) or a state.
export function StatusDot({
  state,
  glyph,
  color,
}: {
  state?: SnapshotState
  glyph?: string
  color?: string
}): React.ReactNode {
  const t = useMercuryTokens()
  if (state) {
    const s = stateStyleOf(t, state)
    return <Text color={s.color}>{s.glyph}</Text>
  }
  return <Text color={color ?? t.textMuted}>{glyph ?? GLYPH.idle}</Text>
}

// Status tones keep fixed MEANING; the values resolve per family through the
// token layer. `accent` is the live identity hue.
type ChipToneName = 'active' | 'warn' | 'danger' | 'idle' | 'pending' | 'neutral' | 'accent'
function chipTone(t: ReturnType<typeof useMercuryTokens>, tone: string): string {
  switch (tone) {
    case 'active': return t.success
    case 'warn': return t.warning
    case 'danger': return t.failure
    case 'idle': return t.textMuted
    case 'accent': return t.accent
    default: return t.textSecondary
  }
}

// A status pill `[ label ]`. `solid` inverts (filled accent). Tone colours the
// bracket+label; in a terminal there is no fill, so `solid` just bolds.
export function Chip({
  tone = 'neutral',
  solid = false,
  children,
}: {
  tone?: ChipToneName | string
  solid?: boolean
  children: string
}): React.ReactNode {
  const t = useMercuryTokens()
  const color = chipTone(t, tone)
  return (
    <Text color={color} bold={solid}>
      [ {children} ]
    </Text>
  )
}

// --- metrics ----------------------------------------------------------------

// Faint label + toned value, inline (deck/frame strips).
export function MetricPill({
  label,
  value,
  tone,
}: {
  label?: string
  value: string
  tone?: string
}): React.ReactNode {
  const t = useMercuryTokens()
  return (
    <Text>
      {label ? <Text color={t.textMuted}>{label} </Text> : null}
      <Text color={tone ?? t.textPrimary}>{value}</Text>
    </Text>
  )
}

// An aligned key/value fact table. Keys pad to `keyWidth`; a row may carry a
// tone for its value and a muted-ink note tail.
export type KVRow = {
  k: string
  v: string
  tone?: string
  note?: string
  /** single-line value with its OWN truncation instead of the
   *  default paragraph wrap — 'middle' keeps a path/ref's distinctive head AND
   *  tail (mid-token char-wrap made long refs unreadable), 'end' keeps the
   *  head. Opt-in per row; rows without it render the exact legacy form. */
  fit?: 'middle' | 'end'
}
export function KeyValueGrid({
  rows,
  keyWidth = 14,
}: {
  rows: KVRow[]
  keyWidth?: number
}): React.ReactNode {
  const t = useMercuryTokens()
  // Column Box so the rows always stack vertically — a bare Fragment of <Text>
  // siblings flows INLINE (row) under a row-context parent, which is wrong.
  return (
    <Box flexDirection="column">
      {rows.map((r, i) =>
        r.fit ? (
          // The fitted form: key and value are sibling layout boxes so the
          // value truncates within its own column (the key is never eaten).
          <Box key={i} flexDirection="row">
            <Box flexShrink={0}>
              <Text color={t.textMuted}>{padTo(r.k, keyWidth)}</Text>
            </Box>
            <Box flexGrow={1}>
              <Text
                color={r.tone ?? t.textPrimary}
                wrap={r.fit === 'middle' ? 'truncate-middle' : 'truncate-end'}
              >
                {r.v}
                {r.note ? <Text color={t.textMuted}> {r.note}</Text> : null}
              </Text>
            </Box>
          </Box>
        ) : (
          <Text key={i}>
            <Text color={t.textMuted}>{padTo(r.k, keyWidth)}</Text>
            <Text color={r.tone ?? t.textPrimary}>{r.v}</Text>
            {r.note ? <Text color={t.textMuted}> {r.note}</Text> : null}
          </Text>
        ),
      )}
    </Box>
  )
}

// A gauge: `█×filled ░×rest`, auto-toned on the 80/95 ramp unless `tone` forces
// it. `showPct` appends the integer percent in the bar colour.
export function ProgressBar({
  value,
  max = 100,
  width = 5,
  tone,
  showPct = false,
}: {
  value: number
  max?: number
  width?: number
  tone?: string
  showPct?: boolean
}): React.ReactNode {
  const t = useMercuryTokens()
  // Narrow-geometry floor: a width derived from live terminal columns can go
  // negative or non-finite on tiny terminals — the track renders empty then,
  // never throws in the repeats below.
  width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0
  // Guard a non-finite value (NaN/Infinity from a bad upstream) so the bar can
  // never render 'NaN%'. The bar WIDTH stays clamped to [0,1], but the LABEL
  // shows the TRUE percent (uncapped) so an over-cap window reads honestly as
  // e.g. '150%' instead of a flat, indistinguishable '100%'.
  const v = Number.isFinite(value) ? value : 0
  const frac = max > 0 ? Math.max(0, Math.min(1, v / max)) : 0
  const pct = max > 0 ? Math.round((Math.max(0, v) / max) * 100) : 0
  // Sparkline's ratified principle, applied to the gauge (visual audit: a 12%
  // window rendered a fully-EMPTY 4-cell track — round(0.48)=0): any positive
  // fill paints ≥1 cell, and the bar reads FULL only at 100% (a 96% at width 4
  // rounded to all-full, overstating). Width-1 bars keep plain rounding.
  let filled = Math.max(0, Math.min(width, Math.round(frac * width)))
  if (width > 1) {
    if (frac > 0 && filled === 0) filled = 1
    if (frac < 1 && filled === width) filled = width - 1
  }
  const color = tone ?? gaugeColorOf(t, pct)
  // SPECTRAL DEPTH. The filled track
  // steps through a bounded, contrast-floored ramp instead of one flat hue, so
  // a gauge reads as depth rather than a block — the terminal-native middle
  // ground the doctrine now allows. Every stop is legible against this
  // family's own ground, the ramp is computed once and memoized, and it is
  // STATIC: no timer, no repaint, no continued writes.
  //
  // Where the family cannot host depth (16-color, no-color) the ramp is a
  // single stop and this renders exactly as it always did — and the meaning
  // never rode the colour anyway: the FILL LENGTH is the state.
  const ramp = spectralRampFor(color, t.surface0)
  const flat = ramp.length === 1
  return (
    <Text>
      {flat ? (
        <Text color={color}>{GLYPH.barFull.repeat(filled)}</Text>
      ) : (
        [...Array(filled)].map((_, i) => (
          <Text
            key={i}
            color={ramp[Math.min(ramp.length - 1, Math.floor((i * ramp.length) / Math.max(1, width)))]}
          >
            {GLYPH.barFull}
          </Text>
        ))
      )}
      <Text color={t.textMuted}>{GLYPH.barEmpty.repeat(width - filled)}</Text>
      {showPct ? <Text color={color}> {pct}%</Text> : null}
    </Text>
  )
}

// A unicode sparkline over the SPARK ramp (▁▂▃▄▅▆▇█). Maps each value to a ramp
// cell scaled to `max` (or the series max): 0 ⇒ the ▁ baseline, any positive bin
// ⇒ at least ▂ so activity always reads. Pure presentation — the caller bins the
// data (e.g. aggregateVelocity). Defaults to the live identity accent.
export function Sparkline({
  values,
  color,
  max,
}: {
  values: number[]
  color?: string
  max?: number
}): React.ReactNode {
  const t = useMercuryTokens()
  const hi = max ?? values.reduce((m, v) => Math.max(m, v), 0)
  const cells = values
    .map(v => {
      if (!(v > 0)) return SPARK[0]
      if (hi <= 0) return SPARK[0]
      const idx = Math.max(1, Math.min(SPARK.length - 1, Math.round((v / hi) * (SPARK.length - 1))))
      return SPARK[idx]
    })
    .join('')
  // Data ink defaults to the INFO channel, not identity red: a
  // sparkline is information — series with a real state meaning pass their
  // own success/warning color.
  return <Text color={color ?? t.info}>{cells}</Text>
}

// A command row `❯ /cmd hint`. Live → TERRA caret + primary-ink command; disabled →
// muted-ink caret/command + an warning reason tail (gated/unavailable/planned why).
export function CommandRow({
  command,
  hint,
  disabled = false,
  reason,
}: {
  command: string
  hint?: string
  disabled?: boolean
  reason?: string
}): React.ReactNode {
  const t = useMercuryTokens()
  return (
    <Text>
      <Text color={disabled ? t.textMuted : t.accent}>{GLYPH.prompt} </Text>
      <Text color={disabled ? t.textMuted : t.textPrimary}>{command}</Text>
      {hint ? <Text color={t.textMuted}> {hint}</Text> : null}
      {disabled && reason ? <Text color={t.warning}> {reason}</Text> : null}
    </Text>
  )
}

// --- feedback / empty -------------------------------------------------------

// Honest dormant/off/gated note: a glyph + a secondary-ink title + a muted-ink enable hint.
export function EmptyState({
  title,
  hint,
  glyph,
  tone = 'idle',
}: {
  title: string
  hint?: string
  glyph?: string
  tone?: 'idle' | 'gated' | 'danger'
}): React.ReactNode {
  const t = useMercuryTokens()
  const color = tone === 'danger' ? t.failure : tone === 'gated' ? t.warning : t.textMuted
  // the default glyph follows the tone (✕ danger · ▲ gated · ○ idle) so
  // the state reads WITHOUT color too (a11y / NO_COLOR terminals); an explicit
  // glyph prop still overrides.
  const g =
    glyph ??
    (tone === 'danger' ? GLYPH.fail : tone === 'gated' ? GLYPH.warn : GLYPH.pending)
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={color}>{g} </Text>
        <Text color={t.textSecondary}>{title}</Text>
      </Text>
      {hint ? <Text color={t.textMuted}>{hint}</Text> : null}
    </Box>
  )
}

// A bordered attention banner: warn ▲ amber · danger ✕ crimson · info ⟡ OASIS-info.
// (: an informational banner must never resolve to the same
// role as an identity banner — info rides the info channel, not the accent.)
export function WarningBanner({
  tone = 'warn',
  title,
  detail,
}: {
  tone?: 'warn' | 'danger' | 'info'
  title: string
  detail?: string
}): React.ReactNode {
  const t = useMercuryTokens()
  const color = tone === 'danger' ? t.failure : tone === 'info' ? t.info : t.warning
  const glyph = tone === 'danger' ? GLYPH.fail : tone === 'info' ? GLYPH.trace : GLYPH.warn
  return (
    <Box borderStyle="single" borderColor={color} borderTop={false} borderRight={false} borderBottom={false} paddingX={1}>
      <Text>
        <Text bold color={color}>
          {glyph} {title}
        </Text>
        {detail ? <Text color={t.textMuted}> · {detail}</Text> : null}
      </Text>
    </Box>
  )
}

// --- domain rows ------------------------------------------------------------

// One fleet roster row: health glyph + name + `<type>` + state + #tasks.
export function AgentRow({
  name,
  agentType,
  state = 'idle',
  tasks = [],
  maxWidth,
}: {
  name: string
  agentType?: string
  state?: 'busy' | 'idle' | 'drifting' | 'blocked'
  tasks?: string[]
  // optional display-width budget for the NAME cell so a long agent name
  // can't overflow a narrow fleet column. Unset ⇒ unbudgeted (byte-identical).
  maxWidth?: number
}): React.ReactNode {
  const t = useMercuryTokens()
  const map: Record<string, { glyph: string; color: string }> = {
    idle: { glyph: GLYPH.idle, color: t.textMuted },
    busy: { glyph: GLYPH.busy, color: t.success },
    drifting: { glyph: GLYPH.drifting, color: t.warning },
    blocked: { glyph: GLYPH.fail, color: t.failure },
  }
  const g = map[state] ?? map.idle!
  const stateColor = state === 'drifting' ? t.warning : state === 'busy' ? t.success : state === 'blocked' ? t.failure : t.textMuted
  return (
    <Text>
      <Text color={g.color}>{g.glyph} </Text>
      <Text color={t.textPrimary}>{maxWidth !== undefined ? truncateToWidth(name, maxWidth) : name}</Text>
      {agentType ? <Text color={t.textMuted}>{` <${agentType}>`}</Text> : null}
      <Text color={t.textMuted}> · </Text>
      <Text color={stateColor}>{state}</Text>
      {tasks.length > 0 ? (
        <Text color={t.textSecondary}> · {tasks.map(id => `#${id}`).join(', ')}</Text>
      ) : null}
    </Text>
  )
}

// One /trace table row: time · tool · risk · surface · dur · ok-mark.
export function TraceRow({
  time,
  tool,
  risk,
  surface,
  duration,
  ok,
  killed,
  toolWidth = 16,
  surfaceWidth = 14,
}: {
  time: string
  tool: string
  risk?: 'low' | 'medium' | 'high'
  surface?: string
  duration?: string
  ok?: boolean
  killed?: boolean
  toolWidth?: number
  surfaceWidth?: number
}): React.ReactNode {
  const t = useMercuryTokens()
  const riskColor = risk === 'high' ? t.failure : risk === 'medium' ? t.warning : risk === 'low' ? t.success : t.textMuted
  let mark = '·'
  let markColor = t.textMuted
  if (killed) {
    mark = GLYPH.circledSlash
    markColor = t.failure
  } else if (ok === false) {
    mark = GLYPH.fail
    markColor = t.failure
  } else if (ok === true) {
    mark = GLYPH.ok
    markColor = t.success
  }
  return (
    <Text>
      <Text color={t.textMuted}>{time} </Text>
      <Text color={killed ? t.textMuted : t.textPrimary}>{padTo(tool, toolWidth)}</Text>
      <Text color={riskColor}>{padTo(risk ?? '?', 7)}</Text>
      <Text color={t.textSecondary}>{padTo(surface ?? '?', surfaceWidth)}</Text>
      <Text color={t.textMuted}>{padTo(duration ?? '', 7)}</Text>
      <Text color={markColor}>{mark}</Text>
      {killed ? <Text color={t.failure}> killed</Text> : null}
    </Text>
  )
}

// A faint column header + a stack of TraceRow (the /trace + deck activity feed).
export function ActivityFeed({
  events,
  showHeader = true,
}: {
  events: React.ComponentProps<typeof TraceRow>[]
  showHeader?: boolean
}): React.ReactNode {
  const t = useMercuryTokens()
  return (
    <>
      {showHeader ? (
        <Text color={t.textMuted}>
          {padTo('time', 9)}
          {padTo('tool', 16)}
          {padTo('risk', 7)}
          {padTo('surface', 14)}
          {padTo('dur', 7)}
          ok
        </Text>
      ) : null}
      {events.map((e, i) => (
        <TraceRow key={i} {...e} />
      ))}
    </>
  )
}

// One /substrate capability gate row: ●on/○off + padded name + enable hint.
export function GateRow({
  name,
  on,
  hint,
  nameWidth = 27,
  hintWidth,
}: {
  name: string
  on: boolean
  hint?: string
  nameWidth?: number
  hintWidth?: number
}): React.ReactNode {
  const t = useMercuryTokens()
  // Keep at least one space between name and hint (truncate name to nameWidth-1
  // then pad back) and optionally clip the hint so a narrow column never wraps.
  const nm = padTo(truncateToWidth(name, nameWidth - 1), nameWidth)
  const ht = hint ? (hintWidth ? truncateToWidth(hint, hintWidth) : hint) : ''
  return (
    <Text>
      <Text color={on ? t.success : t.textMuted}>{on ? GLYPH.done : GLYPH.pending}</Text>
      <Text> </Text>
      <Text color={on ? t.textPrimary : t.textSecondary}>{nm}</Text>
      {ht ? <Text color={t.textMuted}>{ht}</Text> : null}
    </Text>
  )
}

// A node grid (fullscreen left rail). In Ink, grid → stacked rows: glyph + name
// + muted-ink detail, coloured by the node's state.
export type MapNode = {
  name: string
  state?: SnapshotState
  detail?: string
}
export function SystemMap({
  title,
  nodes,
}: {
  title?: string
  nodes: MapNode[]
}): React.ReactNode {
  const t = useMercuryTokens()
  return (
    <Box flexDirection="column">
      {title ? <Heading>{title}</Heading> : null}
      {nodes.map((n, i) => {
        const s = stateStyleOf(t, n.state ?? 'off')
        return (
          <Text key={i}>
            <Text color={s.color}>{s.glyph} </Text>
            <Text color={n.state === 'off' ? t.textSecondary : t.textPrimary}>{n.name}</Text>
            {n.detail ? <Text color={t.textMuted}> · {truncateToWidth(n.detail, 28)}</Text> : null}
          </Text>
        )
      })}
    </Box>
  )
}

// A usage-quota row (5h/7d): label + bar + percent + reset tail. State carries
// the honest unavailable/gated case instead of a fake bar. `compact` returns the
// MercuryFrame chip form (`5h ██░░ 58%`, no reset tail); the honest empty/gated
// chip is `5h —` (faint) / `5h ⦿` (amber) — never a fake 0% bar. `numberOnly`
// (compact only) drops the mini-gauge and keeps just `5h 58%` for the tight
// 80-col collapse step.
export function UsageMeter({
  window,
  value,
  max = 100,
  resetIn,
  state = 'live',
  hint,
  labelWidth = 4,
  compact = false,
  numberOnly = false,
}: {
  window: string
  value?: number
  max?: number
  resetIn?: string
  state?: SnapshotState
  hint?: string
  labelWidth?: number
  compact?: boolean
  numberOnly?: boolean
}): React.ReactNode {
  const t = useMercuryTokens()
  if (compact) {
    // Honest empty/gated: the state glyph, never a 0% bar.
    if (state !== 'live' || !Number.isFinite(value)) {
      const s = stateStyleOf(t, state === 'live' ? 'unavailable' : state)
      return (
        <Text>
          <Text color={t.textMuted}>{window} </Text>
          <Text color={s.color}>{s.glyph}</Text>
        </Text>
      )
    }
    // Over-cap honest: don't clamp the LABEL to max — a 150%-utilization window
    // reads as '150%' (crimson), not an indistinguishable '100%'. (value is
    // finite here, guarded above; the gauge bar still clamps its width.)
    const pct = Math.round((Math.max(0, value as number) / max) * 100)
    // numberOnly: drop the mini-gauge, keep the number (tightest non-omitted
    // step). The percent stays auto-toned so the limit pressure still reads.
    if (numberOnly) {
      return (
        <Text>
          <Text color={t.textMuted}>{window} </Text>
          <Text color={gaugeColorOf(t, pct)}>{pct}%</Text>
          {resetIn ? <Text color={t.textMuted}> {resetIn}</Text> : null}
        </Text>
      )
    }
    // ok chip: mini-gauge (width 4, auto-toned — DON'T pass a tone) + faint NN%
    // + a faint reset countdown (how long until the window clears).
    return (
      <Text>
        <Text color={t.textMuted}>{window} </Text>
        <ProgressBar value={value as number} max={max} width={4} showPct={false} />
        <Text color={t.textMuted}> {pct}%</Text>
        {resetIn ? <Text color={t.textMuted}> {resetIn}</Text> : null}
      </Text>
    )
  }
  if (state !== 'live' || !Number.isFinite(value)) {
    const s = stateStyleOf(t, state === 'live' ? 'unavailable' : state)
    return (
      <Text>
        <Text color={t.textMuted}>{padTo(window, labelWidth)} </Text>
        <Text color={s.color}>{s.glyph} </Text>
        <Text color={t.textSecondary}>{hint ?? s.label}</Text>
      </Text>
    )
  }
  return (
    <Text>
      <Text color={t.textMuted}>{padTo(window, labelWidth)} </Text>
      <ProgressBar value={value as number} max={max} width={8} showPct />
      {resetIn ? <Text color={t.textMuted}> · resets {resetIn}</Text> : null}
    </Text>
  )
}
