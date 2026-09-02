// ============================================================================
//  EffortSlider — what a bare /effort opens.
//
//  A horizontal rail of triangle stops, one per effort tier. ←/→ walk the
//  stops (tiers outside the model's ladder are skipped), ↵ commits through
//  the injected applier, and esc closes while reporting the level that is
//  actually in force. Typing `/effort <level>` bypasses this component
//  entirely — that path stays textual.
//
//  Honesty invariants:
//    • no stop for a tier the model cannot run. Availability of the
//      supercode extension follows the max-support predicate — the SAME
//      check the commit path applies, so nothing selectable here is ever
//      refused there — and each base tier is marked present or absent from
//      the resolver's own vocabulary;
//    • one fixed grid for every model. Absence shows as bare rail in the
//      tier's columns, never as a re-layout;
//    • the slider OPENS on the tier the session actually runs — the same
//      applied resolve the status-line chip paints (resolveOpeningStop),
//      so the two gauges can never disagree about one session.
//
//  Motion design, supercode stop selected: a single luminous pass travels
//  the extension rail left to right, printing code glyphs that fade from
//  IVORY through BELLY to TERRA and leaving CLAW behind as the powered
//  steady state. The word "supercode" itself is never drawn over — it
//  borrows the xhigh label's warm shimmer instead. With reduced motion or
//  NO_COLOR the rail simply appears already-powered. Palette tokens only;
//  width-1 cells only, so 80- and 120-column layouts agree.
// ============================================================================

import * as React from 'react'
import { Box, Text, useAnimationFrame, useInput } from '../../ink.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { useAppState } from '../../state/AppState.js'
import type { AppState } from '../../state/AppState.js'
import type { EffortValue } from '../../utils/effort.js'
import { useOpenEventGate } from '../../components/mercury-ui/useOpenEventGate.js'
import {
  effortFamiliesLabel,
  getDisplayedEffortLabel,
  getDisplayedEffortLevel,
  modelSupportsMaxEffort,
  modelSupportsXHighEffort,
  selectableEffortLevels,
} from '../../utils/effort.js'
import {
  AMBER,
  BELLY,
  CLAW,
  FAINT,
  IVORY,
  SECOND,
  TEAL,
  TERRA,
} from '../../components/mercuryPalette.js'
import { displayWidth } from '../../components/mercury-ui/glyphs.js'
import { useSessionAccent } from '../../components/mercury-ui/sessionAccent.js'
import { interpolateColor, toRGBColor } from '../../components/Spinner/utils.js'
import { CHALK_DISABLED_FOR_NO_COLOR } from '../../ink/colorize.js'
import { useSettings } from '../../hooks/useSettings.js'

// ---------------------------------------------------------------------------
//  Geometry. The integers ARE the layout — track width, stop columns, label
//  gaps were tuned together; adjusting one reflows the whole grid.
// ---------------------------------------------------------------------------
const TRACK_WIDTH = 42
const STOP_COLUMNS = [1, 10, 20, 30, 40] // one triangle per base tier
const LABEL_GAPS = [5, 5, 5, 6] // spaces between adjacent base labels
// The parking slot when NO stop can answer (an empty ladder, an override
// naming a tier the grid lacks). The session path never reaches it: the
// opening tier is always the applied resolve, which is always a real level.
const PREFERRED_SLOT = 3

// Per-tier color treatment tags. The render layer resolves each to a warm-ink
// look; the tag vocabulary is observable through getSliderGeometry.
type Treatment =
  | 'amber'
  | 'teal'
  | 'accent'
  | 'shimmer'
  | 'rainbow'
  | 'code-trace'

type SliderLevel = {
  value: EffortValue | 'supercode'
  label: string
  treatment: Treatment
  /** false ⇒ this tier is not in the model's resolved vocabulary — the stop
   *  renders absent (plain track, blank label) and navigation skips it. */
  supported: boolean
}

// The five base tiers, Faster → Smarter. `supported` is stamped per model in
// getSliderGeometry from the effort resolution owner's vocabulary.
const BASE_TIERS: Omit<SliderLevel, 'supported'>[] = [
  { value: 'low', label: 'low', treatment: 'amber' },
  { value: 'medium', label: 'medium', treatment: 'teal' },
  { value: 'high', label: 'high', treatment: 'accent' },
  { value: 'xhigh', label: 'xhigh', treatment: 'shimmer' },
  { value: 'max', label: 'max', treatment: 'rainbow' },
]

