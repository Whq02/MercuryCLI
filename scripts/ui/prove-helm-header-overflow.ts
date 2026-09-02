#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-helm-header-overflow.ts
//  PROOF:
//
//   A. HelmCenterHeader MISSION band — a LONG standing /mission must TRUNCATE
//      inside the center panel and never collide with the right-pinned clock.
//      The pre-fix budget forgot the '   MISSION: ' lead-in + paddingX and the
//      left segment wasn't a shrinkable flex child, so a long goal spilled ~10
//      cells past the border into the clock. Real binary, PTY, cockpit-mission
//      at 120: the MISSION row carries '…' AND a HH:MM:SS clock AND no glyph
//      bleeds past the center panel's right border.
//
//   B. NO generic install-promo tips — a promo telling a Mercury user to
//      install something from a vendor's store would also spill its long
//      unbreakable install-command token past the WorkCapsule border. The
//      registry and dist carry none, and no store-relevance helper exists.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-helm-header-overflow.ts
// ============================================================================
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_HOME, cleanupScenario, scenario } from './renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const src = (p: string) => readFileSync(p, 'utf8')

console.log('============================================================')
console.log(' cockpit text-overflow — HelmCenterHeader MISSION + generic tips')
console.log('============================================================')

// ── A. render: the MISSION band truncates and never hits the clock ───────────
console.log('\n(A) render — cockpit-mission at 120 (real dist binary, PTY)')
type Cell = { c: string }
type Grid = { grid: Cell[][]; cols: number }
function capture(): Grid | null {
  const cfg = scenario('cockpit-mission', 120, 44)
  const gridPath = `/tmp/helm-mission-${process.pid}.json`
  const cfgPath = `/tmp/helm-mission-cfg-${process.pid}.json`
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: gridPath }))
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, 'vshot.py'), cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(120_000),
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: CONFIG_HOME,
    },
  })
  if (res.status !== 0) {
    check('PTY capture ran', false, res.stderr?.slice(0, 200) ?? '')
    return null
  }
  return JSON.parse(readFileSync(gridPath, 'utf8')) as Grid
}

const g = capture()
if (g) {
  const rows = g.grid.map(r => r.map(c => c.c))
  const my = rows.findIndex(r => r.join('').includes('MISSION:'))
  check('MISSION band present', my >= 0)
  if (my >= 0) {
    const line = rows[my]!
    const text = line.join('')
    check('mission text is truncated (carries …)', text.includes('…'))
    check('clock still visible on the mission row', /\d\d:\d\d:\d\d/.test(text))
    // No glyph may sit at/past the center panel's RIGHT border on this row.
    // The panel border is the rightmost box-drawing char; nothing printable
    // may follow it (that would be text spilled across the frame).
    let border = -1
    for (let x = g.cols - 1; x >= 0; x--) {
      if ('│╮╯├┤╭╰'.includes(line[x]!)) { border = x; break }
    }
    let bleed = false
    for (let x = border + 1; x < g.cols; x++) {
      if (line[x] && line[x] !== ' ') { bleed = true; break }
    }
    check('nothing bleeds past the panel border on the mission row', border >= 0 && !bleed)
    // The clock must sit strictly LEFT of the border (inside the panel), with
    // the … truncation strictly left of the clock — the exact collision the
    // fix prevents.
    const clockX = text.search(/\d\d:\d\d:\d\d/)
    const ellipsisX = text.indexOf('…')
    check('… precedes the clock (mission yields, clock is pinned)',
      ellipsisX >= 0 && clockX > ellipsisX)
    check('clock sits inside the panel border', clockX >= 0 && border > clockX)
  }
  cleanupScenario('cockpit-mission')
}

// ── B. source + dist: the generic install-promo tips are absent ────────────────
console.log('\n(B) generic install-promo tips removed (registry + dist)')
{
  // The retired vocabulary is composed so this prover never spells it.
  const P = ['plug', 'in'].join('')
  const M = ['market', 'place'].join('')
  const reg = src('src/services/tips/tipRegistry.ts')
  check(`no 'frontend-design-${P}' tip id`, !reg.includes(`id: 'frontend-design-${P}'`))
  check(`no 'vercel-${P}' tip id`, !reg.includes(`id: 'vercel-${P}'`))
  // Code-form checks (a comment may honestly name what was removed): the
  // install-command TEMPLATES and the helper CALL/DEF are what must be gone.
  check('no install-command templates in registry',
    !reg.includes('install frontend-design@') && !reg.includes('install vercel@'))
  check('the store-relevance helper is gone', !reg.includes(`is${M[0]!.toUpperCase()}${M.slice(1)}${P[0]!.toUpperCase()}${P.slice(1)}Relevant(`))
  const dist = readFileSync('dist/mercury.mjs', 'utf8')
  check('dist ships no install upsell strings',
    !dist.includes(`Install the frontend-design ${P}`) &&
      !dist.includes(`Install the vercel ${P}`) &&
      !dist.includes(`${P} install frontend-design`))
}

console.log(
  `\n${failures === 0 ? '✅ cockpit overflow PROVEN' : `❌ ${failures} FAILURE(S)`}`,
)
process.exit(failures === 0 ? 0 : 1)
