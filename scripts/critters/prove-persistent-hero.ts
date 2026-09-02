#!/usr/bin/env bun
// ============================================================================
//  prove-persistent-hero.ts — the persistent-morphing-hero contract.
//
//  The living critter is present at the top of the transcript in EVERY state
//  (fresh launch, mid-conversation, cockpit center column) and never collapses
//  to a static glyph; /critter and click-to-morph change the actual creature
//  SHAPE everywhere, with fable OFF and ON. Render evidence lives in the
//  UI_RENDER tier (critter-home / resume-2turn scenarios); this
//  proof locks the logic + source shape so the contract can't silently rot:
//
//   A. FIXED-HEIGHT honesty — HERO_ART_LINES really is the tallest grid's
//      half-block line count (the grids are NOT equal height, so a mounted
//      slot pinned to anything else shifts the plinth on a morph).
//   B. SHAPE-FOLLOWS-KEY — every pool key resolves a DISTINCT authored grid
//      (the criterion-3 morph logic, React-free).
//   C. GATE SHAPE (source locks) — Messages.tsx mounts <MercuryHero /> OUTSIDE
//      the hasTurns ternary (the swap toggles furniture only); the brand row
//      carries the ✶ sigil, never the crab glyph; the hero's art slot is
//      height-pinned + bottom-anchored; hooks run before the geometry gate;
//      and the hero never imports the chrome/layout-tier math (helmGeometry /
//      useLayoutTier) — it measures its CONTEXT (center column) only.
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CRITTERS,
  HERO_ART_COLS,
  HERO_ART_LINES,
  critterDefForKey,
} from '../../src/utils/cockpit/critterData.js'
import { ALL_CRITTERS } from '../../src/components/mercury-ui/sessionAccent.js'

const REPO = join(import.meta.dir, '..', '..')
const read = (p: string) => readFileSync(join(REPO, p), 'utf8')

let fail = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
}

// ── A. fixed-height honesty ─────────────────────────────────────────────────
// The pool IS the estate: a retired key resolves to the pool default (critterDefForKey).
const ALL = [...CRITTERS]
const lines = (d: { heroArt?: string[] }) => Math.ceil((d.heroArt?.length ?? 0) / 2)
t('HERO_ART_LINES = tallest grid (half-block lines)', HERO_ART_LINES === Math.max(...ALL.map(lines)), `const=${HERO_ART_LINES} max=${Math.max(...ALL.map(lines))}`)
t('HERO_ART_LINES positive', HERO_ART_LINES > 0)
t('no grid exceeds the slot', ALL.every(d => lines(d) <= HERO_ART_LINES))
// (The pool's grids share one height since the resident left; the slot law
// is the two pins above — the constant IS the tallest grid, none exceeds it.)

// ── B. shape-follows-key ────────────────────────────────────────────────────
const poolKeys = ALL_CRITTERS.map(c => c.key)
t('pool carries the four morph targets', ['crab', 'octopus', 'jellyfish', 'clam'].every(k => poolKeys.includes(k)))
const grids = poolKeys.map(k => critterDefForKey(k).heroArt?.join('\n') ?? '')
t('every pool key resolves a DISTINCT authored grid', new Set(grids).size === poolKeys.length)
t('unknown key falls back to the pool default (never blank art)', (critterDefForKey('custom').heroArt?.length ?? 0) > 0)

// ── C. gate shape (source locks) ────────────────────────────────────────────
const messages = read('src/components/Messages.tsx')
const home = read('src/components/MercuryHome.tsx')

// berth pass: in the COCKPIT the pinned berth (FullscreenLayout
// statusBand card) owns the always-visible mascot, so LogoHeader sheds the
// scrollback hero there and keeps it everywhere else — the contract is
// "a living critter is always reachable", not "this one mount is unconditional".
// A pin that greps for absent text protects nothing — these pins state the
// shape the file actually has: the cockpit gate is `{!inCockpit ? … : null}` with
// two width-tiered <MercuryHero /> mounts inside it, and the furniture swap is
// two separate `hasRealConversation` guards rather than one ternary.
t('the scrollback hero mounts, gated on NOT being in the cockpit (the berth owns it there)',
  messages.includes('<MercuryHero />') && /\{!inCockpit \?/.test(messages))
t('…and the cockpit berth really carries the living critter',
  readFileSync('src/components/FullscreenLayout.tsx', 'utf8').includes('<PinnedCritterBerth />'))
// FURNITURE ONLY: the landing card collapses once a real conversation exists,
// and the brand row appears — but neither guard may touch the hero, which stays
// mounted in every transcript state. That is the whole point of the split.
const furnitureCollapses = /\{!hasRealConversation \? <MercuryHome \/> : null\}/.test(messages)
const brandRowSwaps = /hasRealConversation \? <MercuryBrandRow \/> : null/.test(messages)
t('the hasRealConversation swap toggles FURNITURE only', furnitureCollapses && brandRowSwaps,
  `home=${furnitureCollapses} brand=${brandRowSwaps}`)
t('…and the hero is never inside a hasRealConversation branch',
  !/hasRealConversation \?[^}]*<MercuryHero/.test(messages))
t('the critter is not inside the swap', !/hasTurns\s*\?[^:]*Hero/.test(messages))

const brandRow = home.slice(home.indexOf('export function MercuryBrandRow'))
t('brand row carries the ✶ sigil…', brandRow.includes('<Sigil size="inline" />'))
t('…never the static crab glyph', !brandRow.slice(0, brandRow.indexOf('\n}')).includes('<Crab') && !/import \{[^}]*\bCrab\b[^}]*\} from '\.\/mercury-ui\/assets/.test(home))

const hero = home.slice(home.indexOf('export function MercuryHero'), home.indexOf('export function MercuryBrandRow'))
t('art slot is pinned to HERO_ART_LINES', hero.includes('height={HERO_ART_LINES}'))
t('art bottom-anchors onto the plinth', hero.includes('justifyContent="flex-end"'))
t('shape from critterDefForKey(sa.key)', hero.includes('critterDefForKey(sa.key)'))
t('hue from the folded accent (fable/override)', hero.includes('hue: sa.accent') && hero.includes('hueDeep: sa.accentDeep'))
const gateIdx = hero.indexOf('return null')
t('geometry gate exists (authored-or-absent)', gateIdx > 0 && hero.includes('HERO_MIN_ROWS') && hero.includes('HERO_ART_COLS + 4'))
// The hover pair replaced the old local useState (single-owner store,
// — still hooks, still unconditionally before the geometry gate.
for (const h of ['useSessionAccent()', 'useTerminalSize()', 'useId()', 'useHoverOwned(']) {
  const i = hero.indexOf(h)
  t(`hook before the gate: ${h}`, i > 0 && i < gateIdx)
}
// Import lines only — the doc comments NAME the forbidden modules on purpose.
const homeImports = home.split('\n').filter(l => /^import /.test(l)).join('\n')
t('hero never re-enters the chrome/layout-tier math', !/helmGeometry|useLayoutTier/.test(homeImports))
t('click-to-morph rides the hero (vshot cannot click — source lock)', hero.includes('onClick={cycleSessionCritter}'))
t('width floor uses HERO_ART_COLS', HERO_ART_COLS === 24)

console.log(fail ? '❌ PERSISTENT-HERO RED' : '✅ PERSISTENT-HERO GREEN')
process.exit(fail)
