// ============================================================================
//  mercury-ui/assets — runtime-safe brand glyph components.
//
//  The design system's brand art (crab, sigil) converted to ANSI-safe text per
//  do-not-port.md: the pixel-grid crab and rastered marks are reference-only;
//  the TERMINAL forms are (a) the half-block crab lockup `▖▟▆▙▗` and (b) the
//  compass-orbit sigil (the literal rows below), in four sizes.
//  No raster, no emoji. Colour is structural only — strip it (NO_COLOR) and the
//  shapes still read.
// ============================================================================

import * as React from 'react'
import { Box, Text, useTheme } from '../../ink.js'
import { critterDefForKey } from '../../utils/cockpit/critterData.js'
import { resolveMercuryTokens } from '../../utils/mercuryTokens.js'
import { FAINT } from '../mercuryPalette.js'
import { rampSegments } from './focalRamp.js'
import { displayWidth } from './glyphs.js'
import { TwinkleSpark } from './LiveGlyphs.js'
import { useGreetingShimmer } from './useGreetingShimmer.js'
import { useSessionAccent } from './sessionAccent.js'
import { useMercuryTokens } from './useMercuryTokens.js'

// The Mercury crab — the mascot silhouette compressed to a one-row glyph lockup.
// First cell MUST be ▖ (U+2596), never ▘ (component-inventory.md). Copied
// verbatim from MercuryFrame/Deck so every surface shows one identical mark.
export function Crab(): React.ReactNode {
  // Live accent: subscribes to the session critter so a /critter pick re-tints
  // the persistent frame crab (and every Crab lockup) IMMEDIATELY, no relaunch.
  const { accent, accentDeep } = useSessionAccent()
  return (
    <Text>
      <Text color={accentDeep}>▖</Text>
      <Text color={accent}>▟▆▙</Text>
      <Text color={accentDeep}>▗</Text>
    </Text>
  )
}

// Alias used by the design-system component inventory (CrabMark === Crab).
export const CrabMark = Crab

// The SESSION mark:
// the selected critter's AUTHORED one-line silhouette, same deep/main/deep
// grammar as the crab lockup. Session-identity slots (the statusline anchor,
// the exit farewell) render THIS instead of <Crab/>, so a non-crab session
// never reads as crab at one-line size — while the PRODUCT lockup
// (<Crab/> + <Wordmark/>) stays the true crab everywhere it names Mercury.
// A crab session renders byte-identically to <Crab/> (same glyphs, same
// live accent subscription).
export function SessionMark(): React.ReactNode {
  const sa = useSessionAccent()
  const { mark } = critterDefForKey(sa.key)
  return (
    <Text>
      <Text color={sa.accentDeep}>{mark.pre}</Text>
      <Text color={sa.accent}>{mark.core}</Text>
      <Text color={sa.accentDeep}>{mark.post}</Text>
    </Text>
  )
}

// The lockup as a PLAIN STRING for string-context call sites (borderText,
// padTo math, template literals). ONE source: ~35 files would otherwise re-declare
// `const CRAB='▖▟▆▙▗'` locally — a first-cell typo would have needed 35
// fixes and /critter could never re-tint them (sweep points them
// here; surfaces that can render JSX should prefer the accent-aware <Crab/>).
export const CRAB_GLYPHS = '▖▟▆▙▗'

// The Mercury wordmark: `Mercury` is the product word — TERRA bold — the visible
// brand identity. An optional faint version tail. A terminal
// can't shrink type, so hierarchy reads as the bold-accent weight. Uses the
// live session accent so the wordmark follows the critter / scribe glow.
export function Wordmark({
  version,
}: {
  version?: string
}): React.ReactNode {
  const { accent } = useSessionAccent()
  const t = useMercuryTokens()
  const [theme] = useTheme()
  // The command-center focal moment: the wordmark walks the
  // identity ramp resolved at the EFFECTIVE accent (R5, superseding
  // the CN-10 flat fallback): tokens memoize per (family × accent), so a fable
  // override derives a FABLE-red ramp of its own instead of collapsing flat —
  // the ramp IS the fable identity. Reduced-colour families still resolve a
  // single-stop ramp and collapse flat (the CN-08 law).
  const ramp = accent === t.accent ? t.focalRamp : resolveMercuryTokens(theme, accent).focalRamp
  // The greeting shimmer: the ramp's bloom sweeps the word
  // for ~10 s on mount, then settles into exactly these segments — degraded
  // states (reduced motion · MERCURY_LIVE_GLYPHS=0 · single-stop families ·
  // clock-less static prints) render the settled ramp from frame 0.
  const shimmer = useGreetingShimmer(ramp, displayWidth('Mercury'))
  const segments = rampSegments('Mercury', ramp, { shimmer })
  return (
    <Text>
      {segments.map((s, i) => (
        <Text key={i} bold color={s.color}>
          {s.text}
        </Text>
      ))}
      {version ? <Text color={t.textMuted}> v{version}</Text> : null}
    </Text>
  )
}

