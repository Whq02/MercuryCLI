#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { densityPlan, HELM_DENSITY_FLOOR } from '../../src/utils/helmDensity.ts'

const ROOT = path.resolve(import.meta.dir, '../..')
const rail = readFileSync(path.join(ROOT, 'src/components/HelmLanesRail.tsx'), 'utf8')
const model = readFileSync(path.join(ROOT, 'src/utils/cockpit/helmLanesModel.ts'), 'utf8')
const density = readFileSync(path.join(ROOT, 'src/utils/helmDensity.ts'), 'utf8')
const fsl = readFileSync(path.join(ROOT, 'src/components/FullscreenLayout.tsx'), 'utf8')

let fail = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
}

t('shed plan exists and the model walks it', /for \(const k of density\.shedOrder\)/.test(model) && /buildLanesModel\(input\)/.test(rail))
t(
  'the pinned calm priority order lives at the density owner (workbench yields first — the ruled card adds itself without moving anything else; the party slot left with the seat retirement)',
  /const CALM_ORDER = \['workbench', 'next', 'recent', 'crew'\]/.test(density),
)
t(
  'no ladder revives the retired party slot',
  !density.includes("'party'"),
)
t(
  'no ladder names the retired chat section the rail lost with the two-seat coordination mode',
  !density.includes("'chat'"),
)
t(
  'every mode sheds the workbench card first (geometry law: no shift elsewhere)',
  (['calm', 'active', 'waiting', 'review'] as const).every(
    activity => densityPlan(activity, 40).shedOrder[0] === 'workbench',
  ),
)
t(
  'core sections are shed-immune',
  /HELM_DENSITY_FLOOR = \['work', 'tasks', 'runs', 'mission'\]/.test(density) &&
    /new Set<string>\(\[\.\.\.HELM_DENSITY_FLOOR/.test(model),
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
)
t('the cursor section is shed-immune (published-model lookup)', /cursorRow: published\[getHelmCursor\('lanes'\)\],/.test(rail) && /getHelmRows\('lanes'\)/.test(rail) && /const cursorSection = cursorSectionOf\(built, input\.cursorRow\)/.test(model) && /if \(cursorSection\) mustKeep\.add\(cursorSection\)/.test(model) && /helmRowSig\(r\.row\) === sig\) return s\.key/.test(model))
t('the ceiling is the measured availRows', /const shedCeiling = input\.availRows \?\? Infinity/.test(model) && /availRows,\n/.test(rail))

t(
  'the shed takes whole sections and the published rows come from the survivors',
  /const sections = built\.filter\(s => !shedSet\.has\(s\.key\)\)/.test(model) &&
    /for \(const s of sections\) for \(const r of s\.rows\) if \(r\.kind !== 'text' && r\.row !== undefined\) rows\.push\(r\.row\)/.test(model) &&
    /publishHelmRows\('lanes', model\.rows\)/.test(rail),
)
t('a shed section costs what it paints (the built rows, never a mirrored formula)', /spent -= costOf\(s\)/.test(model) && !/intents/.test(model) && !/intents/.test(rail))
t('crew builds only in the busy branch, and only when a crew or a kept id exists', /if \(solo\) return null\n\s+if \(crewEntries\.length === 0 && keptIds\.length === 0\) return null/.test(model))
t('chat builder stays retired with the two-seat coordination mode (no chatRows, no chat section)', !rail.includes('chatRows') && !model.includes('chatRows') && !model.includes("key: 'chat'") && !rail.includes("section('chat'"))
t('recent builds only in the solo branch', /const recentSection = \(\): LanesSectionSpec \| null => \{\n\s+if \(!solo\) return null/.test(model))
t('the retired notepad has no builder or shed slot', !/tabula/i.test(rail) && !/tabula/i.test(model) && !/tabula/i.test(density))
t('workbench builds in both branches as one selectable card', /const workbenchSection = \(\): LanesSectionSpec => \(\{/.test(model) && (model.match(/workbenchSection\(\)/g) ?? []).length === 2)
t('party builder stays retired (no partyPeers, no party section)', !rail.includes('partyPeers') && !model.includes('partyPeers') && !model.includes("key: 'party'") && !rail.includes("section('party'"))
t('next builds only in the solo branch', /const nextSection = \(\): LanesSectionSpec \| null => \{\n\s+if \(!solo\) return null/.test(model))

t('the rail paints the model sections and nothing else', /\{model\.sections\.map\(paintSection\)\}/.test(rail) && !/section\('/.test(rail))
t('solo order: work · recent · mission · workbench · next · files · saturn · vitals', /\? \[workSection\(\), recentSection\(\), missionSection\(\), workbenchSection\(\), nextSection\(\), filesSection\(\), saturnSection\(\), glanceSection\(\)\]/.test(model))
t('busy order: crew · work · runs · workbench · files · saturn · vitals', /: \[crewSection\(\), workSection\(\), runsSection\(\), workbenchSection\(\), filesSection\(\), saturnSection\(\), glanceSection\(\)\]/.test(model))
t('an empty section is never painted (recent and next answer null without rows)', (model.match(/if \(rows\.length === 0\) return null/g) ?? []).length >= 2)

t('shed pointer is display-only (no row-model entry)', /pointer: shed\.length > 0 \? shedPointerOf\(shed\) : null/.test(model) && /\{model\.pointer !== null \? \(/.test(rail) && !/pointer[^\n]*row:/.test(model))

t('FullscreenLayout measures the lanes wrapper itself', /const \[lanesRows, setLanesRows\] = useState<number \| undefined>\(undefined\)/.test(fsl) && /if \(height > 0 && height !== lanesRows\) setLanesRows\(height\)/.test(fsl) && /availRows=\{lanesRows\}/.test(fsl))

t('RailRow rides InteractiveRow (select-then-activate)', /id=\{`helm:lanes:\$\{rowSig \?\? rowIndex \?\? 'static'\}`\}/.test(rail) && /setHelmCursorBySig\('lanes', rowSig\)/.test(rail) && /setHelmCursor\('lanes', rowIndex\)/.test(rail))
t('no raw pointer wiring remains', !/onClick=|onMouseEnter=/.test(rail))

if (fail) {
  console.log('\n❌ lanes-shed — failures above')
  process.exit(1)
}
console.log('\n✅ lanes-shed — plan · gates · node-driven render · pointer · measurement · kernel rows')
