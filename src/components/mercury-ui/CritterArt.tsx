import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { applyGazeKey } from '../../utils/cockpit/critterGaze.js'
import {
  cellColor,
  CR_COLS,
  EYE_BG,
  flowDepthFor,
  heroBlinkRows,
  heroContentBounds,
  PUPIL,
  settleDepthFor,
  settleRows,
  SLEEP_CELL,
  sleepBreathArt,
  sleepGlyphAt,
  sleepGlyphsFor,
  sleepPoseFor,
  sleepSlotCountFor,
  sleepZzzArt,
  sleepZzzSlots,
  swayRows,
  type CritterDef,
} from '../../utils/cockpit/critterData.js'

// ============================================================================
//  mercury-ui/CritterArt — the ONE shared half-block renderer for a critter's
//  authored grids. One shared loop, so the big logo, the home splash, the
//  berth, the picker cards and the concourse mark all draw the active critter
//  IDENTICALLY.
//
//  Two rows of the grid are drawn per terminal line via the half-block ▀ (with a
//  background fill): top cell → foreground, bottom cell → background. The eye
//  (a P-over-P column pair) is an ivory cell with an oasis-blue pupil GLYPH —
//  the launch-splash iris look — painted BEFORE cellColor runs.
//
//  Live morph lives in WHICH def is passed: a parent reads
//  critterDefForKey(useSessionAccent().key) and the shape + hue both follow the
//  session critter. CritterArt itself is pure-from-def (crab's def.hue IS the
//  TERRA token, so it even tracks a future TERRA retint).
//
//  THE FRAME CACHE. A frame is a pure function of the def, the form, the
//  pupil glyph, the sway/sleep phases, the gaze key and the paint context
//  (hue pair, legend re-binding, bloom, width) — and consecutive edges of
//  the shared clock repaint mostly the SAME cells: a sway step moves the
//  strand lines and nothing above them, a blink touches the eye line, a
//  still critter's sway digit moves nothing at all. Every rendered LINE is
//  therefore cached by its content under the paint context it was painted
//  in, and a frame whose lines all match hands React the SAME root element
//  it committed last time. React's reconciler bails on an element it has
//  already committed (identical props by identity), so an edge that moves
//  nothing costs the bail alone, and an edge that moves the strands
//  reconciles the moving lines only. The cache is keyed by the def object
//  (the mounts hand the painter a stable def — the def-identity rule), is
//  bounded per paint context, and holds React elements, which are immutable
//  descriptions and safe to reuse across commits. Output is byte-identical
//  to a cache-less render by construction: a hit IS the element the same
//  inputs would rebuild.
// ============================================================================

function cellAt(art: string[], r: number, c: number): string {
  return art[r]?.[c] ?? '.'
}

// MAIN-HEADER GLOW: the strongest blend a glowing
// grid's right edge reaches toward the bloom — capped so the authored structure
// (body/outline/belly contrast) still reads at every column.
const GLOW_MAX = 0.6

/** Mix a painted ink toward the tokens-derived bloom; an unparseable ink (a
 *  named/ansi colour) returns unchanged — this renderer never invents a hue
 *  it wasn't handed (the focal-ramp law). */
function glowMix(base: string, toward: string, t: number): string {
  const p = (c: string): [number, number, number] | null => {
    const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(c)
    return m ? [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)] : null
  }
  const a = p(base)
  const b = p(toward)
  if (!a || !b) return base
  const ch = (x: number, y: number): string =>
    Math.max(0, Math.min(255, Math.round(x + (y - x) * t)))
      .toString(16)
      .padStart(2, '0')
  return `#${ch(a[0], b[0])}${ch(a[1], b[1])}${ch(a[2], b[2])}`
}

// ── the frame cache ──────────────────────────────────────────────────────────

/** One paint context's cache: the rendered lines by content, the last
 *  frames' roots by their full key. */
type FrameCache = {
  lines: Map<string, React.ReactElement>
  roots: Map<string, React.ReactElement>
}

/** Every line a paint context can show across a whole sway + sleep cycle
 *  sits well under this (the flowing hero: ~9 resting lines + 4 moving
 *  lines × 7 further phases + the blink line + the sleep pose's lines ≈ 55);
 *  past it the context is cold-started rather than grown without bound. */
const LINES_MAX = 96
/** Whole-frame roots kept per context — the cycle's distinct frames (a
 *  flowing hero: SWAY_PHASES awake frames, each open- or lid-eyed, plus
 *  SLEEP_PHASES × SWAY_PHASES sleeping ones = 40); a root is one Box element
 *  over the shared lines, so the cap is generous; past it the roots restart. */