// A BIG pixel wordmark — "MERCURY" from a 5-pixel-row block alphabet, RENDERED at
// half-block scale (3 cell rows — see BigWordmark). The terminal can't resize the font
// (WezTerm has NO text-sizing support — a bare OSC 66 would render as NOTHING there;
// the terminal owns the font per docs/TERMINAL-PROFILE.md), so "bigger" is MORE CELLS:
// a hand-authored alphabet at ONE cell size. 100% portable, degrades to plain colored
// Unicode (strip color → shapes still read), on-brand with the chunky critter register.
// Re-tints with the session accent. (font-scale research 2026-07)
const BIG_FONT: Record<string, string[]> = {
  // Every stroke ORTHOGONALLY connected — diagonal-only adjacency fragments
  // at cell scale (the operator's 'awkward' read: U's detached bottom, Y's
  // floating arms, M's orphaned mid-pixel). Square corners match the
  // critters' blocky language.
  M: ['#...#', '#####', '#.#.#', '#...#', '#...#'],
  E: ['####', '#...', '###.', '#...', '####'],
  R: ['###.', '#..#', '###.', '#.#.', '#..#'],
  C: ['####', '#...', '#...', '#...', '####'],
  U: ['#..#', '#..#', '#..#', '#..#', '####'],
  Y: ['#...#', '#...#', '.###.', '..#..', '..#..'],
}
/** The banner's cell rows, as plain strings — a PURE primitive (the
 *  critterIdle.ts doctrine) so render proofs can pin the exact letterform a
 *  capture must contain instead of grepping for a literal the block font
 *  doesn't spell. */
export function bigWordmarkRows(): string[] {
  const word = 'MERCURY'
  const rows: string[] = []
  // HALF-BLOCK scale (task #66, operator: the 5-row block wordmark read too
  // large). The same authored letterforms, vertically packed 2 pixels per
  // cell with ▀/▄/█ — the critters' own sprite trick — so the wordmark drops
  // 5→3 rows with zero letterform drift and stays in the chunky register.
  for (let r = 0; r < 5; r += 2) {
    let s = ''
    for (let li = 0; li < word.length; li++) {
      const glyph = BIG_FONT[word[li]!] ?? []
      const top = glyph[r] ?? ''
      const bot = glyph[r + 1] ?? ''
      const w = Math.max(top.length, bot.length)
      for (let x = 0; x < w; x++) {
        const t = top[x] === '#'
        const b = bot[x] === '#'
        s += t && b ? '█' : t ? '▀' : b ? '▄' : ' '
      }
      if (li < word.length - 1) s += '  ' // 2-col letter gap (3 read airy at block scale — operator pass)
    }
    rows.push(s)
  }
  return rows
}

