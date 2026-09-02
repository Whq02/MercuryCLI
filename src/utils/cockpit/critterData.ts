// ============================================================================
//  utils/cockpit/critterData — the critters' SHAPE source of truth.
//
//  Four sea-critters, each ONE record: the 13-wide flat grid, the 24-wide
//  hero grid, the 11-wide mini, the 10×6 compact mark, the authored sleep
//  poses per form, the one-line mark, the motion parameters (flow · settle)
//  and the sleep-glyph ladder. The COLOUR half of the critter system (the live
//  accent per key) is sessionAccent.ts; the two agree on hex by construction —
//  the fixed octopus/jellyfish/clam hues are declared here and sessionAccent
//  imports them, so a retune can never desync the art from the identity.
//  crab's hue IS the TERRA token (a TERRA retint follows for free).
//
//  React-free by design — the LOWEST module in the critter system (imports only
//  mercuryPalette tokens, no React, no sessionAccent), so CritterArt.tsx and any
//  surface can depend on it without an import cycle.
//
//  THE LEGEND (every grid, every form): `.` empty · `M` body (the hue) · `D`
//  dark shade · `m` mid shade · `L` light · `C` deep accent (limbs, grooves,
//  ribs) · `%` the belly/mantle band · `E` cream eye · `K` pupil (hero grids)
//  · `P` pupil-eye (a P-over-P column pair paints the real iris) · `z` a
//  sleep-glyph cell the sleep transform writes at render. cellColor is the one
//  owner of letter → colour; CritterArt's seams paint the iris and the glyph.
// ============================================================================

import { CLAW, IVORY, OASIS, TERRA } from '../../components/mercuryPalette.js'

// ── the record ──────────────────────────────────────────────────────────────

/** The authored forms a critter mount renders. `square` is THE SQUARE
 *  CRITTERS tier (chat-feel item 5): the compact geometric variant the
 *  small berths render — the berth's sub-hero slot (the flat 100x30 form)
 *  and the 80x24 deck dock — while the full sprite stays at the hero berth.
 *  Square grids are HERO-CLASS in their eye grammar (E clusters holding K
 *  pupils), so the landed gaze law and the lid transform run on them
 *  unchanged; their bodies are still (no flow, no settle — geometric calm)
 *  and they sleep in the landed lid-only degradation (no authored pose),
 *  with the top row-pair left empty so the sleep glyphs keep their air. */
export type ArtForm = 'art' | 'hero' | 'mini' | 'square'

/** The three CORE forms every def authors a sleep pose for; the square tier
 *  deliberately authors none (lid-only sleep — the honest degradation the
 *  estate already defines). */
type CoreArtForm = 'art' | 'hero' | 'mini'

/** A sleep pose: the authored grid plus its OWN flow depth — the pose's
 *  moving rows sit at different heights than the awake grid's, so the def's
 *  awake flow numbers would sway the wrong rows (a slumped dome, say). Flow
 *  depths cover WHOLE row-pairs, like every flow in the estate. */
export type SleepPose = { art: string[]; flow: number }

export type CritterDef = {
  name: string // the launcher pool name (one word for every critter)
  hue: string // the shell accent — crab is the live TERRA token; others fixed
  hueDeep: string // claws / legs / grooves — the deep accent
  /** The ONE-LINE mark: a 5-cell authored silhouette in the crab lockup's
   *  grammar — deep-accent flanks around a main-accent core, block-glyph
   *  family only. Session-identity slots (the statusline anchor, the exit
   *  farewell) render THIS, so a non-crab session never reads as crab at
   *  one-line size. REQUIRED on every record — a missing mark is a validation
   *  error, never a silent crab (prove-critter-mark). */
  mark: { pre: string; core: string; post: string }
  /** The 13-wide flat grid, top→bottom: the cockpit berth's compact tier,
   *  the picker's narrow cards, the tiny mark. */
  art: string[]
  /** The 24-wide hero grid — the big-mascot treatment, designed AT terminal
   *  cell resolution from the theme palette and rendered by CritterArt's
   *  ordinary half-block pairer, so NO_COLOR degrades to legible colourless
   *  blocks and every recolour derives from def.hue at render. */
  heroArt?: string[]
  /** The 11×6 mini grid — the session companion's small form (three
   *  half-block lines through the same pairer; P-over-P eyes keep the real
   *  pupil glyph). */
  mini: string[]
  /** The 10×6 compact mark — one authored SET across the pool in the same
   *  grammar (crown pair · eye pair · rim/identity pair). AUTHORED, PARKED
   *  (the concourse header — its one product mount —
   *  wears the squareDock family now); deletion is a named deferral. */
  markCompact: string[]
  /** THE SQUARE CRITTERS (chat-feel item 5) — the 13×12 square-body grid
   *  for the berth's sub-hero tier: a square silhouette with one geometric
   *  identity gesture, lighter shading (M-bodied, small mirrored accents),
   *  hero-class E/K eye clusters (the gaze law tracks them), an EMPTY top
   *  row-pair (sleep-glyph air), and every row mirrored LETTER FOR LETTER —
   *  the variant registers in the symmetry census's FULL set and no gesture
   *  rows at all. */
  square: string[]
  /** The square tier's 11×6 dock grid — the 80x24 deck dock's form, in the
   *  same square grammar at the mini's slot geometry. */
  squareDock: string[]
  /** The authored sleep pose per CORE form: the silhouette itself says
   *  asleep, not just a lid glyph. Every pose keeps its form's row count
   *  (the mounts' fixed slots hold) and an EMPTY top row-pair (the
   *  sleep-glyph slots); bounds stay inside the awake grid's, so no berth
   *  budget is ever exceeded by falling asleep. The square tier authors no
   *  pose — it sleeps lid-only in its awake grid (sleepPoseFor → null). */
  sleep: Record<CoreArtForm, SleepPose> & Partial<Record<'square', SleepPose>>
  /** IDLE FLOW: how many BOTTOM rows of each grid undulate on the shared
   *  idle clock — the per-critter motion personality, authored per FORM
   *  because the grids are different heights. The rows above the count are
   *  the anchored MASS and stay byte-identical in every frame (anchor the
   *  mass, move the extremities). Absent / 0 ⇒ the creature holds still and
   *  only blinks. `swayRows` additionally refuses any shift that would push a
   *  painted cell off the grid, so a limb already touching an edge simply
   *  holds — the widest arms anchor and the inner ones drift, which is also
   *  what they do in water. */
  flow?: Partial<Record<ArtForm, number>>
  /** VALVE SETTLE — the bivalve's idle motion, authored per FORM like `flow`:
   *  how many TOP rows of each grid (the raised valve: crown, dome, lip) drop
   *  one row on the settle phases of the shared sway cycle, covering the row
   *  beneath them — authored as the pure-shade gap row above the eyes, so the
   *  opening narrows by half a cell and nothing an eye seam keys on is ever
   *  touched — then rise again. A creature with no limbs to sway breathes
   *  with its shell instead (settleRows). Absent / 0 ⇒ no settle. */
  settle?: Partial<Record<ArtForm, number>>
  /** The SLEEP GLYPH LADDER — what the sleep slots paint, slot-indexed
   *  left→right in single-width characters. Absent ⇒ SLEEP_GLYPHS_DEFAULT,
   *  the Zzz; the clam authors bubbles. The ladder changes only the glyph:
   *  the slots, the cadence and the reduced-motion law are shared by every
   *  sleeper (sleepGlyphsFor). */
  sleepGlyphs?: string
}

// ── the shared geometry ─────────────────────────────────────────────────────

/** The flat grids are 13 cells wide — the floor CritterArt sizes from,
 *  never the ceiling (the hero grids are 24, the minis 11). */
export const CR_COLS = 13

/** The shared hero-grid width (every heroArt row is exactly this wide). */
export const HERO_ART_COLS = 24

// ── the legend's colours ────────────────────────────────────────────────────

/** The eye treatment (the launch-splash iris look): an ivory cell with an
 *  oasis-blue pupil GLYPH — painted by CritterArt's eye seam, never through
 *  cellColor's foreground. */
export const EYE_BG = '#EDE8DD' // ivory eye-white (== IVORY, named for the seam)
export const PUPIL = OASIS // pupil — the oasis blue (matches the splash iris)

//  The non-crab hues — THE single source. The fixed octopus/jellyfish/clam
//  hexes live HERE and sessionAccent.ts imports them, never the reverse (that
//  would pull react + the config chain into this leaf). crab is omitted: its
//  hue IS the live TERRA token.
export const OCTOPUS_HUE = '#B07BE0' // octopus dome accent
export const OCTOPUS_HUE_DEEP = '#6E4BA0' // octopus tentacle deep accent
export const JELLYFISH_HUE = '#6FC7E8' // jellyfish bell accent
export const JELLYFISH_HUE_DEEP = '#3F7E96' // jellyfish tentacle deep accent
export const CLAM_HUE = '#16D8B0' // clam shell accent
export const CLAM_HUE_DEEP = '#0E9377' // clam rib deep accent
/** EMBER — the `furnace` MACHINE-MARK pair (agentHeadData's fifth persona).
 *  Not a critter: the workflow agent-head table binds this pair, and hex may
 *  only be declared in the two single-source files plus this art module, so
 *  the constants live here under their role name. */
export const EMBER_HUE = '#CE352A' // furnace agent-head — fierce ember crimson
export const EMBER_HUE_DEEP = '#771A12' // furnace deep — banked coal

/** A per-critter tint: mix `a` toward `b` by `t` (the belly band is the
 *  critter's OWN hue toward ivory, so the band reads as THAT creature). */
function hexMix(a: string, b: string, t: number): string {
  const p = (h: string): number[] => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
  const [ar, ag, ab] = p(a)
  const [br, bg, bb] = p(b)
  const c = (x: number, y: number): number => Math.round(x + (y - x) * t)
  return (
    '#' +
    [c(ar!, br!), c(ag!, bg!), c(ab!, bb!)]
      .map(v => v.toString(16).padStart(2, '0'))
      .join('')
  )
}