const ROOTS_MAX = 48
/** Paint contexts kept per def object — a def is painted in one context per
 *  mount (hero · flat · mini · chunky · glow); past this the def's caches
 *  restart. */
const CONTEXTS_MAX = 4

const FRAME_CACHES = new WeakMap<CritterDef, Map<string, FrameCache>>()

function frameCacheFor(def: CritterDef, context: string): FrameCache {
  let byContext = FRAME_CACHES.get(def)
  if (byContext === undefined) {
    byContext = new Map()
    FRAME_CACHES.set(def, byContext)
  }
  let cache = byContext.get(context)
  if (cache === undefined) {
    if (byContext.size >= CONTEXTS_MAX) byContext.clear()
    cache = { lines: new Map(), roots: new Map() }
    byContext.set(context, cache)
  }
  return cache
}

/** Everything a line's cells depend on besides the two row strings, the
 *  line's own ground and the per-line extras (the pupil glyph on an eye
 *  line, the sleep slots on a glyph line): the hue pair cellColor reads,
 *  the sleep ladder the z-seam paints, the legend re-binding, the bloom,
 *  the cell width, the render path and the grid width the glow ramps
 *  across. */
function paintContextKey(
  def: CritterDef,
  legendOverride: Readonly<Record<string, string>> | undefined,
  glowToward: string | undefined,
  dup: number,
  chunky: boolean,
  gridCols: number,
): string {
  let legend = ''
  if (legendOverride !== undefined) {
    for (const k of Object.keys(legendOverride)) legend += `${k}=${legendOverride[k]},`
  }
  return `${def.hue}|${def.hueDeep}|${sleepGlyphsFor(def)}|${legend}|${glowToward ?? ''}|${dup}|${chunky ? 'k' : 'p'}|${gridCols}`
}

/** The per-line extras a line's key carries beyond its rows and ground: the
 *  pupil glyph where a full eye cell is painted (so a blink rebuilds the eye
 *  line and nothing else), the sleep slots where a sleep cell is painted (the
 *  z-seam maps columns through them). */
function lineExtras(top: string, bot: string, pupil: string, sleepSlots: readonly number[]): string {
  let extras = ''
  for (let c = 0; c < top.length; c++) {
    if (top[c] === 'P' && bot[c] === 'P') {
      extras += `|${pupil}`
      break
    }
  }
  if (top.includes(SLEEP_CELL) || bot.includes(SLEEP_CELL)) extras += `|${sleepSlots.join(',')}`
  return extras
}

/** The moving parts of a frame — the primitives AnimatedCritterArt hands the
 *  painter on every edge of the shared clock. */
export type CritterFrameOpts = {
  hero?: boolean
  mini?: boolean
  /** THE SQUARE TIER (chat-feel item 5): render def.square — hero-class in
   *  its eye grammar (gaze + the lid transform run on it), whole-grid in
   *  its geometry (no content slice — the mirrored grids centre on their
   *  own axis). `hero` wins when both are set. */
  square?: boolean
  pupil?: string
  gazeKey?: string
  swayPhase?: number
  sleepPhase?: number | null
}

/** The painter's frame: the transformed rows the cells are painted from and
 *  the sleep slots the z-seam maps columns through — ONE composition.
 *
 *  TRANSFORM ORDER (this order is load-bearing):
 *    POSE-SWAP → gaze → blink → BREATH → SETTLE → SWAY → content-slice → ZZZ.
 *  Asleep, an authored SLEEP POSE replaces the awake grid wholesale (its
 *  own silhouette and its own flow depth — sleepPoseFor); the breath dips
 *  the pose's crown on the slow drift's alternate phases. Both only clear
 *  or swap authored cells, so bounds never grow. The SETTLE (the clam's
 *  valve breathe — settleRows) is the awake counterpart: a one-row drop of
 *  the raised valve onto its authored gap row on the settle phases, width-
 *  preserving, eyes untouched, and inert for every def without `settle`
 *  and for every sleep pose (a shut shell only breathes). Sway runs BEFORE
 *  the slice because it is a bounded shift of authored pixels: swayRows
 *  refuses any shift that would push a painted cell off the grid, so the
 *  content bounds it feeds are the authored ones and the mount's width
 *  budget is untouched. The Zzz runs strictly AFTER the slice, because it
 *  WRITES cells: added before slicing, its glyphs would widen
 *  heroContentBounds and the sleeping critter would render wider than the
 *  awake one — a mount that budgeted `berthCritterCols` would overflow the
 *  moment the session went idle. Every transform works on a copy — the
 *  shared authored grid is never mutated. */
