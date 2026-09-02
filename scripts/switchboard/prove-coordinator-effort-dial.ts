#!/usr/bin/env bun
// ============================================================================
//  prove-coordinator-effort-dial — the e doorway in the coordinator-model
//  picker sets a PERSISTENT effort the coordinator's turns actually carry.
//
//  The operator-ruled design this pins: e on a session row keeps its job
//  untouched; in the coordinator-model picker, e on the SELECTED MODEL
//  opens THE SAME effort-picker UI (RowPickModal — one UI, a second
//  doorway, no new picker invented), and the pick persists as the
//  coordinator model's own effort. Before this dial there was NO way to
//  set it: coordinatorCall passed no effortValue and every coordinator
//  turn silently rode the model default.
//
//    §1 the switch owner: normalize → typed refusal naming the ladder →
//       no-change → applied (config carries the canonical word)
//    §2 the ONE reader: validated at read; a hand-poisoned config reads
//       undefined — never a guess
//    §3 the turns carry it: the engine call spells effortValue from the
//       reader (call-shaped needle)
//    §4 the doorway: the e list-action gated to model rows; the search
//       handler declines an empty-query e; the legend advertises it
//       exactly when it fires; ONE RowPickModal serves both doorways
//    §5 the session rows' e keeps its job (the screen's own door intact)
//
//  Run: ~/.bun/bin/bun run scripts/switchboard/prove-coordinator-effort-dial.ts
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures = 1
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

// ── env hygiene BEFORE any src import ───────────────────────────────────────
const scratch = mkdtempSync(join(tmpdir(), 'coordinator-effort-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  process.env[spelling] = home
}
delete process.env.MERCURY_EFFORT_LEVEL
process.env.MERCURY_EVOLUTION_LEDGER = '0'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

console.log('============================================================')
console.log(' the coordinator effort dial — e in the model picker, persisted, carried')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const models = await import('../../src/services/concourse/coordinatorModels.ts')
const { getGlobalConfig, saveGlobalConfig } = await import('../../src/utils/config.ts')

//
section('§1 — the switch owner: normalize, refuse typed, no-change, applied')
//
{
  const junk = await models.switchCoordinatorEffort('ludicrous speed')
  check('junk refuses typed', junk.outcome === 'refused' && junk.reason === 'unknown-effort', JSON.stringify(junk))
  check('…naming the whole ladder', /low \| medium \| high \| xhigh \| max/.test(junk.detail ?? ''), junk.detail)
  check('…config untouched', getGlobalConfig().concourseCoordinator?.effort === undefined)
  check('…and the receipt targets effort with the boundary spelled', junk.target === 'effort' && junk.boundary.length > 0)

  const spoken = await models.switchCoordinatorEffort('x high')
  check("'x high' applies through the one normalizer", spoken.outcome === 'applied' && spoken.value === 'xhigh', JSON.stringify(spoken))
  check('…and the config carries the canonical word', getGlobalConfig().concourseCoordinator?.effort === 'xhigh')

  const again = await models.switchCoordinatorEffort('xhigh')
  check('the same value is no-change', again.outcome === 'no-change', JSON.stringify(again))

  const top = await models.switchCoordinatorEffort('max effort')
  check("'max effort' applies as max (the top tier exists on this road)", top.outcome === 'applied' && top.value === 'max' && getGlobalConfig().concourseCoordinator?.effort === 'max')
}

//
section('§2 — the ONE reader: validated at read, never a guess')
//
{
  check('the reader answers the persisted level', models.resolveCoordinatorEffort() === 'max')
  saveGlobalConfig(c => ({ ...c, concourseCoordinator: { ...c.concourseCoordinator, effort: 'ultra' } }))
  check('a hand-poisoned config reads undefined (no guess, no substitute)', models.resolveCoordinatorEffort() === undefined)
  saveGlobalConfig(c => ({ ...c, concourseCoordinator: { ...c.concourseCoordinator, effort: undefined } }))
  check('an absent pick reads undefined (the model default applies)', models.resolveCoordinatorEffort() === undefined)
}

//
section('§3 — the turns carry it (the call site spells the reader)')
//
{
  const call = readFileSync(join(import.meta.dir, '../../src/services/concourse/coordinatorCall.ts'), 'utf8')
  check('coordinatorCall passes effortValue from the ONE reader', call.includes('effortValue: resolveCoordinatorEffort(),'))
  check('…imported from the switch owner', call.includes("import { resolveCoordinatorEffort } from './coordinatorModels.js'"))
}

//
section('§4 — the doorway: e on the selected model, one UI, honest legend')
//
{
  const picker = readFileSync(join(import.meta.dir, '../../src/components/concourse/CoordinatorModelPicker.tsx'), 'utf8')
  check("the e list-action exists, gated to model rows", /key: 'e',\s*\n\s*hint: 'effort',\s*\n\s*when: r => r\.kind === 'model'/.test(picker))
  check(
    'the search handler declines e ONLY where the doorway fires (empty query + model row); every other e types',
    picker.includes("!(input === 'e' && query.length === 0 && effortDoorArmedRef.current)") &&
      picker.includes("effortDoorArmedRef.current = list.selectedRow?.kind === 'model'"),
  )
  check('the pick writes through the switch owner callback', picker.includes('callbacks.switchCoordinatorEffort?.(id)'))
  check('the doorway mounts the ONE RowPickModal (no picker invented)', picker.includes("import { RowPickModal } from './RowPickModal.js'") && picker.includes('titlePrefix="EFFORT"'))
  // The options are the coordinator MODEL's own stops from the one effort
  // owner, resolved for the coordinator's thinking-off call (a fixed
  // five-level list offered tiers a low|high|max model never sends).
  check("…over the coordinator model's own stops from the effort owner", picker.includes('coordinatorEffortOptions(effortPick.modelId)') && picker.includes("resolveEffortTruth(modelId, undefined, { thinkingEnabled: false })"))
  check("the legend advertises e exactly when it fires (model row + empty query)", /list\.selectedRow\?\.kind === 'model' && query\.length === 0\s*\n?\s*\? \[\{ text: 'e effort'/.test(picker))
  check('the list yields whole while the modal is up', picker.includes('active: effortPick === null'))
  const modal = readFileSync(join(import.meta.dir, '../../src/components/concourse/RowPickModal.tsx'), 'utf8')
  check('RowPickModal is the one exported grammar', modal.includes('export function RowPickModal('))
}

//
section("§5 — the session rows' e keeps its job")
//
{
  const screen = readFileSync(join(import.meta.dir, '../../src/components/concourse/ConcourseScreen.tsx'), 'utf8')
  check(
    'the board e still opens the session effort door through the daemon verb',
    screen.includes("if (input === 'e' && !key.ctrl && !key.meta && callbacks.setSessionEffort !== undefined && pastGate())") &&
      screen.includes("setRowPick({ kind: 'effort', sessionId: target.row.sessionId, title: target.row.title })"),
  )
  check('…mounting the SAME moved component', screen.includes("import { RowPickModal } from './RowPickModal.js'") && !screen.includes('function RowPickModal('))
}

console.log('\n' + '═'.repeat(60))
console.log(failures ? '❌ COORDINATOR-EFFORT-DIAL RED' : '✅ COORDINATOR-EFFORT-DIAL GREEN')
process.exit(failures)