/** The legend's letter → colour, the ONE owner. Every colour derives from
 *  the def's own hue pair, so a /critter morph, the fable recolour and a
 *  TERRA retint restyle every grid for free. Empty (`.`) and any letter
 *  outside the legend return undefined → don't paint. */
export function cellColor(def: CritterDef, ch: string | undefined): string | undefined {
  switch (ch) {
    case 'M':
      return def.hue // body → the accent (live for crab via TERRA)
    case 'D':
      return hexMix(def.hue, '#000000', 0.42) // dark shade / outline (darken 42% — reads at chunky scale)
    case 'C':
      return def.hueDeep // limbs · grooves · ribs → the deep accent
    case 'm':
      return hexMix(def.hue, '#000000', 0.2) // mid shade (the light's falloff)
    case 'K':
      return hexMix(def.hue, '#000000', 0.72) // hero pupil — near-black of THIS hue
    case 'L':
      return hexMix(def.hue, '#FFFFFF', 0.28) // light (lighten 28% — reads at chunky scale)
    case '%':
      return hexMix(def.hue, IVORY, 0.45) // the belly band → a light tint of THIS hue
    case SLEEP_CELL:
      // The sleep glyph (Zzz, or the clam's bubbles) — a soft, quiet tint of
      // the creature's OWN hue (the belly-band mix), so the glyph reads as
      // breath coming off THAT animal and needs no token of its own. Painted
      // as a literal glyph by CritterArt's z-seam; the sleep transform only
      // ever writes cell PAIRS, so an unpaired z (this half-block colour)
      // is unrepresentable.
      return hexMix(def.hue, IVORY, 0.45)
    case 'E':
    case 'P':
      return EYE_BG // cream eye — a cream cell; a D eyestalk above renders as the top half-block
    default:
      return undefined
  }
}

// ── the sleep-glyph ladders (records reference them) ────────────────────────

/** The sleep glyph legend cell. A cell-PAIR of these paints one literal
 *  glyph from the def's sleep ladder (CritterArt's z-seam, the same shape as
 *  the eye seam; sleepGlyphAt picks the character) — the Zzz, or the clam's
 *  bubbles, is drawn INSIDE the authored grid's own empty cells, never
 *  beside it, so falling asleep costs the mount exactly zero extra columns
 *  and rows. */
export const SLEEP_CELL = 'z'

/** How many phases the sleep glyphs climb through: z → zz → zzz, then
 *  round again — a clean loop with no stall at its wrap. */
export const SLEEP_PHASES = 3

/** THE SLEEP GLYPH LADDER — the ONE owner of what a sleeping critter's
 *  slots paint. Slot-indexed left→right in single-width characters; the
 *  ladder's LENGTH is the slot count (sleepZzzSlots), and the climb runs the
 *  same SLEEP_PHASES steps for every ladder, adding one glyph per phase from
 *  the right and ending whole — so a three-glyph ladder climbs z → zz → zzz
 *  and a four-glyph one shows its rightmost two at phase 0 and all four at
 *  phase 2. The default is the Zzz. A def may author its own ladder
 *  (CritterDef.sleepGlyphs) — the slot mechanism, the cadence, the tint and
 *  the reduced-motion law are shared; only the glyphs (and, for a four-glyph
 *  ladder, the fourth cell) differ. */
export const SLEEP_GLYPHS_DEFAULT = 'zzz'

/** The longest ladder a def may author: the climb adds ONE glyph per phase
 *  and must end whole, so a ladder is SLEEP_PHASES glyphs (the Zzz) or one
 *  more (the first frame then already shows two). Anything else degrades
 *  to the default rather than painting a ladder the climb cannot finish. */
export const SLEEP_GLYPHS_MAX = SLEEP_PHASES + 1

/** The clam sleeps under BUBBLES, not a Zzz: bubbles of TWO sizes drifting
 *  up, alternating big/small — a lowercase o and the degree sign — four
 *  glyphs, so the stream never reads as a little face (three alternating
 *  glyphs are always symmetric, and °o° would). Same slot mechanism, same
 *  climb: o° → °o° → o°o°. Both glyphs single-width on every wire, neither
 *  emoji-eligible. */
export const CLAM_SLEEP_GLYPHS = 'o°o°'

/** The sleep glyph ladder for a def — its authored ladder, else the Zzz.
 *  Keyed off the def object so the tinted wrappers (which spread the def)
 *  carry it for free. Total: a malformed ladder (shorter than the climb,
 *  longer than SLEEP_GLYPHS_MAX) degrades to the default. */
export function sleepGlyphsFor(def: Pick<CritterDef, 'sleepGlyphs'>): string {
  const g = def.sleepGlyphs
  if (g === undefined) return SLEEP_GLYPHS_DEFAULT
  const n = [...g].length
  return n >= SLEEP_PHASES && n <= SLEEP_GLYPHS_MAX ? g : SLEEP_GLYPHS_DEFAULT
}

/** The slot count a def's ladder needs — the count sleepZzzSlots and
 *  sleepZzzArt are handed at the painter (the Zzz's three by default). */
export function sleepSlotCountFor(def: Pick<CritterDef, 'sleepGlyphs'>): number {
  return [...sleepGlyphsFor(def)].length
}

/** The glyph a sleep cell at grid column `c` paints, given the slots the
 *  frame was written into (sleepZzzSlots of the same grid, taken BEFORE
 *  sleepZzzArt filled them). A column outside the slots — unrepresentable
 *  for a frame this module wrote — falls back to the ladder's last glyph. */
export function sleepGlyphAt(def: Pick<CritterDef, 'sleepGlyphs'>, slots: readonly number[], c: number): string {
  const ladder = [...sleepGlyphsFor(def)]
  const i = slots.indexOf(c)
  return ladder[i >= 0 ? i : ladder.length - 1]!
}

// ============================================================================
//  THE CRITTERS — one section each: every authored grid, then the record.
//
//  Shared design laws (every grid): whole cells with clean gaps read at the
//  half-block scale (a feature owns WHOLE cells, never alternating single
//  rows); a distinguishing feature gets the POP (P / E-K), never the shadow;
//  the hero grids share ONE language — cream eyes with a pupil, one light
//  source high-left (L high-left, m low-right) — with one authored identity
//  gesture each; the % band is SPECIES ANATOMY, not a family constant
//  (operator ruling): the crab's belly, the jellyfish's skirt rim
//  and the clam's mantle wear it as a light tint of the creature's own hue,
//  while the octopus's mantle reads UNIFORM — a full-width lighter stripe on
//  it is a defect (the two-way band registry in prove-critter-look-census
//  holds the roster); a stroke holds both rows of a row-pair per column and
//  steps one column per LINE, so nothing fragments through the pairer.
//  Sleep poses: every grid keeps its form's row count (the mounts' fixed
//  slots hold), an EMPTY top row-pair (the sleep-glyph slots), and bounds
//  inside the awake grid's; the hero poses are content-sliced per frame
//  exactly like awake ones.
// ============================================================================

// ── CRAB ────────────────────────────────────────────────────────────────────
//  Claws raised. Each claw is prong · gap · prong (P . P) over a closed hand
//  (MMM), so the pair renders ▀▄▀ — two bright tips with the pincer NOTCH
//  between them, the crab's single most recognisable feature. The eyes sit
//  INSIDE the dome as P pairs. Each leg holds BOTH rows of its column (a solid
//  block) with an empty column between, and the two OUTERMOST legs step one
//  column outward on the lower row — crisp stubs plus a splayed stance. Legs
//  and claws wear C, the crab's own deep accent (CLAW), so the limbs read as
//  limbs, not as shadow. The LL belly band (rows 8–9) is the species' band.
const CRAB_ART: string[] = [
  'P.P.......P.P', // 0  pincer prongs (pop) — the gap between them IS the claw
  'MMM.......MMM', // 1  the claw hand closes under the prongs
  '.MM.......MM.', // 2  claw arms swing down
  '..MM.MMM.MM..', // 3  arms meet the dome crown
  '.MMPMMMMMPMM.', // 4  eyes in the dome (cream + oasis pupil)
  '.MMPMMMMMPMM.', // 5
  '.MMMMMMMMMMM.', // 6
  '..MMMMMMMMM..', // 7
  '..LLLLLLLLL..', // 8  belly band
  '..LLLLLLLLL..', // 9
  '.C.C.C.C.C.C.', // 10 six legs, each a WHOLE cell with a clean gap
  'C..C.C.C.C..C', // 11 the outer pair steps out — a splayed stance
]

//  The hero: the identity gesture is ONE claw raised open-out against the
//  other hanging open-down, each with a real pincer notch; the shell stays
//  heavy and every limb tapers through real joints —
//   · RAISED claw: the pair renders ▀█▄█▀ (tip · hand · NOTCH · hand · tip —
//     both prongs stand proud), the wrist stepping 2px → 1px into the shell;
//   · LOW claw: a 3-wide hand over TWO prong tips with the notch between
//     them, opening DOWNWARD;
//   · LEGS: 2-wide hips, then the outward step tapers — the outer column of
//     each lower leg holds only the BOTTOM row, so every leg closes on a
//     1px toe pointing out-down.
const CRAB_HERO: string[] = [
  '......EEE.....EEE.......',
  '......EKE.....EKE.......',
  '.......DD.....DD........',
  '.......DD.....DD........',
  '.....LLLMMMMMMMMm.CC.CC.', // raised claw: the two pincer prongs
  '...LLMMMMMMMMMMMMm.CCC..', // the hand closes under them (outer tip proud)
  '..LMMMMMMMMMMMMMMMM.CC..', // wrist tapers…
  '.CCMMMMMMMMMMMMMMMMMC...', // …to 1px where the arm roots into the shell
  'CCC.MMMMMMMMMMMMMMMMm...', // low claw: the hand
  'CCC..MMMMMMMMMMMMMMm....',
  'C.C.mMMMMMMMMMMMMmm.....', // …over two prong tips — the notch opens DOWN
  '....%%%%%%%%%%%%%%......',
  '....%%%%%%%%%%%%%%......',
  '.....DDDDDDDDDDDD.......',
  '...CC..CC....CC..CC.....', // legs: 2-wide hips…
  '...CC..CC....CC..CC.....',
  '...C...C......C...C.....', // …tapering through the knee…
  '..CC..CC......CC..CC....', // …to a 1px toe stepping out-down
]