/** Column where each label begins: the running sum of label widths + gaps. */
function computeLabelStarts(levels: SliderLevel[], gaps: number[]): number[] {
  return levels.map((_lvl, i) =>
    levels
      .slice(0, i)
      .reduce((acc, l, j) => acc + l.label.length + (gaps[j] ?? 0), 0),
  )
}

type SliderGeometry = {
  levels: SliderLevel[]
  width: number
  trianglePositions: number[]
  labelStarts: number[]
  spacers: number[]
  trackChars: string
  accentStart?: number
  sublabel?: { text: string; start: number }
}

/**
 * The complete grid for a model: tiers (with per-model support stamped),
 * stop columns, label columns, and the track characters. The supercode
 * extension exists iff the model supports MAX effort — supercode pins max,
 * so gating on anything weaker would advertise a stop that apply refuses.
 * Exported so behavior-level assertions can pin the stop set per model.
 */
export function getSliderGeometry(model: string): SliderGeometry {
  const vocabulary = new Set<string>(selectableEffortLevels(model))
  const base: SliderLevel[] = BASE_TIERS.map(tier => ({
    ...tier,
    supported: vocabulary.has(String(tier.value)),
  }))
  if (modelSupportsMaxEffort(model)) {
    const ultraStop = TRACK_WIDTH + 3
    const levels: SliderLevel[] = [
      ...base,
      { value: 'supercode', label: 'supercode', treatment: 'code-trace', supported: true },
    ]
    const sublabelStart = ultraStop + 4
    const spacers = [...LABEL_GAPS, sublabelStart - TRACK_WIDTH]
    return {
      levels,
      width: ultraStop + 17,
      trianglePositions: [...STOP_COLUMNS, ultraStop + 8],
      labelStarts: computeLabelStarts(levels, spacers),
      spacers,
      // base run ── , dotted junction ┆ , then the supercode extension.
      trackChars: '─'.repeat(TRACK_WIDTH + 1) + '┆' + '─'.repeat(18),
      accentStart: TRACK_WIDTH + 2,
      sublabel: { text: 'max + workflows', start: ultraStop },
    }
  }
  return {
    levels: base,
    width: TRACK_WIDTH,
    trianglePositions: STOP_COLUMNS,
    labelStarts: computeLabelStarts(base, LABEL_GAPS),
    spacers: LABEL_GAPS,
    trackChars: '─'.repeat(TRACK_WIDTH),
  }
}

/**
 * Which stop the slider opens on, given an already-resolved tier. Supercode
 * is consulted FIRST — it pins effortValue to max, so consulting effortValue
 * first would land on the max stop and misreport a supercode session. The
 * preferred-slot fallback serves only a grid with no supported stops or an
 * override the grid lacks — resolveOpeningStop always hands the session
 * path a real applied level.
 */
function openingSlot(
  levels: SliderLevel[],
  supercode: boolean | undefined,
  effortValue: EffortValue | undefined,
): number {
  if (supercode) {
    const slot = levels.findIndex(l => l.value === 'supercode' && l.supported)
    if (slot >= 0) return slot
  }
  if (typeof effortValue === 'string') {
    const slot = levels.findIndex(l => l.value === effortValue && l.supported)
    if (slot >= 0) return slot
  }
  const preferred = Math.min(PREFERRED_SLOT, levels.length - 1)
  for (let i = preferred; i >= 0; i--) {
    if (levels[i]?.supported) return i
  }
  for (let i = preferred + 1; i < levels.length; i++) {
    if (levels[i]?.supported) return i
  }
  return preferred
}

