#!/usr/bin/env bun
import { densityPlan, HELM_DENSITY_FLOOR } from '../../src/screen/fullscreen-layout/helmDensity.ts'

const D = 'src/screen/fullscreen-layout/helmDensity.ts'


let fail = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
}

t(
  'every mode sheds the workbench card first (geometry law: no shift elsewhere)',
  (['calm', 'active', 'waiting', 'review'] as const).every(
    activity => densityPlan(activity, 40).shedOrder[0] === 'workbench',
  ),
  `densityPlan must list 'workbench' first in shedOrder for every activity (${D})`,
)
t(
  'and no mode can shed a floor section (the product plan, all four activities)',
  (['calm', 'active', 'waiting', 'review'] as const).every(activity =>
    [40, 24].every(rows => {
      const plan = densityPlan(activity, rows)
      return !plan.shedOrder.some(section =>
        (HELM_DENSITY_FLOOR as readonly string[]).includes(section),
      )
    }),
  ),
  `densityPlan must never put a HELM_DENSITY_FLOOR section in shedOrder at 40 or 24 rows (${D})`,
)

if (fail) {
  console.log('\n❌ lanes-shed — failures above')
  process.exit(1)
}
console.log('\n✅ lanes-shed — plan · gates · node-driven render · pointer · measurement · kernel rows')
