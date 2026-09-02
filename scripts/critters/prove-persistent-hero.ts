#!/usr/bin/env bun
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

const ALL = [...CRITTERS]
const lines = (d: { heroArt?: string[] }) => Math.ceil((d.heroArt?.length ?? 0) / 2)
t('HERO_ART_LINES = tallest grid (half-block lines)', HERO_ART_LINES === Math.max(...ALL.map(lines)), `const=${HERO_ART_LINES} max=${Math.max(...ALL.map(lines))}`)
t('HERO_ART_LINES positive', HERO_ART_LINES > 0)
t('no grid exceeds the slot', ALL.every(d => lines(d) <= HERO_ART_LINES))

const poolKeys = ALL_CRITTERS.map(c => c.key)
t('pool carries the four morph targets', ['crab', 'octopus', 'jellyfish', 'clam'].every(k => poolKeys.includes(k)))
const grids = poolKeys.map(k => critterDefForKey(k).heroArt?.join('\n') ?? '')
t('every pool key resolves a DISTINCT authored grid', new Set(grids).size === poolKeys.length)
t('unknown key falls back to the pool default (never blank art)', (critterDefForKey('custom').heroArt?.length ?? 0) > 0)

const messages = read('src/components/Messages.tsx')
const home = read('src/components/MercuryHome.tsx')

t('the scrollback hero mounts, gated on NOT being in the cockpit (the berth owns it there)',
  messages.includes('<MercuryHero />') && /\{!inCockpit \?/.test(messages))
t('…and the cockpit berth really carries the living critter',
  readFileSync('src/components/FullscreenLayout.tsx', 'utf8').includes('<PinnedCritterBerth />'))
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
t('hue from the folded accent (fable/scribe/override)', hero.includes('hue: sa.accent') && hero.includes('hueDeep: sa.accentDeep'))
const gateIdx = hero.indexOf('return null')
t('geometry gate exists (authored-or-absent)', gateIdx > 0 && hero.includes('HERO_MIN_ROWS') && hero.includes('HERO_ART_COLS + 4'))
for (const h of ['useSessionAccent()', 'useTerminalSize()', 'useId()', 'useHoverOwned(']) {
  const i = hero.indexOf(h)
  t(`hook before the gate: ${h}`, i > 0 && i < gateIdx)
}
const homeImports = home.split('\n').filter(l => /^import /.test(l)).join('\n')
t('hero never re-enters the chrome/layout-tier math', !/helmGeometry|useLayoutTier/.test(homeImports))
t('click-to-morph rides the hero (vshot cannot click — source lock)', hero.includes('onClick={cycleSessionCritter}'))
t('width floor uses HERO_ART_COLS', HERO_ART_COLS === 24)

console.log(fail ? '❌ PERSISTENT-HERO RED' : '✅ PERSISTENT-HERO GREEN')
process.exit(fail)
