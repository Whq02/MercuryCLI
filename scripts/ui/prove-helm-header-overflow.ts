#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_HOME, cleanupScenario, scenario } from './renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — to fix: ${hint}` : ''}`)
}

console.log('============================================================')
console.log(' cockpit text-overflow — the standing mission + generic tips')
console.log('============================================================')

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
    check('PTY capture ran', false, res.stderr?.slice(0, 200) ?? '', 'run bun run build.ts so dist/mercury.mjs exists, then read the vshot.py error above')
    return null
  }
  return JSON.parse(readFileSync(gridPath, 'utf8')) as Grid
}

const g = capture()
if (g) {
  const rows = g.grid.map(r => r.map(c => c.c))
  const text = rows.map(r => r.join(''))
  check('no MISSION: row paints inside the centre pane (the pane opens on its border, then the berth card)', !text.some(t => t.includes('MISSION:')), '', 'the standing mission belongs only in the lanes rail MISSION box (missionSection in src/screen/cockpit-gauges/helm-lanes-model/sections.ts); remove the MISSION: row from the centre pane')
  const label = text.findIndex(t => /\bMISSION\b/.test(t))
  check('the standing mission lives in the lanes rail (its MISSION box)', label >= 0, '', 'missionSection in src/screen/cockpit-gauges/helm-lanes-model/sections.ts returns null unless the session is solo and a mission is set; check the cockpit-mission scenario in scripts/ui/renderScenarios.ts still seeds one')
  const spilled: number[] = []
  rows.forEach((line, y) => {
    if (!/Run a targeted|bug audit|hardening pass|workflow engine/.test(text[y]!)) return
    let border = -1
    for (let x = g.cols - 1; x >= 0; x--) {
      if ('│╮╯├┤╭╰'.includes(line[x]!)) { border = x; break }
    }
    if (border < 0) return
    for (let x = border + 1; x < g.cols; x++) {
      if (line[x] && line[x] !== ' ') { spilled.push(y); break }
    }
  })
  check('nothing bleeds past a panel border on the rows that carry the mission\'s words', spilled.length === 0, `rows ${spilled.join(',')}`, 'the mission text on those rows must be clipped to its panel; look at src/screen/fullscreen-layout/HelmLanesRail.tsx where the rail row is drawn')
  const paneTop = text.findIndex(t => /╭─+╮/.test(t))
  const paneFirst = text[paneTop + 1] ?? ''
  check('the centre pane\'s first interior row is the berth card\'s top edge or the transcript, never a title row', paneTop >= 0 && !/VIEW|MISSION:/.test(paneFirst), paneFirst.trim(), 'a title row (VIEW or MISSION:) is painted as the first interior row of the centre pane; remove it from the centre pane layout so the pane opens on the berth card or the transcript')
  cleanupScenario('cockpit-mission')
}

console.log('\n(B) generic install-promo tips removed (registry + dist)')
{
  const P = ['plug', 'in'].join('')
  const dist = readFileSync('dist/mercury.mjs', 'utf8')
  check('dist ships no install upsell strings',
    !dist.includes(`Install the frontend-design ${P}`) &&
      !dist.includes(`Install the vercel ${P}`) &&
      !dist.includes(`${P} install frontend-design`), '', 'an install promo tip is back in dist; remove it from the tip registry src/screen/tips/tipRegistry.ts (or wherever grep finds the string in src), then rebuild with bun run build.ts')
}

console.log(
  `\n${failures === 0 ? '✅ cockpit overflow PROVEN' : `❌ ${failures} FAILURE(S)`}`,
)
process.exit(failures === 0 ? 0 : 1)