//  The mini: side pincers — pops (P) mark the pincers + eyes; the pairer
//  renders P-pairs as cream pop-dots, so the pincer tips read bright against
//  any ground.
const CRAB_MINI: string[] = [
  '...MMMMM...', // dome crown
  '..MMMMMMM..',
  'PMMPMMMPMMP', // side pincers + eyes (pop pairs)
  'PMMPMMMPMMP',
  '..M.M.M.M..', // legs
  '.D..D.D..D.',
]

const CRAB_MARK_COMPACT: string[] = [
  'P.P.......', // 0  the raised claw's prong · notch · prong…
  'MMM....MM.', // 1  …over its hand; the low claw rests right
  '.MMPMMPMM.', // 2  dome with the iris pair
  '.MMPMMPMM.', // 3
  '.LLLLLLLL.', // 4  belly band
  '.C.C..C.C.', // 5  planted legs — a mirrored stance under the dome
]

//  Asleep the crab hunkers flat: eyestalks folded away, lids on the dome,
//  both claws tucked symmetric (the raised claw is the AWAKE gesture), legs
//  drawn in. Its species beat is stillness, so its sleep motion is the
//  breath alone.
const CRAB_ART_SLEEP: string[] = [
  '.............', // 0  (empty top pair — the Zzz breathes here)
  '.............', // 1
  '.............', // 2
  '.............', // 3
  '.............', // 4
  '.............', // 5
  '..MMMMMMMMM..', // 6  dome crown, settled low (the breath dips this row)
  '.MMMMMMMMMMM.', // 7
  '.MMmMMMMMmMM.', // 8  lids where the eyes rest
  '.MMMMMMMMMMM.', // 9
  'CCMLLLLLLLMCC', // 10 both claws tucked flat beside the belly band
  'CC.C.C.C.C.CC', // 11 legs drawn in under the shell
]

const CRAB_HERO_SLEEP: string[] = [
  '........................', //  0
  '........................', //  1
  '........................', //  2
  '........................', //  3
  '........................', //  4
  '........................', //  5
  '........................', //  6
  '........................', //  7
  '......LLMMMMMMMMMm......', //  8 crown, settled low (the breath row)
  '....LLMMMMMMMMMMMMm.....', //  9
  '...LMMmmMMMMMMmmMMMm....', // 10 lids where the stalked eyes folded away
  '..mMMMMMMMMMMMMMMMMmm...', // 11
  '.CCC.mMMMMMMMMMMm..CCC..', // 12 both claws tucked symmetric —
  'CCCC.mMMMMMMMMMMMm.CCCC.', // 13 the raised claw is the AWAKE gesture
  '.CC..%%%%%%%%%%%%..CC...', // 14 claw tips curl under the belly band
  '.....DDDDDDDDDDDD.......', // 15
  '...CC.CC.CC..CC.CC.CC...', // 16 legs folded straight under —
  '...CC.CC.CC..CC.CC.CC...', // 17 no splayed stance while it sleeps
]

const CRAB_MINI_SLEEP: string[] = [
  '...........', // 0
  '...........', // 1
  '..MMMMMMM..', // 2  crown (the breath row)
  '.MMmMMMmMM.', // 3  lids
  'CCMLLLLLMCC', // 4  claws tucked
  'C.C.M.M.C.C', // 5  legs drawn in
]

//  THE SQUARE CRAB — the geometric small-berth tier: a square shell with
//  pincer nubs at the shoulders (the claw geometry said in whole cells),
//  hero-class eye clusters, two mirrored belly gleams (runs of 2 — light
//  shading, never a band), six planted legs. Letter-for-letter mirrored;
//  the top pair stays empty for the Zzz.
const CRAB_SQUARE: string[] = [
  '.............', // 0  (empty top pair — the Zzz breathes here)
  '.............', // 1
  '.CC.......CC.', // 2  pincer nubs at the square's shoulders
  '.CCMMMMMMMCC.', // 3  …closing onto the crown
  '.MEEEMMMEEEM.', // 4  eye clusters inside the square
  '.MEKEMMMEKEM.', // 5
  '.MMMMMMMMMMM.', // 6
  '.MMMMMMMMMMM.', // 7
  '.MLLMMMMMLLM.', // 8  mirrored belly gleams (light shading, under band size)
  '.MMMMMMMMMMM.', // 9
  '.C.C.C.C.C.C.', // 10 six legs, whole cells with clean gaps
  '.C.C.C.C.C.C.', // 11
]

const CRAB_SQUARE_DOCK: string[] = [
  '.CC.....CC.', // 0  pincer nubs at the shoulders
  '.MMMMMMMMM.', // 1  the crown
  '.MEEEMEEEM.', // 2  eye clusters
  '.MEKEMEKEM.', // 3
  '.MMMMMMMMM.', // 4
  '.C.C.C.C.C.', // 5  planted legs
]

/** The crab — STILL by design: a crab planted on the sand is its character,
 *  and its legs already reach both grid edges, so the lossless shift rule
 *  would hold them anyway. It blinks; it does not sway. */
const CRAB: CritterDef = {
  name: 'crab',
  hue: TERRA,
  hueDeep: CLAW,
  mark: { pre: '▖', core: '▟▆▙', post: '▗' }, // low claws (the crab lockup)
  art: CRAB_ART,
  heroArt: CRAB_HERO,
  mini: CRAB_MINI,
  markCompact: CRAB_MARK_COMPACT,
  square: CRAB_SQUARE,
  squareDock: CRAB_SQUARE_DOCK,
  sleep: {
    art: { art: CRAB_ART_SLEEP, flow: 0 },
    hero: { art: CRAB_HERO_SLEEP, flow: 0 },
    mini: { art: CRAB_MINI_SLEEP, flow: 0 },
  },
}

// ── OCTOPUS ─────────────────────────────────────────────────────────────────
//  A dome over eight fanning arms. The eyes are P-over-P pairs, so the flat
//  form carries the real oasis-on-cream iris AND rides the blink schedule
//  (pupil glyph ● → — on the lid frames) exactly like the crab. The arm
//  shading is the octopus's OWN deep accent (C → hueDeep), silhouette
//  untouched.
const OCTOPUS_ART: string[] = [
  '....MMMMM....', // 0  dome crown
  '..MMMMMMMMM..', // 1
  '.MMMMMMMMMMM.', // 2
  'MMMMMMMMMMMMM', // 3
  'MMMPMMMMMPMMM', // 4  pupil-pair eyes on the dome
  'MMMPMMMMMPMMM', // 5
  'MMMMMMMMMMMMM', // 6
  'MMMMMMMMMMMMM', // 7  the mantle runs uniform to the arm fan
  'MM.MM.M.MM.MM', // 8  eight tentacles fan out
  'CM.MC.M.CM.MC', // 9  deep-accent arm shading
  'C..C..C..C..C', // 10
  '.C....C....C.', // 11
]

//  The hero fills the slot at 18 rows / 9 lines like the crab, and carries
//  the identity gesture: ONE ARM RAISED beside the mantle, dark tip curling
//  in at eye height (the crab's asymmetric-claw beat, spoken in arms). Eyes:
//  two 3×2 E-clusters (K centred low) on one row-pair — six pupil cells per
//  eye for critterGaze, lidded whole by heroBlinkRows.
const OCTOPUS_HERO: string[] = [
  '.......LLMMMM...........', //  0 crown, slouched a touch left
  '.....LLMMMMMMMMM........', //  1
  '....LLMMMMMMMMMMm.......', //  2
  '...LLMMMMMMMMMMMMm......', //  3
  '..LMMMMMMMMMMMMMMMm.....', //  4
  '..LMMMMMMMMMMMMMMMm.....', //  5
  '..MMMMMMMMMMMMMMMMmm....', //  6 mantle at full bulge
  '..MMMMMMMMMMMMMMMMmm....', //  7
  '..MMEEEMMMMMMMMEEEmm....', //  8 wide-set eyes
  '..MMEKEMMMMMMMMEKEmm....', //  9
  '..MMMMMMMMMMMMMMMMmm.CC.', // 10 raised-arm tip curls at eye height
  '...mMMMMMMMMMMMMmm...CC.', // 11 head tucks toward the web
  '...MMMMMMMMMMMMMMMM..MM.', // 12 the web root — uniform mantle; the raised arm climbs past it
  '...MM.MM.MM.MM.MM....MM.', // 13 arm crowns under the web
  '..MM..MM.MM.MM..MM..MM..', // 14 arms diverge; raised arm roots out wide
  '.CM..CM..MM.MM...MC.MM..', // 15 outer tips hook away
  '.........MM..MC.........', // 16 the long pair keeps falling
  '........CC..............', // 17 last tip curls under
]

//  The mini: the arm pair is inset one column from both grid edges, so the
//  lossless sway rule lets the authored flow actually curl (a stance touching
//  cols 0 and 10 on both rows would be held in every phase).
const OCTOPUS_MINI: string[] = [
  '...MMMMM...', // dome crown
  '..MMMMMMM..',
  '.MMPMMMPMM.', // eyes on the dome
  '.MMPMMMPMM.',
  '.M.M.M.M.M.', // five arms fan under the dome
  '.D..D.D..D.', // staggered curl tips (the pair sways whole)
]

const OCTOPUS_MARK_COMPACT: string[] = [
  '..MMMMMM..', // 0  dome crown, centered on the even grid
  '.MMMMMMMM.', // 1
  '.MMPMMPMM.', // 2  eyes on the dome
  '.MMPMMPMM.', // 3
  '.MMMMMMMM.', // 4  uniform mantle over the arms
  'MC.M..M.CM', // 5  arms splay; deep curl-tips hook inward
]

