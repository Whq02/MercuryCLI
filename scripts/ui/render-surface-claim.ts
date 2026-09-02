// ============================================================================
//  render-surface-claim — the SURFACE-CLAIM invariant, behaviorally
//
//
//  The failure this pins: opening a command surface whose panel is
//  SHORTER than the viewport left the rows above the modal pane's ▔ divider
//  showing the UNDERLYING home mid-relayout (the sheared splash hero). The
//  pane's maxHeight was a CAP, not a claim.
//
//  THE LAW SINCE LUSTRE L1 — two modes, both captured here on the real
//  binary (PTY ≈25s × 3; joins the ui suite under UI_RENDER=1):
//
//    · BLANK CLAIM (MERCURY_RECESS=0): the exact assertion — zero
//      non-blank cells above the divider, at both claim chromes (120 cockpit
//      · 80 deck-strip). The flag-off path IS the pre-LUSTRE surface.
//
//    · LAYERED CLAIM (default): the rows above the divider carry the LIVE
//      cockpit, RECESSED — asserted mechanically against the exported
//      recess math: at least one cell above the divider wears an EXPECTED
//      recessed ink (mixToward(brand ink, NIGHT, RECESS_MIX)); ZERO cells
//      above the divider wear any full-strength brand ink (nothing escapes
//      the recess); the panel BELOW the divider does wear full-strength ink
//      (the elevated surface is the one bright plane). The sheared-splash
//      class stays dead — what shows is the settled recessed cockpit.
//
//  Structural sibling (always-on): scripts/ui/prove-surface-claim.ts.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sanitizePath } from '../../src/utils/sessionStoragePortable.ts'
import { resolveProofHome } from '../lib/proofHome.ts'
import { mixToward, RECESS_MIX } from '../../src/ink/cell-grid.ts'
import {
  AMBER, CRIMSON, FAINT, IVORY, OASIS, SECOND, TEAL, TERRA, NIGHT,
} from '../../src/components/mercuryPalette.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
// CI-portability: derive the checkout root — never a machine literal.
const RUNTIME_CWD = join(import.meta.dir, '..', '..')

const REPO = join(new URL('.', import.meta.url).pathname, '../..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(REPO, 'scripts/ui/vshot.py')
// The proof's config home (scripts/lib/proofHome.ts): the inherited pin, else
// a fresh seeded scratch — the fixture below and the spawned binary share it.
const CONFIG_HOME = resolveProofHome([RUNTIME_CWD])
const PROJECTS = join(CONFIG_HOME, 'projects', sanitizePath(RUNTIME_CWD))
const SID = `00000000-aaaa-bbbb-eeee-${(process.pid % 0xffffff).toString(16).padStart(12, '0')}`

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures++
}

// Minimal resumable session (the same shape renderScenarios' 'short' stages).
const base = (extra: Record<string, unknown>) => ({
  isSidechain: false, userType: 'external', entrypoint: 'cli',
  cwd: RUNTIME_CWD, sessionId: SID,
  version: '1.0.0-beta.1', gitBranch: 'main', ...extra,
})
const lines = [
  base({
    parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-000000000001',
    message: { role: 'user', content: 'first task' },
    timestamp: '2026-06-19T13:00:01.000Z',
  }),
  base({
    parentUuid: '00000000-0000-4000-8000-000000000001', type: 'user',
    uuid: '00000000-0000-4000-8000-000000000002',
    message: { role: 'user', content: 'second task' },
    timestamp: '2026-06-19T13:00:02.000Z',
  }),
]
if (!existsSync(PROJECTS)) mkdirSync(PROJECTS, { recursive: true })
const fixture = join(PROJECTS, `${SID}.jsonl`)
writeFileSync(fixture, lines.map(l => JSON.stringify(l)).join('\n') + '\n')

type Cell = { c: string; fg: string; bg: string }
type Grid = { grid: Cell[][] }

function capture(cols: number, extraEnv: Record<string, string>): Grid | null {
  const grid = `/tmp/render-surface-claim-grid-${cols}.json`
  const cfgPath = `/tmp/render-surface-claim-cfg-${cols}.json`
  writeFileSync(cfgPath, JSON.stringify({
    argv: ['node', BIN, '--resume', SID],
    sends: [{ atTick: 30, data: '/trace' }, { atTick: 36, data: '\r' }],
    total: 56, cols, rows: 44, out: grid,
  }))
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
    encoding: 'utf-8', timeout: vshotBudgetMs(90000),
    // Split-home guard: fixture under CONFIG_HOME vs the env-less fork child's
    // ~/.mercury (sovereign-home flip) — pin the pair to ONE home.
    env: {
      ...process.env, MERCURY_CONFIG_DIR: CONFIG_HOME,
      ...extraEnv,
    },
  })
  if (res.status !== 0) {
    console.error(`✗ vshot failed @${cols}: ${res.stderr?.slice(0, 300)}`)
    return null
  }
  return JSON.parse(readFileSync(grid, 'utf-8')) as Grid
}

