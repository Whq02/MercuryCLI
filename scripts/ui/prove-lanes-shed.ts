#!/usr/bin/env bun
// scripts/ui/prove-lanes-shed.ts — the lanes-rail measured-ceiling shed
// Structural laws:
//   §1 the shed PLAN exists and decides BEFORE any builder runs (intents
//      derived from the same data the builders consume, priority order
//      pinned, cursor-section immunity via the published model);
//   §2 every shedable builder is GATED on the plan (a shed section's builder
//      never executes ⇒ paints nothing AND registers no rows — published
//      model == painted rows by construction);
//   §3 the render branches gate on the NODE arrays (never the raw data), so
//      a shed section can't leave an orphaned header/empty shell;
//   §4 everything shed folds into ONE display-only pointer line (no row-model
//      entry — the cursor can never land on it);
//   §5 the measured ceiling arrives from FullscreenLayout via the lanes
//      rail's OWN wrapper measurement (not the telemetry ref, which unmounts
//      on the single-rail tier);
//   §6 the rail rows ride the ONE kernel (InteractiveRow select-then-activate
//      — RailRow/ChatRow/MoreRow match TelemetryRow's grammar).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { densityPlan, HELM_DENSITY_FLOOR } from '../../src/utils/helmDensity.ts'

const ROOT = path.resolve(import.meta.dir, '../..')
const rail = readFileSync(path.join(ROOT, 'src/components/HelmLanesRail.tsx'), 'utf8')
// The ORDER and the never-shed floor moved to the one density owner (
// HZ5) so they can vary with what the session is doing. Same two laws, read at
// the owner that now holds them: the calm ladder is still the pinned order,
// and the floor still names the same sections.
const density = readFileSync(path.join(ROOT, 'src/utils/helmDensity.ts'), 'utf8')
const fsl = readFileSync(path.join(ROOT, 'src/components/FullscreenLayout.tsx'), 'utf8')

let fail = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
}

// §1 the plan
t('shed plan exists and the rail walks it', /for \(const k of density\.shedOrder\)/.test(rail))
t(
  'the pinned calm priority order lives at the density owner (workbench yields first — the ruled card adds itself without moving anything else; the party slot left with the seat retirement)',
  /const CALM_ORDER = \['workbench', 'next', 'tabula', 'recent', 'chat', 'crew'\]/.test(density),
)
t(
  // POISON (the seat-retirement law, the crew-projection precedent): the
  // ladders name NO party section — its return reds here for the revival
  // re-true, never silently.
  'no ladder revives the retired party slot',
  !density.includes("'party'"),
)
t(
  'every mode sheds the workbench card first (geometry law: no shift elsewhere)',
  (['calm', 'active', 'waiting', 'review'] as const).every(
    activity => densityPlan(activity, 40).shedOrder[0] === 'workbench',
  ),
)
t(
  'core sections are shed-immune',
  /HELM_DENSITY_FLOOR = \['seat', 'work', 'tasks', 'runs', 'mission'\]/.test(density) &&
    /new Set<string>\(\[\.\.\.HELM_DENSITY_FLOOR/.test(rail),
)
t(
  // Review finding 10: this would otherwise grep ANOTHER PROVER's source (a test
  // asserting a test) — now it drives the PRODUCT law directly: no activity's
  // plan may shed a floor section, at tall and short geometries alike.
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
t('the cursor section is shed-immune (published-model lookup)', /getHelmRows\('lanes'\)/.test(rail) && /if \(cursorSection\) mustKeep\.add\(cursorSection\)/.test(rail))
t('the ceiling is the measured availRows', /const shedCeiling = availRows \?\? Infinity/.test(rail))

// §2 gated builders
// the crew gate hoisted into `crewShed` when the permanent ROOT row
// landed — the root node, the child rows, AND the assembled section all gate
// on the same shed fact (a shed lane constructs nothing, root included).
t(
  'crew builder gated',
  /const crewShed = shedSet\.has\('crew'\)/.test(rail) &&
    /crewShed \? null :/.test(rail) &&
    /crewShed \? \[\] : crewShown\.map/.test(rail) &&
    /crewShed \? \[\] : \[rootNode, \.\.\.crewChildNodes\]/.test(rail),
)
t('chat builder gated', /shedSet\.has\('chat'\) \? \[\] : chatRows\.map/.test(rail))
t('recent builder gated', /if \(solo && !shedSet\.has\('recent'\)\)/.test(rail))
t('tabula builder gated', /if \(isTabulaEnabled\(\) && !shedSet\.has\('tabula'\)\)/.test(rail))
t('workbench builder gated', /if \(!shedSet\.has\('workbench'\)\)/.test(rail))
// POISON — the party builder retired with the seat estate: the rail
// constructs no party rows and names no party section; a returning
// builder reds here by name for its revival re-true.
t('party builder stays retired (no partyPeers, no party section)', !rail.includes('partyPeers') && !rail.includes("section('party'") && !rail.includes("has('party')"))
t('next builder gated', /if \(solo && !shedSet\.has\('next'\)\)/.test(rail))

// §3 render branches follow the NODES
t('solo chat renders on chatNodes', /\{chatNodes\.length > 0\n\s*\? section\('chat'/.test(rail))
t('recent renders on soloNodes', /soloNodes\.length > 0 \? section\('recent'/.test(rail))
t('next renders on hintNodes', /hintNodes\.length > 0 \? section\('next'/.test(rail))
t('workbench renders on workbenchNodes, under the Minerva (tabula) card in BOTH branches', (rail.match(/workbenchNodes\.length > 0\n\s*\? section\('workbench'/g) ?? []).length === 2 && (() => {
  // In each branch the workbench slot must FOLLOW the tabula slot (the
  // ruled "under the Minerva card").
  const solo = rail.indexOf("section('tabula'")
  const soloWb = rail.indexOf("section('workbench'")
  const busy = rail.lastIndexOf("section('tabula'")
  const busyWb = rail.lastIndexOf("section('workbench'")
  return solo !== -1 && soloWb > solo && busyWb > busy
})())
// the empty-CREW branch joined the null path (a session
// that never engaged crew renders NO stub section) — shed still nulls whole.
t('busy crew section sheds whole', /shedSet\.has\('crew'\) \|\| crewEntries\.length === 0 \? null : section\(/.test(rail))

// §4 the honest pointer
t('shed pointer is display-only (no sel registration)', /shedSet\.size > 0 \? \(/.test(rail) && !/sel\(\{[^}]*shed/.test(rail))

// §5 the measurement seam
t('FullscreenLayout measures the lanes wrapper itself', /const \[lanesRows, setLanesRows\] = useState<number \| undefined>\(undefined\)/.test(fsl) && /if \(height > 0 && height !== lanesRows\) setLanesRows\(height\)/.test(fsl) && /availRows=\{lanesRows\}/.test(fsl))

// §6 kernel rows — the pointer verbs ride the row's
// (identity) with the index as the legacy fallback.
t('RailRow rides InteractiveRow (select-then-activate)', /id=\{`helm:lanes:\$\{rowSig \?\? rowIndex \?\? 'static'\}`\}/.test(rail) && /setHelmCursorBySig\('lanes', rowSig\)/.test(rail) && /setHelmCursor\('lanes', rowIndex\)/.test(rail))
t('no raw pointer wiring remains', !/onClick=|onMouseEnter=/.test(rail))

if (fail) {
  console.log('\n❌ lanes-shed — failures above')
  process.exit(1)
}
console.log('\n✅ lanes-shed — plan · gates · node-driven render · pointer · measurement · kernel rows')