//  Asleep the octopus slumps: the mantle deflates low with lids, and the
//  eight arms gather into a tidy coil of loops underneath, rocking slowly.
const OCTOPUS_ART_SLEEP: string[] = [
  '.............', // 0
  '.............', // 1
  '.............', // 2
  '.............', // 3
  '.............', // 4
  '.............', // 5
  '...MMMMMMM...', // 6  mantle slumped low (the breath row)
  '.MMMMMMMMMMM.', // 7
  '.MMmMMMMMmMM.', // 8  lids on the dome
  'MMMMMMMMMMMMM', // 9
  '.MMMMMMMMMMM.', // 10 the mantle base (inset one column from both
  '.MC.MC.CM.CM.', // 11 edges so the coil's slow rock can actually move)
]

const OCTOPUS_HERO_SLEEP: string[] = [
  '........................', //  0
  '........................', //  1
  '........................', //  2
  '........................', //  3
  '........................', //  4
  '........................', //  5
  '........................', //  6
  '........................', //  7
  '.......LLMMMMMM.........', //  8 mantle crown, slumped (the breath row)
  '.....LLMMMMMMMMMm.......', //  9
  '....LMMMMMMMMMMMMm......', // 10
  '...MMMMMMMMMMMMMMMm.....', // 11
  '...MMmmMMMMMMMMmmMMm....', // 12 lids where the wide-set eyes rest
  '..mMMMMMMMMMMMMMMMMm....', // 13
  '..MMMMMMMMMMMMMMMMMm....', // 14 the mantle base
  '..mmmmmmmmmmmmmmmmm.....', // 15
  '.MM..MM..MM..MM..MM.....', // 16 the arms gathered into a coil of loops —
  '.CC..CC..CC..CC..CC.....', // 17 crowns over deep tips, rocking slowly
]

const OCTOPUS_MINI_SLEEP: string[] = [
  '...........', // 0
  '...........', // 1
  '..MMMMMMM..', // 2  mantle slumped (the breath row)
  '.MMmMMMmMM.', // 3  lids
  '.MMMMMMMMM.', // 4  uniform mantle
  '.MC.MCM.CM.', // 5  the coiled arms
]

//  THE SQUARE OCTOPUS — the geometric tier: a rounded-square mantle (inset
//  crown), hero-class eye clusters, and an arm fringe of whole-cell stubs
//  over deep tips. UNIFORM body by the ruling — no light band, no gleam;
//  the fringe is the one geometry. Letter-for-letter mirrored.
const OCTOPUS_SQUARE: string[] = [
  '.............', // 0  (empty top pair — the Zzz breathes here)
  '.............', // 1
  '..MMMMMMMMM..', // 2  the rounded-square crown
  '.MMMMMMMMMMM.', // 3
  '.MEEEMMMEEEM.', // 4  eye clusters
  '.MEKEMMMEKEM.', // 5
  '.MMMMMMMMMMM.', // 6
  '.MMMMMMMMMMM.', // 7
  '.MMMMMMMMMMM.', // 8  the mantle runs uniform
  '.MMMMMMMMMMM.', // 9
  '.M.M.M.M.M.M.', // 10 arm stubs…
  '.C.C.C.C.C.C.', // 11 …over deep curl tips
]

const OCTOPUS_SQUARE_DOCK: string[] = [
  '..MMMMMMM..', // 0  the rounded-square crown
  '.MMMMMMMMM.', // 1
  '.MEEEMEEEM.', // 2  eye clusters
  '.MEKEMEKEM.', // 3
  '.MMMMMMMMM.', // 4  uniform mantle
  '.M.M.M.M.M.', // 5  the arm fringe
]

/** The octopus — only the deepest arm tips curl (the mantle and the arm fan
 *  never move); every flow covers whole row-pairs, so no line is ever
 *  sheared against its pair partner. */
const OCTOPUS: CritterDef = {
  name: 'octopus',
  hue: OCTOPUS_HUE,
  hueDeep: OCTOPUS_HUE_DEEP,
  mark: { pre: '▝', core: '▜▆▛', post: '▘' }, // dome over arms
  art: OCTOPUS_ART,
  heroArt: OCTOPUS_HERO,
  mini: OCTOPUS_MINI,
  markCompact: OCTOPUS_MARK_COMPACT,
  square: OCTOPUS_SQUARE,
  squareDock: OCTOPUS_SQUARE_DOCK,
  sleep: {
    art: { art: OCTOPUS_ART_SLEEP, flow: 2 },
    hero: { art: OCTOPUS_HERO_SLEEP, flow: 2 },
    mini: { art: OCTOPUS_MINI_SLEEP, flow: 2 },
  },
  flow: { art: 2, hero: 2, mini: 2 },
}

// ── JELLYFISH ───────────────────────────────────────────────────────────────
//  A smooth WIDE dome, LOW-SET eyes just above the skirt (E sclera beside a
//  lidding P pupil — the flat eye seam fires on P-over-P pairs, so these
//  blink), a lit rim, and dangling tentacles built from offset whole-cell
//  segments at varied lengths. The dangle (rows 8–11, flow.art = 4) is a
//  MIRRORED silhouette at varied depths — outer pair one full line, mid pair
//  a half-line deep tip, inner pair the longest — the hero's balanced-envelope
//  language at 13 wide, kept inside cols 1–11 so the lossless sway rule can
//  move every dangle row.
const JELLYFISH_ART: string[] = [
  '...MMMMMMM...', // 0  bell crown
  '..MMMMMMMMM..', // 1
  '.MMMMMMMMMMM.', // 2
  'MMMMMMMMMMMMM', // 3
  'MMMEMMMMMEMMM', // 4  eyes on the bell
  'MMMPMMMMMPMMM', // 5  P pupils under the eyes — the blink rides
  'LLLLLLLLLLLLL', // 6  belly rim
  '.M.M.M.M.M.M.', // 7  tentacle ROOTS — the anchored row (never sways)
  '.M.C.M.M.C.M.', // 8  six strands continue; deep-accent shade mirrored
  '.C...M.M...C.', // 9  outer tips turn deep; the mid pair ends
  '.....C.C.....', // 10 the inner pair runs longest…
  '.............', // 11 …and closes as crisp half-block tips
]

//  The hero: a smooth WIDE dome filling the slot's width, the L highlight on
//  the upper-left curve, m falloff on the right edge, LOW-SET rectangular
//  eyes on the dome's bottom pair, a scalloped tooth edge, and SEVEN
//  tentacles of genuinely varied length built from whole-cell zigzag segments
//  (every segment holds both rows of its pair; the offsets stagger BETWEEN
//  pairs). 18 rows — the dome plus the LONG dangle fill the 9-line hero slot.
//  flow.hero = 8: everything below the anchored root row undulates.
const JELLYFISH_HERO: string[] = [
  '.......LLMMMMM..........', //  0 bell crown
  '.....LLMMMMMMMMM........', //  1
  '....LMMMMMMMMMMMm.......', //  2
  '...LMMMMMMMMMMMMMm......', //  3
  '...MMEEMMMMMMEEMMm......', //  4 eye clusters
  '...MMEKMMMMMMEKMMm......', //  5
  '...mMMMMMMMMMMMMMm......', //  6
  '...mMMMMMMMMMMMMMm......', //  7 one more body row down
  '...%%%%%%%%%%%%%%%......', //  8 belly rim
  '....M..M..M..M..M.......', //  9 tentacle ROOTS — anchored (never sways)
  '....M..M..M..M..M.......', // 10 everything below undulates (flow.hero = 8)
  '....M..C..M..C..M.......', // 11
  '.....M.C..M..C.M........', // 12
  '.....C..C.M.C..C........', // 13
  '........C.M.............', // 14
  '..........C.............', // 15
  '.........C..............', // 16 the strands run two rows longer —
  '...........C............', // 17 the second half of the dangle
]

//  The mini at 3 lines: highlight patch on the crown, LOW-SET sclera+pupil
//  eyes, lit rim, and staggered strands. flow.mini = 2: the rim-and-strands
//  pair rocks whole (no intra-pair shear).
const JELLYFISH_MINI: string[] = [
  '..%%MMMMM..', // dome crown with the top-left highlight
  '.MMMMMMMMM.',
  '.MEPMMMPEM.', // low-set eyes — sclera E beside the lidding P pupil
  '.MEPMMMPEM.',
  '.LLLLLLLLL.', // the lit skirt rim
  '.M.C.M.C.M.', // strands at varied depths
]

const JELLYFISH_MARK_COMPACT: string[] = [
  '..%%MMMM..', // 0  centered crown mass; the top-left highlight patch stays
  '.MMMMMMMM.', // 1
  '.MEPMMPEM.', // 2  low-set sclera+iris eyes
  '.MEPMMPEM.', // 3
  '.LLLLLLLL.', // 4  lit skirt rim
  '.M.C..C.M.', // 5  thin strands — a mirrored fall at varied depths
]

//  Asleep the jellyfish sinks: the bell drops low in the slot and the
//  tentacles hang LIMP and straight (the awake zigzag relaxes); its open E/K
//  eyes lid through heroBlinkRows / the P seam like every other sleeper.
const JELLYFISH_ART_SLEEP: string[] = [
  '.............', // 0  (empty top pair — the Zzz breathes here)
  '.............', // 1
  '...MMMMMMM...', // 2  crown settled low (the breath row)
  '..MMMMMMMMM..', // 3
  '.MMMMMMMMMMM.', // 4
  'MMMmMMMMMmMMM', // 5  lids where the eyes rest
  'MMMMMMMMMMMMM', // 6
  'LLLLLLLLLLLLL', // 7  rim
  '.M.M.M.M.M.M.', // 8  roots drift with the limp strands in sleep
  '.M.C.M.M.C.M.', // 9  the awake dangle's mirrored language, settled
  '.C...M.M...C.', // 10
  '.....C.C.....', // 11 inner tips pooled beneath
]