/**
 * THE OPENING TRUTH (the lying-gauge law): the slider opens on the SAME
 * tier the status-line chip paints. For a session mount that is the
 * applied resolve — getDisplayedEffortLevel over the one effort owner, env
 * pin, model default and step-down included — never the raw stored value
 * (which can sit above the model's ladder or below an env pin) and never a
 * fixed preferred slot: both of those opened the gauge on a tier the
 * session was not running, and the two surfaces disagreed about the SAME
 * session (the status line said high while the slider presented xhigh).
 * An override target opens on the override verbatim — that agent's own
 * recorded tier; this process's env pin must not leak into it. Exported so
 * behavior-level assertions compose the chip and the slider from one
 * session state and pin agreement across the whole ladder.
 */
export function resolveOpeningStop(
  model: string,
  supercode: boolean | undefined,
  sessionEffortValue: EffortValue | undefined,
  initialEffortOverride?: EffortValue,
): number {
  const geo = getSliderGeometry(model)
  if (initialEffortOverride !== undefined) {
    return openingSlot(geo.levels, false, initialEffortOverride)
  }
  return openingSlot(geo.levels, supercode, getDisplayedEffortLevel(model, sessionEffortValue))
}

// ---------------------------------------------------------------------------
//  Animated label treatments. Both read the shared animation clock, and the
//  clock parks itself offscreen — an unmounted slider spends zero frames.
// ---------------------------------------------------------------------------

type RGB = { r: number; g: number; b: number }

// Working RGB structs come from the palette HEX tokens — one source of truth
// for the brand colors, no channel bytes to drift.
function parseHexChannels(hex: string): RGB {
  const h = hex.replace('#', '')
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  }
}
const RGB_TERRA: RGB = parseHexChannels(TERRA)
const RGB_CLAW: RGB = parseHexChannels(CLAW)
const RGB_BELLY: RGB = parseHexChannels(BELLY)
const RGB_AMBER: RGB = parseHexChannels(AMBER)
const RGB_IVORY: RGB = parseHexChannels(IVORY)

/**
 * The xhigh treatment: characters breathe between BELLY and IVORY, each one
 * a phase step behind its neighbor — which reads as a warm highlight
 * gliding along the word.
 */
function BreathingLabel({
  text,
  active,
  time,
  bold,
}: {
  text: string
  active: boolean
  time: number
  bold?: boolean
}): React.ReactNode {
  if (!active) {
    return (
      <Text color={BELLY} bold={bold}>
        {text}
      </Text>
    )
  }
  const chars = [...text]
  return (
    <Text bold={bold}>
      {chars.map((ch, i) => {
        const phase = (time / 90 - i * 0.6) % (Math.PI * 2)
        const t = (1 + Math.cos(phase)) / 2
        const c = interpolateColor(RGB_BELLY, RGB_IVORY, t)
        return (
          <Text key={i} color={toRGBColor(c)}>
            {ch}
          </Text>
        )
      })}
    </Text>
  )
}

// The max treatment cycles hue through Mercury's own warm band only —
// CLAW→TERRA→BELLY→AMBER→CLAW — so it reads as a shimmering ember, never a
// cool spectrum sweep. Zero new hex; every stop is a token.
const EMBER_RING: RGB[] = [RGB_CLAW, RGB_TERRA, RGB_BELLY, RGB_AMBER]

function emberAt(pos: number): string {
  const n = EMBER_RING.length
  const f = ((pos % n) + n) % n
  const lo = Math.floor(f)
  const hi = (lo + 1) % n
  return toRGBColor(interpolateColor(EMBER_RING[lo]!, EMBER_RING[hi]!, f - lo))
}

function EmberLabel({
  text,
  active,
  time,
  bold,
}: {
  text: string
  active: boolean
  time: number
  bold?: boolean
}): React.ReactNode {
  if (!active) {
    return (
      <Text color={TERRA} bold={bold}>
        {text}
      </Text>
    )
  }
  const drift = time / 140
  return (
    <Text bold={bold}>
      {[...text].map((ch, i) => (
        <Text key={i} color={emberAt(drift + i * 0.5)}>
          {ch}
        </Text>
      ))}
    </Text>
  )
}

// ---------------------------------------------------------------------------
//  The code-trace sweep over the supercode extension. Glyph vocabulary is
//  width-1 ASCII only; one head crossing ~18 cells at 30ms/cell ≈ 540ms.
// ---------------------------------------------------------------------------
const CODE_TRACE_GLYPHS = '{}();=<>+*#$_/|'
const TRACE_MS_PER_CELL = 30