export function BigWordmark(): React.ReactNode {
  const { accent } = useSessionAccent()
  const t = useMercuryTokens()
  const [theme] = useTheme()
  // One shared ART-SPACE ramp: every row walks the SAME
  // effective-accent ramp across its own equal-width cells (bigWordmarkRows
  // pads every letter on every row), so same-x-same-colour, gaps advance,
  // and no per-letter restart hold by construction — the banner carries one
  // continuous material instead of a flat block. Reduced families resolve a
  // single stop and collapse flat exactly as before.
  const ramp = accent === t.accent ? t.focalRamp : resolveMercuryTokens(theme, accent).focalRamp
  // ONE shimmer phase across the equal-width rows: every
  // row applies the same greeting band at the same x, so the sweep is a
  // vertical light crossing the banner and same-x-same-colour holds
  // through every animated frame. Settles to the exact static ramp.
  const rows = bigWordmarkRows()
  const shimmer = useGreetingShimmer(ramp, displayWidth(rows[0] ?? ''))
  return (
    // flexShrink=0: the wordmark is IDENTITY — all-or-nothing (hero-morph
    // doctrine). Without it a row-squeezed center column sliced the 3-row
    // half-block art mid-glyph into garble (product-study r3); with it the
    // sibling transcript region absorbs the squeeze instead.
    <Box flexDirection="column" flexShrink={0}>
      {rows.map((s, r) => (
        <Text key={r}>
          {rampSegments(s, ramp, { shimmer }).map((seg, i) => (
            <Text key={i} color={seg.color}>
              {seg.text}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  )
}

// The ONE banner/compact form selector: banner only
// when BOTH shipped bars hold — the landing bigHero's 34-row height promise
// AND the 48-col floor that keeps the 42-cell banner from wrapping. Before
// this selector the two home states split the law (MercuryBrandRow tested
// both; MercuryHome tested rows alone), so a tall-narrow terminal wrapped
// the banner on the fresh home while the turns state stayed compact. The
// splash and setup ladders stay AUTHORED on purpose: their art sheds before
// actions per the ratified CN-14 degradation order (the HEADLESS-CARD
// inversion), which is a different contract than the home's banner/compact
// pair.
export function wordmarkForm(columns: number, rows: number): 'banner' | 'compact' {
  return rows >= 34 && columns >= 48 ? 'banner' : 'compact'
}

export type SigilSize = 'inline' | 'small' | 'medium' | 'large'

// The literal sigil rows. Lines/center = TERRA,
// the orbiting `·` dots = FAINT, the ✦ sparkles = the derived bloom.
const SMALL = ['╲ │ ╱', '──◉──', '╱ │ ╲']
const MEDIUM = ['   │', ' ╲ │ ╱', '───◉───', ' ╱ │ ╲', '   │']
const LARGE = [
  '        ✦        ·',
  '    ╭─────────────╮',
  '  ·                 ·',
  '           │',
  '         ╲ │ ╱',
  ' ·   ───── ◉ ─────   ·',
  '         ╱ │ ╲',
  '           │',
  '  ·                 ·',
  '    ╰─────────────╯',
  '       ·       ✦',
]

// Colour a single sigil row char-by-char: `·` FAINT, `✦`/`✶` the DERIVED
// bloom, rest the live accent. adjudication (the
// cross-family class inside authored art): the sparkles would otherwise wear
// the fixed crab BELLY, so an octopus session's sigil sparkled crab-pink;
// tokens.accentSoft derives per accent (crab byte-equal BELLY, so the crab
// renders identically). The dots stay FAINT — authored-neutral structure,
// recorded in the accent census.
function SigilRow({ row }: { row: string }): React.ReactNode {
  const { accent } = useSessionAccent()
  const t = useMercuryTokens()
  return (
    <Text>
      {[...row].map((ch, i) => {
        const color =
          ch === '·'
            ? FAINT
            : ch === '✦' || ch === '✶'
              ? t.accentSoft
              : ch === ' '
                ? undefined
                : accent
        return (
          <Text key={i} color={color}>
            {ch}
          </Text>
        )
      })}
    </Text>
  )
}

// The Mercury sigil. `inline` is a single ✶ glyph (for the statusbar); the rest
// are the multi-row compass-orbit star. Decorative — use in headers, empty
// states, splash, and planned-surface cards, never in dense rows.
export function Sigil({ size = 'small' }: { size?: SigilSize }): React.ReactNode {
  const { accent } = useSessionAccent()
  if (size === 'inline') {
    // The standing inline sigil GLINTS (✶→✦ one beat per ~9s cycle — the
    // star-family sibling of the hero blink). Both current homes are landing
    // furniture that unmounts off-screen; degraded states render the exact
    // static ✶ this branch always returned.
    return <TwinkleSpark color={accent} />
  }
  const rows = size === 'large' ? LARGE : size === 'medium' ? MEDIUM : SMALL
  return (
    <Box flexDirection="column">
      {rows.map((row, i) => (
        <SigilRow key={i} row={row} />
      ))}
    </Box>
  )
}