const JELLYFISH_HERO_SLEEP: string[] = [
  '........................', //  0
  '........................', //  1
  '........................', //  2
  '........................', //  3
  '.......LLMMMMM..........', //  4 crown settled low (the breath row)
  '.....LLMMMMMMMMM........', //  5
  '....LMMMMMMMMMMMm.......', //  6
  '...LMMMMMMMMMMMMMm......', //  7
  '...MMmmMMMMMMmmMMm......', //  8 lids where the eyes rest
  '...mMMMMMMMMMMMMMm......', //  9
  '...%%%%%%%%%%%%%%%......', // 10 rim
  '....M..M..M..M..M.......', // 11 roots
  '....M..M..M..M..M.......', // 12 limp strands
  '.....M....M....M........', // 13
  '.....M....M....M........', // 14
  '.....C....M....C........', // 15
  '..........M.............', // 16 the sway pair — sparse drifting tips
  '..........C.............', // 17
]

const JELLYFISH_MINI_SLEEP: string[] = [
  '...........', // 0
  '...........', // 1
  '..MMMMMMM..', // 2  bell sunk (the breath row)
  '.MEPMMMPEM.', // 3  low eyes (P seam lids)
  '.LLLLLLLLL.', // 4  rim
  '.M.C.M.C.M.', // 5  limp strands
]

//  THE SQUARE JELLYFISH — the geometric tier: a square bell, LOW-SET
//  hero-class eye clusters (the species' beat), the lit skirt rim as a
//  whole row-pair (species anatomy — the band registry carries it), and a
//  strand fringe of whole cells at mirrored depths. Letter-for-letter
//  mirrored.
const JELLYFISH_SQUARE: string[] = [
  '.............', // 0  (empty top pair — the Zzz breathes here)
  '.............', // 1
  '..MMMMMMMMM..', // 2  the square bell crown
  '.MMMMMMMMMMM.', // 3
  '.MMMMMMMMMMM.', // 4
  '.MMMMMMMMMMM.', // 5
  '.MEEEMMMEEEM.', // 6  low-set eyes, just above the rim
  '.MEKEMMMEKEM.', // 7
  '.%%%%%%%%%%%.', // 8  the lit skirt rim (species anatomy — registered band)
  '.%%%%%%%%%%%.', // 9
  '.M.C.M.M.C.M.', // 10 strand fringe, whole cells…
  '.M.C.M.M.C.M.', // 11 …deep accents mirrored
]

const JELLYFISH_SQUARE_DOCK: string[] = [
  '..MMMMMMM..', // 0  the square bell crown
  '.MMMMMMMMM.', // 1
  '.MEEEMEEEM.', // 2  low-set eyes
  '.MEKEMEKEM.', // 3
  '.%%%%%%%%%.', // 4  the lit skirt rim (registered band)
  '.M.C.M.C.M.', // 5  the strand fringe
]

/** The jellyfish — the FLOWY one: every row below the tentacle roots
 *  undulates, each line lagging the one above, so a wave travels down the
 *  strands (hero 8 = every row below the anchored root row). */
const JELLYFISH: CritterDef = {
  name: 'jellyfish',
  hue: JELLYFISH_HUE,
  hueDeep: JELLYFISH_HUE_DEEP,
  mark: { pre: '▚', core: '▛▀▜', post: '▞' }, // raised bell, trailing edges
  art: JELLYFISH_ART,
  heroArt: JELLYFISH_HERO,
  mini: JELLYFISH_MINI,
  markCompact: JELLYFISH_MARK_COMPACT,
  square: JELLYFISH_SQUARE,
  squareDock: JELLYFISH_SQUARE_DOCK,
  sleep: {
    art: { art: JELLYFISH_ART_SLEEP, flow: 4 },
    hero: { art: JELLYFISH_HERO_SLEEP, flow: 2 },
    mini: { art: JELLYFISH_MINI_SLEEP, flow: 2 },
  },
  flow: { art: 4, hero: 8, mini: 2 },
}

// ── CLAM ────────────────────────────────────────────────────────────────────
//  An opened bivalve sitting on the sand — squat, symmetrical, centred:
//   · the OPEN SHELL — the top valve lifted like a visor over a dark interior
//     band (D), the one silhouette nothing else in the pool has;
//   · the HINGE — a deep-accent umbo (C) at the crown's apex, the knob the
//     two valves pivot on, and the point the ribbing radiates from;
//   · RADIAL RIBBING — C grooves fanning from the umbo down the top valve
//     (each groove a dark diagonal on the lit dome) and C ribs converging
//     toward the base on the bottom valve — anatomy in the clam's own deep
//     accent, like the crab's CLAW legs; the shadow letters stay shading;
//   · EYES INSIDE THE SHELL — bright P-pair irises (flat/mini/compact) or
//     3×2 E clusters with the K centred low (hero) glowing in the dark gap,
//     so the blink lids ride like every other critter's and critterGaze's
//     per-eye tracking keys on the hero clusters;
//   · a CASTELLATED LIP over a GAP ROW — the valve's edge as whole-cell teeth
//     with the dark interior showing in every notch, then one pure-D row
//     before the eyes: the opening reads as a real mouth, and that gap row is
//     what the VALVE SETTLE covers (the top rows drop onto it on the settle
//     phases, so the shell breathes without a single eye cell ever touched);
//   · the MANTLE BAND (%) along the bottom valve's opening;
//   · a FLAT BASE — the bottom valve's shadowed under-edge on the ground
//     line. No foot, no siphon, no tendrils: a clam has no limbs to sway.
//   · a THIN DOME, MIRRORED: the top valve is one row-pair (flat) / two lines
//     (hero) — the crown with the umbo over the groove row(s) — so the shell
//     is squat, not top-heavy; and every row mirrors LETTER FOR LETTER about
//     the grid's centre column. A symmetric shell is lit from ABOVE, not from
//     the family's upper-left: the crown wears the L highlight on both sides
//     of the hinge, both flanks fall off into m alike, and the K pupils are
//     the only cells the render is ever allowed to move off-axis
//     (critterGaze).
const CLAM_ART: string[] = [
  '....LLCLL....', // 0  crown: lit from above on both sides of the umbo (hinge knob) at the apex
  '.mMMMCMCMMMm.', // 1  the fan grooves leave the umbo one column out; both flanks fall off
  '.MDMMDMDMMDM.', // 2  the lip: castellated teeth, the dark interior in every notch
  '..DDDDDDDDD..', // 3  the gap row (the settle covers this, never the eyes)
  '..DPPDDDPPD..', // 4  the open interior — eyes glow inside the shell
  '..DPPDDDPPD..', // 5
  '.%%%%%%%%%%%.', // 6  the mantle band along the opening
  '.MCMMCMCMMCM.', // 7  bottom valve: ribs converge toward the base
  '..MCMMCMMCM..', // 8
  '...CCCCCCC...', // 9  the flat base sitting on the sand
]

//  The hero at 14 rows / 7 lines: the umbo as a 2×2 deep-accent knob at the
//  crown's apex (rows 0–1, cols 11–12); the TOP VALVE a THIN dome (rows 0–3,
//  two lines: the crown pair and one groove pair) carrying FOUR fan grooves
//  that radiate from the umbo — the inner pair one column per row from the
//  knob, the outer pair two — each a run of deep-accent cells on the lit body
//  that runs straight into a notch of the lip beneath it; the LIP (row 4)
//  over one pure-D GAP ROW (row 5); the INTERIOR as a D band inset one column
//  from the valve edges with the EYES inside it (rows 6–7); the MANTLE BAND
//  (row 8); the BOTTOM VALVE as a ribbed dish (rows 9–12) narrowing to a
//  shaded under-edge and a FLAT BASE (row 13). Content bounds [2,22) — 20
//  wide, EVEN, so the 24-col hero slots centre it EXACTLY (2 + 20 + 2); the
//  7-line shell bottom-anchors in the 9-line slot with two lines of air
//  above, sitting on the plinth. settle.hero = 5: rows 0–4 (crown, dome,
//  lip) drop one row onto the gap row on the settle phases and rise again.
const CLAM_HERO: string[] = [
  '.........LLCCLL.........', //  0 crown: lit from above on both sides of the umbo at the apex
  '.......LLMMCCMMLL.......', //  1 the hinge knob runs the crown's centre pair
  '....mMMMCMMCCMMCMMMm....', //  2 the outer grooves leave the umbo; both flanks fall off
  '..mMMMCMMMCMMCMMMCMMMm..', //  3 four grooves fan across the dome, flush with the lip
  '..MDMMDMMMDMMDMMMDMMDM..', //  4 the lip: teeth, the dark interior in every notch — one under each groove
  '...DDDDDDDDDDDDDDDDDD...', //  5 the gap row (the settle covers this, never the eyes)
  '...DDDEEEDDDDDDEEEDDD...', //  6 the open interior — eye clusters glow inside
  '...DDDEKEDDDDDDEKEDDD...', //  7 the K pupils centred low, gaze-trackable
  '..%%%%%%%%%%%%%%%%%%%%..', //  8 the mantle band along the opening
  '..mMCMMMCMMMMMMCMMMCMm..', //  9 bottom valve: ribs converge toward the base
  '..mMMCMMMCMMMMCMMMCMMm..', // 10
  '...mMMCMMMCMMCMMMCMMm...', // 11 the dish narrows…
  '....mMMCMMMCCMMMCMMm....', // 12 …the inner ribs meet under the shell…
  '.....CCCCCCCCCCCCCC.....', // 13 …on the flat base sitting on the sand
]

//  The mini at 3 lines: the raised top valve (lit from above either side of
//  the deep umbo at the apex, two fan grooves, both flanks falling off alike)
//  over the dark interior with its two glowing iris pairs, then the mantle
//  band riding the ribbed bottom valve, which sits FLAT on the sand. Already
//  one row-pair of top valve, so it mirrors letter for letter instead of
//  compressing; settle.mini = 1: the crown row drops onto the dome row for
//  the settle phases, so even the three-line form breathes with its valve.
const CLAM_MINI: string[] = [
  '..LLMCMLL..', // crown + umbo (the settle row — one column in from the valve, so the dip never narrows the shell by more)
  '.mMMCMCMMm.', // the raised valve with its fan grooves
  '.DPPDDDPPD.', // the open interior — eyes glow inside the shell
  '.DPPDDDPPD.',
  '.%%%%%%%%%.', // the mantle band along the opening…
  '.MCMMMMMCM.', // …over the ribbed valve sitting flat on the sand
]