/** One track cell of the powered extension, colored by distance behind the
 *  sweeping head: head (ivory glyph) → cooling (belly glyph) → warm line
 *  (terra) → settled rail (claw); cells ahead of the head stay dim. */
function extensionCell(
  col: number,
  trackChar: string,
  traceHead: number,
): React.ReactNode {
  const d = traceHead - col
  const glyph = CODE_TRACE_GLYPHS[(col * 7) % CODE_TRACE_GLYPHS.length]
  if (d >= 0 && d <= 1) {
    return (
      <Text key={col} color={IVORY} bold>
        {glyph}
      </Text>
    )
  }
  if (d >= 2 && d <= 4) {
    return (
      <Text key={col} color={BELLY}>
        {glyph}
      </Text>
    )
  }
  if (d >= 5 && d <= 7) {
    return (
      <Text key={col} color={TERRA}>
        {trackChar}
      </Text>
    )
  }
  if (d > 7) {
    return (
      <Text key={col} color={CLAW}>
        {trackChar}
      </Text>
    )
  }
  return (
    <Text key={col} color={FAINT} dimColor>
      {trackChar}
    </Text>
  )
}

// ---------------------------------------------------------------------------
//  The slider.
// ---------------------------------------------------------------------------

export function EffortSlider({
  onDone,
  modelOverride,
  initialEffortOverride,
}: {
  onDone: (message: string) => void
  /**
   * Point the slider at another agent entirely: stop availability follows
   * THAT agent's model, and `initialEffortOverride` supplies the opening
   * position, with the foreground session's own state ignored on both
   * counts.
   */
  modelOverride?: string
  initialEffortOverride?: EffortValue
}): React.ReactNode {
  const sessionModel = useMainLoopModel()
  const model = modelOverride ?? sessionModel
  const { accent } = useSessionAccent()

  // Geometry is a pure function of the model; memoize so the label columns
  // aren't recomputed on every animation tick.
  const geo = React.useMemo(() => getSliderGeometry(model), [model])

  // Opening position mirrors what is ACTUALLY in force — the applied
  // resolve the chip paints (resolveOpeningStop) — so a second /effort
  // lands where the session really runs. With an override target the
  // mirrored state is the target's, not the session's. effortValue keeps
  // the raw pair for the esc answer below (initialEffortOverride ?? sessionEffortValue).
  const supercode = useAppState((s: AppState) => s.supercode)
  const sessionEffortValue = useAppState((s: AppState) => s.effortValue)
  const effortValue = initialEffortOverride ?? sessionEffortValue

  const [selected, setSelected] = React.useState(() =>
    resolveOpeningStop(model, supercode, sessionEffortValue, initialEffortOverride),
  )

  // The keystroke that LAUNCHED /effort must not immediately confirm. The
  // gate is event-identity (the input-event sequence number at mount), so
  // only ↵ waits — esc and the arrows respond instantly, and no later key is
  // ever swallowed.
  const pastOpenEvent = useOpenEventGate()

  const level = geo.levels[selected]
  const onSupercode = level?.value === 'supercode'

  // The sweep respects reduced motion and the no-color gate: gated means the
  // extension renders fully settled (still honest — same end state).
  const sweepGated =
    (useSettings().prefersReducedMotion ?? false) || CHALK_DISABLED_FOR_NO_COLOR

  // One shared clock at ~30fps drives the shimmer, the ember cycle, and the
  // trace; null after confirm/cancel releases it entirely.
  const [done, setDone] = React.useState(false)
  const [animRef, time] = useAnimationFrame(done ? null : 33)

  // The trace restarts from the junction each time selection re-enters the
  // supercode stop: capture the clock value on the entry edge only.
  const sweepOriginRef = React.useRef<number | null>(null)
  React.useEffect(() => {
    sweepOriginRef.current = onSupercode ? time : null
    // re-arm on the boolean edge only, never per tick
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSupercode])
  const sweepTime =
    onSupercode && sweepOriginRef.current != null
      ? Math.max(0, time - sweepOriginRef.current)
      : 0

  // Applying goes through the applier injected by the /effort command owner —
  // this component stays a pure view (no AppState writes, no messaging).
  const apply = React.useContext(EffortApplyContext)

  const finish = React.useCallback(
    (msg: string) => {
      setDone(true) // releases the shared clock
      onDone(msg)
    },
    [onDone],
  )

  // One step in `dir`, landing only on stops that exist for this model —
  // absent tiers are walked straight through, ends clamp.
  const slide = React.useCallback(
    (from: number, dir: -1 | 1): number => {
      let next = from + dir
      while (next >= 0 && next < geo.levels.length && !geo.levels[next]?.supported) {
        next += dir
      }
      return next >= 0 && next < geo.levels.length ? next : from
    },
    [geo.levels],
  )

  useInput(
    (_input, key) => {
      if (done) return
      if (key.escape) {
        // Cancel still answers "what is it now?" — the label is the truthful
        // applied level, with the supercode marker when it is engaged.
        finish(
          `Effort unchanged (${supercode ? 'supercode · ' : ''}${getDisplayedEffortLabel(model, effortValue)})`,
        )
        return
      }
      if (key.leftArrow) {
        setSelected(s => slide(s, -1))
        return
      }
      if (key.rightArrow) {
        setSelected(s => slide(s, 1))
        return
      }
      if (!pastOpenEvent()) return
      if (key.return) {
        const chosen = geo.levels[selected]
        if (!chosen) return
        finish(apply(chosen.value))
        return
      }
    },
    { isActive: !done },
  )

  // Where the sweep head sits this frame. No sweep (gated, or not on the
  // supercode stop) parks the head at +∞ so every extension cell reads
  // settled.
  const traceHead =
    onSupercode && !sweepGated
      ? (geo.accentStart ?? 0) + Math.floor(sweepTime / TRACE_MS_PER_CELL)
      : Number.MAX_SAFE_INTEGER

  // --- the track row: ── with triangle stops; selected stop = ▲ ------------
  const trackCells: React.ReactNode[] = []
  for (let col = 0; col < geo.width; col++) {
    const stopIdx = geo.trianglePositions.indexOf(col)
    if (stopIdx >= 0 && !geo.levels[stopIdx]?.supported) {
      // An absent tier: plain track, no triangle — the stop does not exist
      // for this model.
      trackCells.push(
        <Text key={col} color={FAINT} dimColor>
          {geo.trackChars[col] ?? ' '}
        </Text>,
      )
      continue
    }
    if (stopIdx >= 0) {
      const isSel = stopIdx === selected
      const isUltra = geo.levels[stopIdx]?.value === 'supercode'
      trackCells.push(
        <Text key={col} color={isSel ? (isUltra ? BELLY : accent) : FAINT} bold={isSel}>
          {isSel ? '▲' : '△'}
        </Text>,
      )
      continue
    }
    const ch = geo.trackChars[col] ?? ' '
    if (onSupercode && geo.accentStart != null && col >= geo.accentStart) {
      trackCells.push(extensionCell(col, ch, traceHead))
      continue
    }
    if (onSupercode && ch === '┆') {
      // The junction lights with the powered extension; the base run stays
      // dim, so the circuit reads energized past the junction only.
      trackCells.push(
        <Text key={col} color={BELLY} bold>
          {ch}
        </Text>,
      )
      continue
    }
    trackCells.push(
      <Text key={col} color={FAINT} dimColor>
        {ch}
      </Text>,
    )
  }

  return (
    <Box flexDirection="column" ref={animRef} marginY={1}>
      {/* heading: Faster ←→ Smarter */}
      <Box marginBottom={1}>
        <Text color={FAINT}>Faster </Text>
        <Text color={FAINT}>{'◀\uFE0E '}</Text>
        <Text color={SECOND}>effort</Text>
        <Text color={FAINT}>{' ▶\uFE0E'}</Text>
        <Text color={FAINT}> Smarter</Text>
      </Box>

      {/* track */}
      <Box>
        <Text>{trackCells}</Text>
      </Box>

      {/* tier words at their fixed columns; the sweep animation belongs to
          the rail row above and stays off these words */}
      <Box>
        <TierWords geo={geo} selected={selected} accent={accent} time={time} />
      </Box>

      {/* the extension stop's caption line */}
      {geo.sublabel ? (
        <Box>
          <Text>{' '.repeat(geo.sublabel.start)}</Text>
          <Text color={FAINT} dimColor>
            {geo.sublabel.text}
          </Text>
        </Box>
      ) : null}

      {/* one-line summary of the highlighted tier, then the key legend */}
      <Box marginTop={1}>
        <Text color={SECOND}>{tierSummary(level)}</Text>
      </Box>
      <Box>
        <Text color={FAINT}>←/→ adjust · ↵ apply · esc cancel</Text>
      </Box>
    </Box>
  )
}

