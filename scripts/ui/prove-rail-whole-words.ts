#!/usr/bin/env bun
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'rail-whole-words-home-')))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const { fitRailName, railRowBudgets } = await import('../../src/components/HelmLanesRail.tsx')
const { railPlanAt, HELM_HOME_MIN_COLS } = await import('../../src/utils/helmGeometry.ts')
const { railPanelInnerWidth } = await import('../../src/components/mercury-ui/RailPanel.tsx')
const { LAYOUT_BREAKPOINTS } = await import('../../src/hooks/useLayoutTier.ts')
const { displayWidth } = await import('../../src/components/mercury-ui/glyphs.ts')

const USAGE_ROW = 'usage — after first reply'
const WORKFLOWS_ROW = '/workflows — crewmate runs'
const model = read('src/utils/cockpit/helmLanesModel.ts')
check('the two rows the live screen read are the lanes model’s own words', model.includes(`'${USAGE_ROW}'`) && model.includes(`'${WORKFLOWS_ROW}'`))

const nameBudget = (rowW: number, name: string): number => railRowBudgets(rowW - 2 - 2, displayWidth(name), 0, 3).name

console.log('§1 80 columns: no rail — the cockpit (and its rails) starts at 100')
check('80 < the cockpit minimum, so no rail row exists to cut', 80 < HELM_HOME_MIN_COLS && 80 < LAYOUT_BREAKPOINTS.cockpitMin && HELM_HOME_MIN_COLS === LAYOUT_BREAKPOINTS.cockpitMin)

console.log('§2 110 and 120 columns: one 24-column rail, a 20-column name budget')
for (const cols of [110, 120]) {
  const plan = railPlanAt(cols, false)
  check(`${cols}: one lanes rail of 24, vitals merged into it (unboxed rows)`, plan.lanes && !plan.vitals && plan.lanesW === 24, JSON.stringify(plan))
  const budget = nameBudget(plan.lanesW, WORKFLOWS_ROW)
  check(`${cols}: the name budget is the 20 the live screen showed`, budget === 20, String(budget))
  const usage = fitRailName(USAGE_ROW, budget)
  const wf = fitRailName(WORKFLOWS_ROW, budget)
  check(`${cols}: the usage row ends at its last whole word — "${usage}"`, usage === 'usage — after first…' && displayWidth(usage) <= budget)
  check(`${cols}: the workflows row ends at a whole word and never on the dash — "${wf}"`, wf === '/workflows…' && displayWidth(wf) <= budget)
}

console.log('§3 the slim tier (100) and the boxed both-rails tier (150) obey the same law')
{
  const slim = railPlanAt(100, false)
  check('100: the slim 20-column rail', slim.lanesW === 20)
  const slimBudget = nameBudget(slim.lanesW, WORKFLOWS_ROW)
  check(`100: "${fitRailName(WORKFLOWS_ROW, slimBudget)}" and "${fitRailName(USAGE_ROW, slimBudget)}" end on whole words in ${slimBudget}`, fitRailName(WORKFLOWS_ROW, slimBudget) === '/workflows…' && fitRailName(USAGE_ROW, slimBudget) === 'usage — after…')
  const wide = railPlanAt(150, true)
  const boxedRowW = railPanelInnerWidth(wide.lanesW)
  const wideBudget = nameBudget(boxedRowW, WORKFLOWS_ROW)
  const wf = fitRailName(WORKFLOWS_ROW, wideBudget)
  check(`150: both rails, boxed rows (${boxedRowW} wide, budget ${wideBudget}) — "${wf}" is whole words`, wide.vitals && (wf === WORKFLOWS_ROW || (wf.endsWith('…') && WORKFLOWS_ROW.startsWith(wf.slice(0, -1)) && WORKFLOWS_ROW[wf.length - 1] === ' ')))
}

console.log('§4 the law across every budget: whole words, the ellipsis, no dangling separator')
{
  const names = [
    USAGE_ROW,
    WORKFLOWS_ROW,
    '/health — health cert',
    '/mission — set a mission',
    'ctx 12% · 200k',
    'fold win-drives 57fa9c3913 (the proof-portability reds of a Windows build)',
    'reef-survey',
    'src/services/host/reliability.ts',
  ]
  let sound = true
  const faults: string[] = []
  for (const name of names) {
    for (let budget = 3; budget <= 40; budget++) {
      const out = fitRailName(name, budget)
      if (displayWidth(out) > budget) { sound = false; faults.push(`${budget}: "${out}" is wider than its budget`); continue }
      if (out === name) continue
      if (!out.endsWith('…')) { sound = false; faults.push(`${budget}: "${out}" lacks the ellipsis`); continue }
      const kept = out.slice(0, -1)
      const firstWord = name.split(' ')[0]!
      const wholeWords = name.startsWith(kept) && name[kept.length] === ' ' && !/[—–·-]$/.test(kept)
      const singleWordTooWide = displayWidth(firstWord) >= budget && name.startsWith(kept)
      if (!wholeWords && !singleWordTooWide) { sound = false; faults.push(`${budget}: "${out}" cuts inside a word`) }
    }
  }
  check('every cut lands after a whole word (a lone word wider than the budget is the one inside cut)', sound, faults.slice(0, 5).join(' | '))
  check('a name that fits is returned untouched', fitRailName(USAGE_ROW, 25) === USAGE_ROW && fitRailName(USAGE_ROW, 40) === USAGE_ROW)
  check('a separator never ends a row: "ctx 12% · 200k" in 11 reads "ctx 12%…"', fitRailName('ctx 12% · 200k', 11) === 'ctx 12%…')
}

console.log('§5 the row paints through the whole-word fit')
{
  const rail = read('src/components/HelmLanesRail.tsx')
  check('RailRow fits its name with fitRailName, never the inside cut', rail.includes('const nameT = fitRailName(name, budgets.name)') && !rail.includes('truncateToWidth(name, budgets.name)'))
}

console.log(failures === 0 ? '\nrail-whole-words: GREEN' : `\nrail-whole-words: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