const CLAM_MARK_COMPACT: string[] = [
  '..LMCCML..', // 0  the raised top valve lit from above, the deep hinge knob at the apex
  '.mMMCCMMm.', // 1  (the umbo runs down the crown's centre pair; both flanks fall off alike)
  '.DPPDDPPD.', // 2  the open interior — iris pairs glow inside the shell
  '.DPPDDPPD.', // 3
  '.%%%%%%%%.', // 4  the mantle band along the opening
  '.MCMMMMCM.', // 5  ribbed bottom valve sitting flat on the sand
]

//  Asleep the clam is SHUT: the top valve settles onto the bottom one, the
//  open gap and its eyes disappear behind the closed D seam with lids at the
//  eye spots (a closed clam is the one silhouette that says asleep by itself
//  — breath only, flow 0). The shut shell keeps the compact, mirrored
//  language of the awake grids: same row count per form, same content width,
//  letter-for-letter mirrored; the top pair stays empty for the bubbles.
const CLAM_ART_SLEEP: string[] = [
  '.............', // 0  (empty top pair — the bubbles rise here)
  '.............', // 1
  '....LLCLL....', // 2  the shut shell, settled low: crown + umbo (the breath row)
  '.mMMMCMCMMMm.', // 3  the fan grooves
  '.MMmmCMCmmMM.', // 4  lids where the eyes rest behind the seam
  '.DDDDDDDDDDD.', // 5  the closed seam — the open gap is gone
  '.MCMMCMCMMCM.', // 6  ribbed bottom valve
  '..MCMMCMMCM..', // 7
  '...mMMCMMm...', // 8  the dish narrows…
  '...CCCCCCC...', // 9  …onto the flat base on the sand
]

const CLAM_HERO_SLEEP: string[] = [
  '........................', //  0
  '........................', //  1
  '........................', //  2
  '........................', //  3
  '.........LLCCLL.........', //  4 the shut shell, settled low: crown + umbo (the breath row)
  '.......LLMMCCMMLL.......', //  5
  '....mMMMCMMCCMMCMMMm....', //  6 the fan grooves leave the umbo
  '..mMMMCMMMCMMCMMMCMMMm..', //  7
  '..MMMMmmmCMMMMCmmmMMMM..', //  8 lids where the eyes rest behind the seam
  '..DDDDDDDDDDDDDDDDDDDD..', //  9 the closed seam — the open gap is gone
  '..mMCMMMCMMMMMMCMMMCMm..', // 10 ribbed bottom valve, ribs converging
  '..mMMCMMMCMMMMCMMMCMMm..', // 11
  '....mMMCMMMCCMMMCMMm....', // 12 the dish settles…
  '.....CCCCCCCCCCCCCC.....', // 13 …onto the flat base on the sand
]

const CLAM_MINI_SLEEP: string[] = [
  '...........', // 0
  '...........', // 1
  '..LLMCMLL..', // 2  the shut shell: crown + umbo (the breath row)
  '.MmmMCMmmM.', // 3  lids where the eyes rest
  '.DDDDDDDDD.', // 4  the closed seam
  '.MCMMMMMCM.', // 5  ribbed bottom valve flat on the sand
]

//  THE SQUARE CLAM — the geometric tier: a square shell whose one geometry
//  is its own — the deep umbo at the apex, a castellated lip, the dark open
//  gap with the eye clusters glowing inside, the mantle band (species
//  anatomy — registered), a ribbed bottom valve on a flat base. The clam's
//  every form mirrors letter for letter; the square keeps the family rule.
const CLAM_SQUARE: string[] = [
  '.............', // 0  (empty top pair — the bubbles rise here)
  '.............', // 1
  '.MMMMMCMMMMM.', // 2  the square top valve, the deep umbo at the apex
  '.MDMMDCDMMDM.', // 3  the castellated lip — interior in every notch
  '.DEEEDDDEEED.', // 4  the open gap — eye clusters glow inside
  '.DEKEDDDEKED.', // 5
  '.%%%%%%%%%%%.', // 6  the mantle band (species anatomy — registered band)
  '.%%%%%%%%%%%.', // 7
  '.MCMMMCMMMCM.', // 8  ribbed bottom valve
  '.MCMMMCMMMCM.', // 9
  '.CCCCCCCCCCC.', // 10 the flat base on the sand
  '.CCCCCCCCCCC.', // 11
]

const CLAM_SQUARE_DOCK: string[] = [
  '.MMMMCMMMM.', // 0  top valve + the umbo
  '.DDDDDDDDD.', // 1  the open gap
  '.DEEEDEEED.', // 2  eye clusters inside the shell
  '.DEKEDEKED.', // 3
  '.%%%%%%%%%.', // 4  the mantle band (registered band)
  '.CCCCCCCCC.', // 5  the flat base
]

/** The clam — NO flow: a clam has no limbs to sway and its valves never
 *  shear. It breathes with its shell instead — the VALVE SETTLE (the raised
 *  valve drops one row onto the gap row for the settle phases of the same
 *  sway cycle, then rises: crown, dome and lip onto the gap row) — and
 *  sleeps under BUBBLES, not a Zzz. */
const CLAM: CritterDef = {
  name: 'clam',
  hue: CLAM_HUE,
  hueDeep: CLAM_HUE_DEEP,
  mark: { pre: '▗', core: '▙█▟', post: '▖' }, // the opened shell on the sand
  art: CLAM_ART,
  heroArt: CLAM_HERO,
  mini: CLAM_MINI,
  markCompact: CLAM_MARK_COMPACT,
  square: CLAM_SQUARE,
  squareDock: CLAM_SQUARE_DOCK,
  sleep: {
    art: { art: CLAM_ART_SLEEP, flow: 0 },
    hero: { art: CLAM_HERO_SLEEP, flow: 0 },
    mini: { art: CLAM_MINI_SLEEP, flow: 0 },
  },
  settle: { art: 3, hero: 5, mini: 1 },
  sleepGlyphs: CLAM_SLEEP_GLYPHS,
}

// ============================================================================
//  THE POOL — the four critters in the launcher's order (crab · octopus ·
//  jellyfish · clam), the key resolvers, and the per-form accessors.
// ============================================================================

export const CRITTERS: CritterDef[] = [CRAB, OCTOPUS, JELLYFISH, CLAM]

/** The number of critters in the pool — the modulus for variant assignment
 *  (critterVariant). */
export const CRITTER_COUNT = CRITTERS.length

/** The critter DEF at a variant index, folded into the pool by true modulo (so a
 *  negative or out-of-range index still resolves). The pool is never empty, so this
 *  never returns undefined. */
export function critterAt(i: number): CritterDef {
  return CRITTERS[((i % CRITTERS.length) + CRITTERS.length) % CRITTERS.length]!
}

/** The critter POSE set — the 6 poses critterData's grids can render, and the target
 *  of toCritterState's BuddyState→pose collapse (critterVariant.ts). */
export type CritterState = 'thinking' | 'working' | 'blocked' | 'done' | 'sleeping' | 'idle'

/** The pool default — the creature an unset, unknown, or RETIRED key resolves
 *  to: the JELLYFISH. It is the unset boot default, so the first creature a
 *  fresh operator meets is the same one a stale saved key lands on — one
 *  answer, not two — and its cyan family aligns with the product's default
 *  accent. A PERSISTED pick (GlobalConfig.defaultCritter / MERCURY_CRITTER)
 *  resolves before this constant is ever consulted. */
export const DEFAULT_CRITTER_KEY = 'jellyfish'

/** Every key the estate answers to — the four pool critters by name, and
 *  nothing else. */
const BY_KEY: Record<string, CritterDef> = Object.fromEntries(CRITTERS.map(d => [d.name, d]))

/** RETIRED-KEY READ-SIDE RESOLUTION: a stored spelling that named a critter
 *  the pool no longer carries resolves to the creature that REPLACED it —
 *  at read, and only at read (config values are never heal-repainted: the
 *  stored bytes stay whatever the operator's file says). The mantis shrimp's
 *  spellings read as the clam, which holds its slot AND its colour family, so
 *  a saved default keeps its hues and its picker position across the swap.
 *  A retired key with no successor ('dragon') is deliberately absent — it
 *  takes the pool-default fallback below, same as any unknown key.
 *  sessionAccent's poolKeyOr and the splash's accentFamilyKeyOf mirror THIS
 *  table, so the shape half and the colour half can never disagree about
 *  which creature a stale key became. */
export const LEGACY_CRITTER_KEYS: Readonly<Record<string, string>> = {
  mantis: 'clam',
  'mantis shrimp': 'clam',
}

/** The ONE key-normalisation step every shape lookup shares: pool keys pass
 *  through, retired spellings land on their successor, anything else takes
 *  the bounded fallback to the pool default. */
function resolvePoolKey(key: string | undefined | null): string {
  const k = (key ?? '').trim().toLowerCase()
  if (Object.hasOwn(BY_KEY, k)) return k
  const legacy = LEGACY_CRITTER_KEYS[k]
  if (legacy !== undefined && Object.hasOwn(BY_KEY, legacy)) return legacy
  return DEFAULT_CRITTER_KEY
}

/** THE resolver. A key that does not exist — a persisted
 *  GlobalConfig.defaultCritter, an inherited MERCURY_CRITTER in a child
 *  process's env, an old session file — takes the BOUNDED FALLBACK to the pool
 *  default rather than throwing or painting blank art; a RETIRED key with a
 *  successor resolves to that creature (LEGACY_CRITTER_KEYS). Never returns
 *  undefined. */
export function critterDefForKey(key: string | undefined | null): CritterDef {
  return BY_KEY[resolvePoolKey(key)]!
}