/** The label row: gaps to each label column, then the treatment-colored word.
 *  Absent tiers keep their column budget (blank of the same width) so the
 *  grid never reflows across models. */
function TierWords({
  geo,
  selected,
  accent,
  time,
}: {
  geo: SliderGeometry
  selected: number
  accent: string
  time: number
}): React.ReactNode {
  const cells: React.ReactNode[] = []
  let col = 0
  geo.levels.forEach((tier, i) => {
    const start = geo.labelStarts[i] ?? 0
    if (start > col) {
      cells.push(<Text key={`gap-${i}`}>{' '.repeat(start - col)}</Text>)
      col = start
    }
    if (!tier.supported) {
      cells.push(
        <Text key={`lbl-${i}`}>{' '.repeat(displayWidth(tier.label))}</Text>,
      )
      col += displayWidth(tier.label)
      return
    }
    cells.push(
      <TierWord
        key={`lbl-${i}`}
        tier={tier}
        selected={i === selected}
        accent={accent}
        time={time}
      />,
    )
    col += displayWidth(tier.label)
  })
  return <Text>{cells}</Text>
}

/** One tier word, resolved from its treatment tag. */
function TierWord({
  tier,
  selected,
  accent,
  time,
}: {
  tier: SliderLevel
  selected: boolean
  accent: string
  time: number
}): React.ReactNode {
  const bold = selected
  switch (tier.treatment) {
    case 'amber':
      return (
        <Text color={selected ? AMBER : FAINT} bold={bold} dimColor={!selected}>
          {tier.label}
        </Text>
      )
    case 'teal':
      return (
        <Text color={selected ? TEAL : FAINT} bold={bold} dimColor={!selected}>
          {tier.label}
        </Text>
      )
    case 'accent':
      return (
        <Text color={selected ? accent : FAINT} bold={bold} dimColor={!selected}>
          {tier.label}
        </Text>
      )
    case 'shimmer':
      return (
        <BreathingLabel text={tier.label} active={selected} time={time} bold={bold} />
      )
    case 'rainbow':
      return <EmberLabel text={tier.label} active={selected} time={time} bold={bold} />
    case 'code-trace':
      // While selected, this word borrows the xhigh breathing treatment;
      // its own sweep effect belongs to the rail row and stays there.
      return selected ? (
        <BreathingLabel text={tier.label} active time={time} bold={bold} />
      ) : (
        <Text color={FAINT} dimColor>
          {tier.label}
        </Text>
      )
    default:
      return <Text dimColor>{tier.label}</Text>
  }
}

/** One-line summary of the highlighted tier. For xhigh, the model-family
 *  note is computed from the availability predicate itself — a hand-kept
 *  list would rot every time the catalog moves. */
function tierSummary(level: SliderLevel | undefined): string {
  switch (level?.value) {
    case 'low':
      return 'low — quick, straightforward implementation'
    case 'medium':
      return 'medium — balanced approach with standard testing'
    case 'high':
      return 'high — comprehensive implementation with extensive testing'
    case 'xhigh': {
      const families = effortFamiliesLabel(modelSupportsXHighEffort)
      return `xhigh — extra-high reasoning depth${families ? ` (${families})` : ''}`
    }
    case 'max':
      return 'max — maximum capability with the deepest reasoning'
    case 'supercode':
      return 'supercode — max + standing dynamic-orchestration (session-only)'
    default:
      return ''
  }
}

// The applier is injected by the /effort command owner, which owns messaging
// and AppState mutation; the return value is the user-facing confirmation.
export type EffortApplier = (value: EffortValue | 'supercode') => string
export const EffortApplyContext = React.createContext<EffortApplier>(() => '')