export function composeCritterFrame(def: CritterDef, opts: CritterFrameOpts): { art: string[]; sleepSlots: number[] } {
  const { pupil = '●', gazeKey = '', swayPhase = 0, sleepPhase = null, mini = false, hero = false, square = false } = opts
  const usingHero = hero && !!def.heroArt && def.heroArt.length > 0
  const usingSquare = !usingHero && square && !!def.square && def.square.length > 0
  const heroBlink = usingHero && pupil !== '●'
  const form = usingHero ? 'hero' : usingSquare ? 'square' : mini ? 'mini' : 'art'
  const pose = sleepPhase !== null ? sleepPoseFor(def, form) : null
  const flowDepth = pose ? pose.flow : flowDepthFor(def, form)
  const settleDepth = pose ? 0 : settleDepthFor(def, form)
  let art: string[]
  if (usingHero) {
    // Gaze first, blink on top: applyGazeKey validates the key against THIS
    // grid (identity on '' or any mismatch — and the gaze is disarmed while
    // asleep, so a pose grid only ever sees ''), heroBlinkRows then lids the
    // eye-pair rows wherever the pupil sits — including a pose that authors
    // its eyes open (the jellyfish keeps its E/K clusters and sleeps lidded
    // through the same transform as its blink). Content bounds are
    // unaffected — both transforms are letter swaps inside authored pixels.
    const gazed = applyGazeKey(pose ? pose.art : def.heroArt!, gazeKey)
    const blinked = heroBlink ? heroBlinkRows(gazed) : gazed
    const breathed = pose ? sleepBreathArt(blinked, swayPhase) : blinked
    const settled = settleRows(breathed, settleDepth, swayPhase)
    const rows = swayRows(settled, flowDepth, swayPhase)
    const [cStart, cEnd] = heroContentBounds(rows)
    art = rows.map(r => r.slice(cStart, cEnd))
  } else if (usingSquare) {
    // THE SQUARE TIER: hero-class eyes on a whole-rendered grid. Gaze first,
    // the lid transform on top (E/K clusters lid through heroBlinkRows —
    // the flat P-seam never fires on them), then the same pose/settle/sway
    // register every form shares — inert today (no authored square pose,
    // no flow, no settle: the squares are still), present so an authored
    // future never needs a second pipeline. No content slice: the mirrored
    // grids centre on their own axis and the mounts budget the full width.
    const base = pose ? pose.art : def.square!
    const gazed = applyGazeKey(base, gazeKey)
    const blinked = pupil !== '●' ? heroBlinkRows(gazed) : gazed
    const breathed = pose ? sleepBreathArt(blinked, swayPhase) : blinked
    const settled = settleRows(breathed, settleDepth, swayPhase)
    art = swayRows(settled, flowDepth, swayPhase)
  } else {
    const base = pose ? pose.art : def.art
    const breathed = pose ? sleepBreathArt(base, swayPhase) : base
    const settled = settleRows(breathed, settleDepth, swayPhase)
    art = swayRows(settled, flowDepth, swayPhase)
  }
  // The sleep slots are read BEFORE the glyph cells are written (a filled
  // slot is no longer empty, and sleepZzzSlots only sees empty columns):
  // the z-seam maps each glyph cell back to its slot to pick the def's
  // ladder character (sleepGlyphAt — Zzz by default, the clam's bubbles).
  // The ladder's length is the slot count (three for the Zzz, four for the
  // clam's o°o°).
  const sleepSlotCount = sleepSlotCountFor(def)
  const sleepSlots = sleepPhase !== null ? sleepZzzSlots(art, sleepSlotCount) : []
  if (sleepPhase !== null) art = sleepZzzArt(art, sleepPhase, sleepSlotCount)
  return { art, sleepSlots }
}