function findDivider(g: Grid): { div: number; rows: string[] } {
  const rows = g.grid.map(line => line.map(c => c.c).join('').trimEnd())
  const div = rows.findIndex(r => r.startsWith('▔'.repeat(40)))
  return { div, rows }
}

// ── Leg 1: BLANK CLAIM under MERCURY_RECESS=0 (the pre-LUSTRE invariant) ─────
function assertBlankClaim(cols: number, label: string): void {
  const g = capture(cols, { MERCURY_RECESS: '0' })
  if (!g) { failures++; return }
  const { div, rows } = findDivider(g)
  check(div >= 0, `${label}: modal ▔ divider present (row ${div})`)
  if (div < 0) return
  const panelBelow = rows.slice(div + 1).some(r => r.includes('Mercury — trace'))
  check(panelBelow, `${label}: /trace panel rendered below the divider`)
  const dirty = rows
    .slice(0, div)
    .map((r, i) => ({ i, r }))
    .filter(({ r }) => r.length > 0)
  check(
    dirty.length === 0,
    `${label}: all ${div} rows above the divider are blank` +
      (dirty.length ? ` — LEAKED: ${dirty.map(d => `r${d.i}=${JSON.stringify(d.r.slice(0, 40))}`).join(' · ')}` : ''),
  )
}

// ── Leg 2: LAYERED CLAIM (default) — the recess law above the divider ───────
const hexOf = (c: string): [number, number, number] | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim())
  if (!m) return null
  const v = m[1]!
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)]
}
const BRIGHT = [IVORY, SECOND, FAINT, TERRA, TEAL, AMBER, CRIMSON, OASIS].map(h =>
  h.slice(1).toLowerCase(),
)
const NIGHT_RGB = hexOf(NIGHT)!
const RECESSED = BRIGHT.map(h => {
  const [r, g, b] = mixToward(hexOf(h)!, NIGHT_RGB, RECESS_MIX)
  return `${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
})

function assertLayeredClaim(cols: number, label: string): void {
  const g = capture(cols, {})
  if (!g) { failures++; return }
  const { div, rows } = findDivider(g)
  check(div >= 0, `${label}: modal ▔ divider present (row ${div})`)
  if (div < 0) return
  const panelBelow = rows.slice(div + 1).some(r => r.includes('Mercury — trace'))
  check(panelBelow, `${label}: /trace panel rendered below the divider`)
  const above = g.grid.slice(0, div).flat()
  const below = g.grid.slice(div + 1).flat()
  const fgs = (cells: Cell[]) => cells.filter(c => c.c.trim().length > 0).map(c => c.fg.toLowerCase())
  const aboveFgs = new Set(fgs(above))
  const belowFgs = new Set(fgs(below))
  const recessedSeen = RECESSED.filter(h => aboveFgs.has(h))
  check(
    recessedSeen.length >= 1,
    `${label}: the backdrop above the divider wears RECESSED ink (saw ${recessedSeen.length} expected tones)`,
  )
  const brightLeaks = BRIGHT.filter(h => aboveFgs.has(h))
  check(
    brightLeaks.length === 0,
    `${label}: zero full-strength brand inks above the divider` +
      (brightLeaks.length ? ` — LEAKED: ${brightLeaks.join(',')}` : ''),
  )
  const brightBelow = BRIGHT.filter(h => belowFgs.has(h))
  check(
    brightBelow.length >= 1,
    `${label}: the elevated surface below the divider IS full-strength (saw ${brightBelow.length} brand inks)`,
  )
}

// 120 cols = cockpit chrome, 80 cols = deck-strip chrome — the two claim
// flavors; the blank-claim leg pins the flag-off path at both, the layered
// leg pins the recess law at the cockpit (the richest backdrop).
assertBlankClaim(120, 'blank claim @120 (MERCURY_RECESS=0)')
assertBlankClaim(80, 'blank claim @80 (MERCURY_RECESS=0)')
assertLayeredClaim(120, 'layered claim @120')

try { rmSync(fixture) } catch { /* fixture */ }

console.log(failures === 0 ? '✅ surface claim GREEN' : `❌ surface claim RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