/** True when `key` names a live pool critter. The ONE membership test —
 *  sessionAccent's key resolution and the retired-key fallback both read it,
 *  so "what counts as a critter" can never drift between the shape half and
 *  the colour half of the system. */
export function isPoolCritterKey(key: string | undefined | null): boolean {
  return Object.hasOwn(BY_KEY, (key ?? '').trim().toLowerCase())
}

/** The mini grid for a critter key/name. Same bounded contract as
 *  critterDefForKey: an unknown key resolves to the pool default rather than
 *  throwing, and a retired key to its successor (LEGACY_CRITTER_KEYS).
 *  Render via CritterArt with `{...def, art: miniArtFor(k)}`. */
export function miniArtFor(key: string | undefined | null): string[] {
  return BY_KEY[resolvePoolKey(key)]!.mini
}

/** The 10×6 compact mark for a critter key — AUTHORED, PARKED (the concourse
 *  header re-sourced to squareDockArtFor; zero
 *  product readers, prove-concourse-critter §10 holds the line). Same
 *  bounded contract as every resolver here: unknown/unset lands on the pool
 *  default rather than throwing, and a retired key resolves to its
 *  successor. A copy, so a caller's own edits never reach the record. */
export function markCompactArtFor(key: string | undefined | null): string[] {
  return BY_KEY[resolvePoolKey(key)]!.markCompact.slice()
}

/** The 13×12 SQUARE grid for a critter key (the berth's sub-hero tier).
 *  Same bounded contract as critterDefForKey. Returns the STABLE record
 *  array, never a copy — the gaze's cluster scan and the painter's frame
 *  cache key by grid OBJECT, so a fresh copy per call would cold-start
 *  them on every pointer event. Callers treat it read-only. */
export function squareArtFor(key: string | undefined | null): string[] {
  return BY_KEY[resolvePoolKey(key)]!.square
}

/** The 11×6 square DOCK grid for a critter key (the 80x24 deck dock).
 *  Stable reference, same contract as squareArtFor. */
export function squareDockArtFor(key: string | undefined | null): string[] {
  return BY_KEY[resolvePoolKey(key)]!.squareDock
}

/** The authored sleep pose for a def's form, or null for a name outside the
 *  pool (a def without a pose sleeps in its awake grid, lid-only — honest
 *  degradation, never a wrong body). Keyed by pool NAME: render sites hand
 *  this whole tinted defs, and the name survives the tint wrappers where
 *  object identity does not. */
export function sleepPoseFor(def: Pick<CritterDef, 'name'>, form: ArtForm): SleepPose | null {
  return BY_KEY[def.name]?.sleep[form] ?? null
}

// ============================================================================
//  GEOMETRY — content bounds, the fixed slot heights, the form decision.
// ============================================================================

/** The bounds computed per grid OBJECT. The authored grids are module
 *  constants that are never mutated, and the gaze asks for the hero grid's
 *  bounds on every pointer event — so each grid is scanned once. A
 *  transient grid (a transformed frame) takes its entry with it. The tuple
 *  is shared: callers destructure it, never write it. */
const BOUNDS_BY_GRID = new WeakMap<readonly string[], [number, number]>()

/** PURE content bounds of a hero grid: the [start, end) column extent that
 *  actually carries pixels, so render sites can slice + center the art in a
 *  frame instead of dragging trailing empty columns. Full-empty grids return
 *  [0, width). */
export function heroContentBounds(art: string[]): [number, number] {
  const known = BOUNDS_BY_GRID.get(art)
  if (known !== undefined) return known
  let start = Number.MAX_SAFE_INTEGER
  let end = 0
  for (const row of art) {
    for (let i = 0; i < row.length; i++) {
      if (row[i] !== '.') {
        if (i < start) start = i
        if (i + 1 > end) end = i + 1
      }
    }
  }
  const bounds: [number, number] = start >= end ? [0, Math.max(...art.map(r => r.length), 0)] : [start, end]
  BOUNDS_BY_GRID.set(art, bounds)
  return bounds
}

/** Terminal lines the TALLEST hero grid renders to (half-block pairing:
 *  ceil(gridRows/2)) across every def. The grids are NOT equal height, so any
 *  surface that keeps the hero mounted across a /critter or fable morph must pin
 *  its art slot to THIS height (bottom-anchored) — otherwise a swap shifts the
 *  plinth and everything below it (the cockpit center column's stability
 *  contract). Derived from the grids themselves so a redrawn sprite can't
 *  silently break the fixed-height promise. */
export const HERO_ART_LINES: number = CRITTERS.reduce(
  (max, def) => Math.max(max, Math.ceil((def.heroArt?.length ?? 0) / 2)),
  0,
)

/** Terminal lines of the tallest FLAT (13-col) grid through the half-block
 *  pairer — the fixed slot height for flat-form mounts (the berth's compact
 *  tier), same stability contract as HERO_ART_LINES: a critter switch swaps
 *  pixels, never rows. Derived from the grids so a taller authored sprite
 *  can't silently overflow the slot. */
export const FLAT_ART_LINES: number = CRITTERS.reduce(
  (max, def) => Math.max(max, Math.ceil(def.art.length / 2)),
  0,
)

/** Terminal lines of the tallest SQUARE grid through the half-block pairer —
 *  the fixed slot height for the berth's square tier. Equals FLAT_ART_LINES
 *  with today's authored grids (12 rows), so the tier swap moves pixels,
 *  never rows; derived from the grids so a redrawn square can't silently
 *  overflow the slot. */
export const SQUARE_ART_LINES: number = CRITTERS.reduce(
  (max, def) => Math.max(max, Math.ceil(def.square.length / 2)),
  0,
)

/** The rendered form for a critter mount, decided over the ACTUAL ALLOCATED
 *  cells — never an OS name, never a landing-furniture floor reused against a
 *  different surface (the cockpit's centre column is its own allocation). */
export type CritterForm = 'hero' | 'premium-compact' | 'mini' | 'none'

/** The cockpit tier floor: the smallest center-column height that carries
 *  the hero-art treatment in its compact (berth) arrangement — the cockpit's
 *  own 26-row physical floor minus the frame pair. Below it the 13-wide
 *  mini is the honest small-terminal form (a floor, not the default). */
export const PREMIUM_COMPACT_MIN_ROWS = 24

/** The berth hero floor, DERIVED from the two facts the decision actually
 *  trades between:
 *
 *    · The adjudicated content bound. Allocation 28 (the 120×30 cockpit's
 *      center: physical rows − the frame pair) carries the full content laws
 *      under the FLAT band (prove-journey-width-matrix §height, green at
 *      120×30) and clips the question card under the HERO band — the card's
 *      true minimum sits between those two transcript budgets.
 *    · The hero band's extra cost. The berth's art slot grows from
 *      FLAT_ART_LINES to HERO_ART_LINES (+3 with today's authored grids;
 *      derived live, so a redrawn sprite moves this floor with it).
 *      Worst case by construction — a taller capsule column absorbs part of
 *      the delta, never adds to it.
 *
 *  28 + (HERO_ART_LINES − FLAT_ART_LINES) is therefore the smallest
 *  allocation where the hero band provably leaves the transcript at least
 *  the adjudicated-sufficient budget (header and composer rows cancel out of
 *  the inequality). */
export const BERTH_HERO_MIN_ROWS: number = 28 + (HERO_ART_LINES - FLAT_ART_LINES)

/**
 * Decide the form for the ALLOCATED (columns × rows) a mount actually has.
 * Pure and deterministic — resize/minimize-restore replay the same table.
 * Consumed by the renderer AND the width budget, so the two can never drift:
 *  · hero            — the full premium treatment (the landing/172×46 class);
 *  · premium-compact — the AUTHORED hero grid in the compact berth
 *                      arrangement (the 120×30 tier — deliberate, never an
 *                      accidental fallback);
 *  · mini            — the 13-wide authored grid (small-terminal floor);
 *  · none            — below every width floor (render nothing, never clip).
 * The decision is the FORM alone. The premium-compact tier requires a
 * deliberately AUTHORED mid-height form (design input — operator-gated);
 * until that art exists the honest form below the hero floor is the mini.
 * decideCritterForm stays the ONE owner.
 */
export function decideCritterForm(
  allocated: { columns: number; rows: number },
  hasHeroArt: boolean,
): CritterForm {
  const { columns, rows } = allocated
  if (columns < CR_COLS + 2) return 'none'
  if (!hasHeroArt || columns < HERO_ART_COLS + 4) return 'mini'
  return rows >= BERTH_HERO_MIN_ROWS ? 'hero' : 'mini'
}

// ============================================================================
//  THE TRANSFORMS — pure grid transforms in one register: a frame is a LETTER
//  SWAP or a bounded row shift over an authored grid, never a second
//  pipeline. Every one of them is width-preserving by construction, so a
//  moving critter can never change the geometry its mount budgeted for.
// ============================================================================

/** PURE blink transform for a hero grid: on eye-pair rows (a row containing a
 *  K pupil, or whose half-block PAIR row does — rows pair as (0,1),(2,3),…)
 *  every cream/pupil cell becomes the mid shade — a closed lid. Non-eye cream
 *  is untouched because those rows carry no K (a cream row lids only when its
 *  pair carries a pupil). Width-preserving by construction. */
export function heroBlinkRows(art: string[]): string[] {
  return art.map((row, i) =>
    row.includes('K') || (art[i ^ 1]?.includes('K') ?? false)
      ? row.replace(/[EK]/g, 'm')
      : row,
  )
}

// ── the sway ────────────────────────────────────────────────────────────────

/** The sway cycle, and the reason it is EIGHT phases rather than four. Each
 *  rendered LINE of an extremity lags the line above it by one phase, so the
 *  displacement TRAVELS down the strand instead of sliding the whole fringe as
 *  one block. With a four-phase [0,+1,0,−1] cycle that lag put ADJACENT lines a
 *  full column apart in every single frame, and each bend was a hard kink;
 *  holding each offset for two phases means neighbouring lines usually share a
 *  displacement — the strand stays whole, the bend is a travelling seam, and
 *  the authored rest pose is still a real frame in the cycle. */