function CritterArtImpl({
  def,
  pupil = '●',
  gazeKey = '',
  swayPhase = 0,
  sleepPhase = null,
  mini = false,
  square = false,
  chunky = false,
  hero = false,
  wide = false,
  legendOverride,
  glowToward,
  lineBg,
}: {
  def: CritterDef
  // The pupil glyph painted in every full eye cell-pair: ● at rest, the flat
  // lid while blinking or asleep (AnimatedCritterArt's schedule).
  pupil?: string
  // Hero-only mouse gaze (critterGaze.ts): the compact pupil-move key computed
  // by AnimatedCritterArt from the live pointer cell. '' = the authored rest
  // pose (byte-identical grid). Applied BEFORE the blink transform so a lid
  // covers a moved pupil exactly like a resting one. A primitive so the memo
  // below stays an exact edge-detector.
  gazeKey?: string
  // IDLE FLOW the sway phase for this frame. Only the def's
  // authored `flow` rows for THIS form move; every row above them is
  // byte-identical, and a def with no flow ignores the phase entirely. A
  // PRIMITIVE, like gazeKey, so the memo stays an exact edge-detector — the
  // shared clock ticks far more often than a phase actually changes.
  swayPhase?: number
  // SLEEP the Zzz phase, or null when the critter is awake. Awake
  // ⇒ this path is inert and the render is byte-identical to before the sleep
  // state existed. The closed EYES are not set here: a sleeping mount passes
  // the lidded pupil glyph, which the flat P-pair seam and (via heroBlinkRows)
  // the hero clusters already honour.
  sleepPhase?: number | null
  // Which authored form this mount renders. The flow depth is authored PER
  // FORM (the grids are different heights, so "the bottom N rows" means a
  // different N in each); `hero` wins when set, and this only distinguishes
  // the 11-wide mini from the 13-wide flat grid.
  mini?: boolean
  // THE SQUARE TIER (chat-feel item 5): render def.square (or the dock grid
  // a mount rebinds onto it) — hero-class eyes (gaze + lids), whole-grid
  // geometry, still body. `hero` wins when both are set.
  square?: boolean
  // Chunky 2× render: each grid pixel → two full-block cells (██), ONE grid-row per
  // terminal line — the brand-critter look (big, crisp SQUARE blocks). The
  // default half-block packs 2 pixels/cell (compact). Chunky is the
  // specimen/gallery treatment; the hero + /critter preview render the
  // authored heroArt grids (hero prop).
  chunky?: boolean
  // Big-mascot treatment: render the AUTHORED 24-wide heroArt grid (when the def
  // carries one) through the SAME half-block pairer below — no separate pipeline,
  // so NO_COLOR degrades to legible colorless blocks and theme/fable recolors
  // apply for free. The hero grid's BLINK rides the SAME pupil signal
  // (AnimatedCritterArt's schedule): the closed-lid glyph maps to the pure
  // heroBlinkRows transform (eye-pair cream/pupil → mid shade).
  hero?: boolean
  // Hero 2× width: every grid pixel spans two columns (the proportionate
  // big-pane treatment — same rows, double the width; colors unchanged).
  wide?: boolean
  // per-render legend re-binding — a letter
  // present here paints with the given color INSTEAD of cellColor's mapping.
  // The one production binding is the resident's shell: {C: <peeked session's
  // identity token>} (fallback accentSoft at the call site). Pass a MEMOIZED
  // object — the memo below compares shallowly.
  legendOverride?: Readonly<Record<string, string>>
  // MAIN-HEADER GLOW: a tokens-derived bloom the
  // art's painted inks ramp toward, left→right across the grid width — the
  // art-cell expression of the focal-ramp identity treatment (the concourse
  // header's fixed jellyfish mark wears it beside the ramped lockup). Static
  // per cell (pure-from-props — no motion, the byte-silence law). The
  // caller derives the bloom from tokens (accentSoft — never re-derived here)
  // and passes undefined on reduced-colour families (gate: focalRamp.length
  // > 1), so the treatment collapses to the authored art exactly like the
  // ramp collapses flat. The eye seam stays authored (identity anchor).
  glowToward?: string
  // ONE-BACKDROP (gradient phase 2): the per-line ground sampler (index 0 =
  // the art's first rendered terminal line). On a row-graded field the art's
  // TRANSPARENT cells must ride the same row profile as the cells beside
  // them — each rendered line wraps in a bg-filled row so uncoloured spaces
  // inherit it. Painted cells keep their exact authored inks (CG-12).
  // Absent ⇒ the historical bare-Text lines, byte-identical.
  lineBg?: (line: number) => string | undefined
}): React.ReactNode {
  const usingHero = hero && !!def.heroArt && def.heroArt.length > 0
  // The frame: the transformed rows (hero grids sliced to their CONTENT
  // bounds so a framed parent centers the creature instead of its authoring
  // padding) and the sleep slots the z-seam maps columns through.
  const { art, sleepSlots } = composeCritterFrame(def, { hero, mini, square, pupil, gazeKey, swayPhase, sleepPhase })
  const dup = usingHero && wide ? 2 : 1
  const colorOf = (ch: string | undefined): string | undefined =>
    (ch !== undefined && legendOverride?.[ch]) || cellColor(def, ch)

  // Size off the def's OWN rows rather than a fixed CR_COLS. The flat grids are
  // CR_COLS (13) wide, the hero grids 24 and the minis 11, and a content-sliced
  // hero is narrower still — a fixed loop would clip whichever form did not
  // match it. CR_COLS stays the floor, never the ceiling.
  const gridCols = art.reduce((m, r) => Math.max(m, r.length), CR_COLS)

  // The glow at grid column c: strength walks 0 → GLOW_MAX left-to-right,
  // sampled at cell centers (the rampSegments idiom), so the same column
  // blends identically in the top and bottom half-block cells.
  const paint = (ch: string | undefined, c: number): string | undefined => {
    const base = colorOf(ch)
    return base !== undefined && glowToward !== undefined
      ? glowMix(base, glowToward, ((c + 0.5) / gridCols) * GLOW_MAX)
      : base
  }

  // THE CACHE LOOKUP. The frame's key is the pupil glyph, every line's
  // ground and the transformed rows under the paint context; a root
  // committed for exactly this key is handed back as-is, and otherwise
  // every line still hits by content.
  const lineCount = chunky ? art.length : Math.ceil(art.length / 2)
  const grounds: string[] = []
  for (let i = 0; i < lineCount; i++) grounds.push(lineBg?.(i) ?? '')
  const context = paintContextKey(def, legendOverride, glowToward, dup, chunky, gridCols)
  const cache = frameCacheFor(def, context)
  const frameKey = `${pupil}|${sleepSlots.join(',')}\n${grounds.join('|')}\n${art.join('\n')}`
  const cachedRoot = cache.roots.get(frameKey)
  if (cachedRoot !== undefined) return cachedRoot
  if (cache.lines.size >= LINES_MAX) cache.lines.clear()
  if (cache.roots.size >= ROOTS_MAX) cache.roots.clear()

  // Chunky path: one grid-row per line, each pixel a 2-wide full block. Square
  // pixels at 2× the half-block size — the crisp blocky specimen look.
  if (chunky) {
    const rows: React.ReactNode[] = []
    for (let r = 0; r < art.length; r++) {
      const bg = grounds[r]!
      const lineKey = `${r}|${art[r]}|${bg}${lineExtras(art[r]!, '', pupil, sleepSlots)}`
      const hit = cache.lines.get(lineKey)
      if (hit !== undefined) {
        rows.push(hit)
        continue
      }
      const cells: React.ReactNode[] = []
      for (let c = 0; c < gridCols; c++) {
        const ch = cellAt(art, r, c)
        if (ch === SLEEP_CELL) {
          // Chunky cells are 2 wide: the glyph sits in the left half so a
          // column of them still reads as a column of z's (or bubbles), not
          // as 'zz' pairs.
          cells.push(
            <Text key={c} color={paint(SLEEP_CELL, c)}>{`${sleepGlyphAt(def, sleepSlots, c)} `}</Text>,
          )
          continue
        }
        if (ch === 'P') {
          // Cream eye, 2 cells wide. Render the iris as two MEETING half-blocks
          // (▐ then ▌) so the pupil sits DEAD-CENTRE — straight-ahead; a single
          // glyph in either cell would sit off to one side and read as looking
          // sideways. The two halves meet at the cell boundary = a centred iris
          // bar under the eyestalk.
          cells.push(
            <Text key={`${c}L`} backgroundColor={EYE_BG} color={PUPIL}>▐</Text>,
          )
          cells.push(
            <Text key={`${c}R`} backgroundColor={EYE_BG} color={PUPIL}>▌</Text>,
          )
          continue
        }
        const col = paint(ch, c)
        cells.push(
          col ? (
            <Text key={c} color={col}>
              ██
            </Text>
          ) : (
            <Text key={c}>{'  '}</Text>
          ),
        )
      }
      const line =
        bg !== '' ? (
          <Box key={r} height={1} flexShrink={0} backgroundColor={bg}>
            <Text>{cells}</Text>
          </Box>
        ) : (
          <Text key={r}>{cells}</Text>
        )
      cache.lines.set(lineKey, line)
      rows.push(line)
    }
    const root = <Box flexDirection="column">{rows}</Box>
    cache.roots.set(frameKey, root)
    return root
  }

  const lines: React.ReactNode[] = []
  for (let r = 0; r < art.length; r += 2) {
    const bg = grounds[r >> 1]!
    const topRow = art[r]!
    const botRow = art[r + 1] ?? ''
    const lineKey = `${r}|${topRow}|${botRow}|${bg}${lineExtras(topRow, botRow, pupil, sleepSlots)}`
    const hit = cache.lines.get(lineKey)
    if (hit !== undefined) {
      lines.push(hit)
      continue
    }
    const cells: React.ReactNode[] = []
    for (let c = 0; c < gridCols; c++) {
      const top = cellAt(art, r, c)
      const bot = cellAt(art, r + 1, c)
      // Eye seam — the OASIS pupil glyph paints ONLY for a full 2-cell eye (both
      // halves an eye char). A stalk+eye cell (D over P) falls through to
      // cellColor → half-block (dark eyestalk top · cream eye bottom).
      if (top === 'P' && bot === 'P') {
        cells.push(
          <Text key={c} color={PUPIL} backgroundColor={EYE_BG}>
            {pupil}
          </Text>,
        )
        continue
      }
      // Z-SEAM — the sleep glyph, drawn the way the eye seam draws a pupil:
      // a full cell-PAIR of the sleep legend paints one literal glyph from
      // the def's ladder (sleepGlyphAt: the Zzz by default, the clam's
      // bubbles) in a quiet tint of the creature's own hue, with NO
      // background, so it floats in the air the sprite already leaves empty.
      // The sleep transform only ever writes pairs into cells that were
      // empty in BOTH rows, which is what makes this safe to draw over a
      // grid without a mask.
      if (top === SLEEP_CELL && bot === SLEEP_CELL) {
        const zc = paint(SLEEP_CELL, c)
        cells.push(
          <Text key={c} color={zc}>
            {sleepGlyphAt(def, sleepSlots, c).repeat(dup)}
          </Text>,
        )
        continue
      }
      const tc = paint(top, c)
      const bc = paint(bot, c)
      if (!tc && !bc) {
        cells.push(<Text key={c}>{' '.repeat(dup)}</Text>)
      } else if (tc && bc) {
        cells.push(
          <Text key={c} color={tc} backgroundColor={bc}>
            {'▀'.repeat(dup)}
          </Text>,
        )
      } else if (tc) {
        cells.push(
          <Text key={c} color={tc}>
            {'▀'.repeat(dup)}
          </Text>,
        )
      } else {
        cells.push(
          <Text key={c} color={bc}>
            {'▄'.repeat(dup)}
          </Text>,
        )
      }
    }
    const line =
      bg !== '' ? (
        <Box key={r} height={1} flexShrink={0} backgroundColor={bg}>
          <Text>{cells}</Text>
        </Box>
      ) : (
        <Text key={r}>{cells}</Text>
      )
    cache.lines.set(lineKey, line)
    lines.push(line)
  }

  const root = <Box flexDirection="column">{lines}</Box>
  cache.roots.set(frameKey, root)
  return root
}

