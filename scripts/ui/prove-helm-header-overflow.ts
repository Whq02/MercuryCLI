#!/usr/bin/env bun
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
    const inner = text.replace(/[│╮╯├┤╭╰]\s*$/, '')
    const nameMatch = /(\S[^│]*?)\s*$/.exec(inner)
    const rightName = nameMatch ? nameMatch[1]!.trim() : ''
    check('the session\'s name sits on the mission row (never a clock)', rightName !== '' && !/\d\d:\d\d:\d\d/.test(text), `right segment: "${rightName}"`)
    let border = -1
    for (let x = g.cols - 1; x >= 0; x--) {
      if ('│╮╯├┤╭╰'.includes(line[x]!)) { border = x; break }
    }
    let bleed = false
    for (let x = border + 1; x < g.cols; x++) {
      if (line[x] && line[x] !== ' ') { bleed = true; break }
    }
    check('nothing bleeds past the panel border on the mission row', border >= 0 && !bleed)
    const nameX = rightName === '' ? -1 : text.lastIndexOf(rightName)
    const ellipsisX = text.indexOf('…')
    check('… precedes the name (mission yields, the name is pinned)',
      ellipsisX >= 0 && nameX > ellipsisX)
    check('the name sits inside the panel border', nameX >= 0 && border > nameX)
  }
  cleanupScenario('cockpit-mission')
}

console.log('\n(B) generic install-promo tips removed (registry + dist)')
{
  const P = ['plug', 'in'].join('')
  const M = ['market', 'place'].join('')
  const reg = src('src/services/tips/tipRegistry.ts')
  check(`no 'frontend-design-${P}' tip id`, !reg.includes(`id: 'frontend-design-${P}'`))
  check(`no 'vercel-${P}' tip id`, !reg.includes(`id: 'vercel-${P}'`))
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