const SWAY_OFFSETS: readonly number[] = [0, 0, 1, 1, 0, 0, -1, -1]
export const SWAY_PHASES = SWAY_OFFSETS.length

// (The sway/sleep CADENCES are timing, not shape — they live with the rest of
//  the critter clock in critterIdle.ts. This module owns only the cycle
//  LENGTHS, because the transforms below are indexed by them.)

/** Shift one row laterally by `off` columns, PRESERVING WIDTH — and refuse the
 *  shift outright if it would push a painted cell off either end. The refusal
 *  is the art rule, not just a safety net: a limb that already reaches the grid
 *  edge holds its place while the inner ones drift, so the outermost arms read
 *  as the anchors. Returns the row unchanged for off === 0. */
function shiftRowLossless(row: string, off: number): string {
  if (off === 0) return row
  const n = Math.abs(off)
  const edge = off > 0 ? row.slice(row.length - n) : row.slice(0, n)
  if (/[^.]/.test(edge)) return row // a painted cell would fall off — hold
  return off > 0
    ? '.'.repeat(n) + row.slice(0, row.length - n)
    : row.slice(n) + '.'.repeat(n)
}

/**
 * PURE undulation: the bottom `depth` rows of `art` shift on the sway cycle.
 * The lag steps per rendered LINE (half-block row-PAIR), not per row — the two
 * rows of a pair paint the same terminal cells, so lagging them separately
 * would shear every flowing edge into a ▀▄ ribbon on the transition phases.
 * Deeper lines take EARLIER phases, so each line repeats what the line above
 * did one step ago — the wave genuinely travels DOWN the limb. Rows above the
 * depth are returned byte-identical (the anchored mass); depth <= 0 ⇒ the grid
 * unchanged, so a critter with no `flow` is render-identical to its static
 * frame.
 */
export function swayRows(art: string[], depth: number, phase: number): string[] {
  if (depth <= 0 || art.length === 0) return art.slice()
  const first = Math.max(0, art.length - depth)
  const firstLine = Math.floor(first / 2)
  return art.map((row, i) => {
    if (i < first) return row
    const lag = Math.floor(i / 2) - firstLine
    const off = SWAY_OFFSETS[(((phase - lag) % SWAY_PHASES) + SWAY_PHASES) % SWAY_PHASES]!
    return shiftRowLossless(row, off)
  })
}

/** The rows a def's given FORM undulates (0 when it has no authored flow). */
export function flowDepthFor(def: CritterDef, form: ArtForm): number {
  return def.flow?.[form] ?? 0
}

// ── the valve settle ────────────────────────────────────────────────────────
//  The sway moves extremities sideways; a clam has none, and shifting any
//  row of a shell sideways shears its valves against each other. What a
//  bivalve actually does at rest is gape and settle: the raised valve drops
//  a little and lifts again. So the clam's idle is a VERTICAL transform in
//  the same register as swayRows — a pure, bounded, width-preserving move of
//  authored rows on the shared sway clock, never a second pipeline.

/** The rows a def's given FORM settles (0 when it has no authored settle). */
export function settleDepthFor(def: CritterDef, form: ArtForm): number {
  return def.settle?.[form] ?? 0
}

/** The first settle phase of the cycle — the representative of every phase
 *  whose offset is positive (settleRows drops the valve on exactly those). */
const SETTLE_PHASE = SWAY_OFFSETS.findIndex(off => off > 0)

/**
 * PURE settle: on the SETTLE PHASES of the sway cycle (the phases whose
 * offset is positive — two of eight, so the shell holds its authored open
 * pose three quarters of the time and narrows once per cycle) the top
 * `depth` rows drop ONE row: row 0 empties, rows 1…depth take rows 0…depth−1,
 * and the row at `depth` is COVERED by the lip above it. The author's
 * contract is that the covered row is a pure-shade gap row — never an eye
 * row — so the eye seams below are untouched by construction (the prover
 * pins it per form). Every other phase returns the grid byte-identical, so
 * a def without `settle` is render-identical to its static frame. Width-
 * and row-count-preserving; content bounds can only stay or shrink.
 */
export function settleRows(art: string[], depth: number, phase: number): string[] {
  if (depth <= 0 || depth >= art.length) return art.slice()
  const off = SWAY_OFFSETS[((phase % SWAY_PHASES) + SWAY_PHASES) % SWAY_PHASES]!
  if (off <= 0) return art.slice()
  return art.map((row, i) => {
    if (i === 0) return '.'.repeat(row.length)
    if (i > depth) return row
    const from = art[i - 1]!
    return from.length === row.length ? from : (from + '.'.repeat(row.length)).slice(0, row.length)
  })
}

/**
 * The sway phase a FRAME actually depends on. The shared clock advances the
 * packed key's sway digit every tick of its cadence for EVERY critter, but
 * a frame reads that digit only where a transform consumes it: the sway
 * (flow rows), the settle (a positive offset or not), and asleep the breath
 * (odd or even). A still critter's frame reads none of it. Folding the
 * digit onto the value the transforms see means an edge that moves nothing
 * never reaches the painter (the memo bails on an unchanged primitive),
 * and every value returned here renders byte-identical to the raw phase by
 * construction — swayRows and settleRows are the identity at depth 0, the
 * settle is the same drop on every positive-offset phase, and the breath
 * reads parity alone.
 */
export function effectiveSwayPhase(def: CritterDef, form: ArtForm, asleep: boolean, phase: number): number {
  const p = ((phase % SWAY_PHASES) + SWAY_PHASES) % SWAY_PHASES
  if (asleep) {
    const pose = sleepPoseFor(def, form)
    if (pose !== null) {
      // A pose flows with its own depth and breathes on parity; it never settles.
      return pose.flow > 0 ? p : p % SLEEP_BREATH_FRAMES
    }
  }
  if (flowDepthFor(def, form) > 0) return p
  if (settleDepthFor(def, form) > 0) return SWAY_OFFSETS[p]! > 0 ? SETTLE_PHASE : 0
  return 0
}

// ── the sleep frame ─────────────────────────────────────────────────────────

/**
 * The sleep SLOTS for a grid: the columns of the RIGHTMOST run of columns
 * that are empty in BOTH rows of the top row-pair, capped at `count` (the
 * def's ladder length — the Zzz's three by default) and returned
 * left→right. Empty-only by construction — a sleep glyph can never
 * overwrite a painted cell — and a grid whose top pair is full simply
 * yields no slots and sleeps without a glyph (honest degradation, never
 * clipped art).
 */
export function sleepZzzSlots(art: string[], count: number = SLEEP_PHASES): number[] {
  const top = art[0]
  const bot = art[1]
  if (top === undefined || bot === undefined) return []
  const width = Math.max(top.length, bot.length)
  const free = (c: number): boolean => (top[c] ?? '.') === '.' && (bot[c] ?? '.') === '.'
  let end = -1
  for (let c = width - 1; c >= 0; c--) {
    if (free(c)) {
      end = c
      break
    }
  }
  if (end < 0) return []
  const slots: number[] = []
  for (let c = end; c >= 0 && free(c) && slots.length < count; c--) slots.push(c)
  return slots.reverse()
}

/**
 * PURE sleep frame: writes the sleep-glyph cells into the top row-pair's
 * free slots for the given phase, climbing one glyph per phase from the
 * right and ending whole, looping forever:
 *   three slots (the Zzz): 0 → the nearest z alone · 1 → two · 2 → all three;
 *   four slots (the clam's bubbles): 0 → the nearest two · 1 → three · 2 → all four.
 * A run shorter than the climb lights what it has (min(n, phase + 1)). The
 * creature's own pixels are untouched; the closed EYES are not this
 * transform's job — a sleeping critter is rendered with the lidded pupil
 * signal, which lids the flat P-pairs and (via heroBlinkRows) the hero
 * clusters through the paths that already exist.
 */
export function sleepZzzArt(art: string[], phase: number, count: number = SLEEP_PHASES): string[] {
  const slots = sleepZzzSlots(art, count)
  if (slots.length === 0) return art.slice()
  const p = ((phase % SLEEP_PHASES) + SLEEP_PHASES) % SLEEP_PHASES
  // slots run left→right; the NEAREST glyph (the one that appears first) is
  // the rightmost, and the climb adds glyphs leftward-up from it.
  const lit = new Set<number>()
  const n = slots.length
  const litCount = Math.min(n, Math.max(p + 1, n - (SLEEP_PHASES - 1 - p)))
  for (const c of slots.slice(n - litCount)) lit.add(c)
  const paint = (row: string): string =>
    row
      .split('')
      .map((ch, c) => (lit.has(c) ? SLEEP_CELL : ch))
      .join('')
  return art.map((row, i) => (i < 2 ? paint(row) : row))
}

/** The breath cycle length — pose frames alternate A/B on the slow sleep
 *  drift (AnimatedCritterArt keys it off the sway phase: no new clock). */
export const SLEEP_BREATH_FRAMES = 2

/**
 * PURE breath: on the exhale frame the pose dips half a cell — the topmost
 * painted row's cells clear wherever the row beneath still carries paint, so
 * the top edge of the body drops from a full block to its lower half. Cells
 * whose under-neighbour is empty hold (no floating half-pixels are ever
 * created), and frame 0 is the identity. Width- and row-count-preserving by
 * construction; content bounds can only stay or shrink.
 */
export function sleepBreathArt(art: string[], frame: number): string[] {
  if (((frame % SLEEP_BREATH_FRAMES) + SLEEP_BREATH_FRAMES) % SLEEP_BREATH_FRAMES === 0) {
    return art.slice()
  }
  const crown = art.findIndex(r => /[^.]/.test(r))
  if (crown < 0) return art.slice()
  const below = art[crown + 1] ?? ''
  const dipped = art[crown]!
    .split('')
    .map((ch, c) => (ch !== '.' && (below[c] ?? '.') !== '.' ? '.' : ch))
    .join('')
  return art.map((row, i) => (i === crown ? dipped : row))
}