// Memoized: AnimatedCritterArt ticks the parent ~12/s (IDLE_TICK_MS=80) but
// every moving part arrives as a PRIMITIVE that changes only on an output edge
// — the pupil glyph (blink), swayPhase (~1.4/s while flowing), sleepPhase
// (~1.1/s while asleep), gazeKey (a real pupil move) — and `def` is a stable
// ref (critterDefForKey's module table, or a caller-side useMemo for the
// tinted wrappers: the def-identity rule). On every tick where no edge
// fired, the shallow compare bails and the grid is not reconciled; on an
// edge, the frame cache above hands back every unchanged line.
// Pure-from-props ⇒ render-identical on every path.
export const CritterArt = React.memo(CritterArtImpl)

/** Proof seam: the frame cache's live shape for a def — how many paint
 *  contexts it holds and, per context, the lines and roots cached. */
export function critterFrameCacheStatsForProofs(def: CritterDef): {
  contexts: number
  lines: number
  roots: number
} {
  const byContext = FRAME_CACHES.get(def)
  if (byContext === undefined) return { contexts: 0, lines: 0, roots: 0 }
  let lines = 0
  let roots = 0
  for (const cache of byContext.values()) {
    lines += cache.lines.size
    roots += cache.roots.size
  }
  return { contexts: byContext.size, lines, roots }
}
