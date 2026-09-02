#!/usr/bin/env bun
// ============================================================================
//  scripts/seat-slots/prove-seat-slots.ts
//  PROOF: the validated seat-slot machinery for the two surviving roles
//  (scribe/implementer — the party seats retired with the multiplayer
//  estate's C10 residue). Input-space tables (accept + reject, both
//  polarities), the poisoned-env fail-closed-to-pin behavior on the
//  resolvers, the ratified seat-defaults pins (the anti-drift anchor), and
//  the consumer wiring.
//  Run:  ~/.bun/bin/bun run scripts/seat-slots/prove-seat-slots.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void { console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76)) }
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

console.log('============================================================')
console.log(' Seat slots — proof')
console.log('============================================================')

const ss = (await import('../../src/utils/model/seatSlots.js')) as typeof import('../../src/utils/model/seatSlots.js')

// env hygiene — ALSO point the config home at a fresh temp dir so the
// operator's real persisted seat-slots.json can
// never leak into the default-resolution assertions below.
const ENV_KEYS = ['MERCURY_PARTY_SLOTS', 'MERCURY_IMPLEMENTER_MODEL', 'MERCURY_IMPLEMENTER_EFFORT', 'MERCURY_SCRIBE_MODEL', 'MERCURY_CONFIG_DIR', 'MERCURY_HOME'] as const
const stash: Record<string, string | undefined> = {}
for (const k of ENV_KEYS) { stash[k] = process.env[k]; delete process.env[k] }
process.env.MERCURY_CONFIG_DIR = `/tmp/hermes-prove-seat-slots-${process.pid}`

section('the ratified seat defaults — exact strings (the anti-drift anchor)')
check('implementer default = claude-opus-5@max (D-02a executor tier)', ss.IMPLEMENTER_SEAT_DEFAULTS.model === 'claude-opus-5' && ss.IMPLEMENTER_SEAT_DEFAULTS.effort === 'max')
check('scribe default = claude-fable-5[1m] (D-02a frontier front)', ss.SCRIBE_SEAT_DEFAULT_MODEL === 'claude-fable-5[1m]')
check('allowed families = opus-4-6 canonical (whole 4.x line) · opus-5 · sonnet-5 · fable-5 · fable-5-1', JSON.stringify([...ss.SEAT_ALLOWED_FAMILIES].sort()) === JSON.stringify(['claude-fable-5', 'claude-fable-5-1', 'claude-opus-4-6', 'claude-opus-5', 'claude-sonnet-5']))

section('validateSeatModel — ACCEPT table (resolved forms asserted)')
const FB = 'claude-opus-4-8[1m]'
const accept: Array<[string, (m: string) => boolean]> = [
  ['claude-opus-4-8', m => m === 'claude-opus-4-8'],
  ['claude-opus-4-8[1m]', m => m === 'claude-opus-4-8[1m]'],
  ['opus', m => m.includes('opus')],
  ['claude-sonnet-5', m => m === 'claude-sonnet-5'],
  ['sonnet5', m => m === 'claude-sonnet-5'],
  ['claude-fable-5', m => m === 'claude-fable-5'],
  ['fable', m => m.includes('fable')],
  ['claude-mythos-5', m => m === 'claude-mythos-5'], // folds to fable canonical — allowed, literal id kept
  ['claude-opus-4-6', m => m === 'claude-opus-4-6'], // earlier-Opus swap: the standing swappability requirement
  // Any PARSEABLE exact gpt id slots structurally (canonical-lowercased) —
  // this row lived in the REJECT table while the ≥5.6 generation floor
  // stood; that refusal was purely floor-born and died with the floor
  // Whether 'gpt-5' actually EXISTS is the
  // dispatch runtime's live-catalogue answer — an unserved id refuses
  // honestly at dispatch, never from a remembered generation verdict here.
  ['gpt-5', m => m === 'gpt-5'],
]
for (const [input, ok] of accept) {
  const r = ss.validateSeatModel(input, FB)
  check(`accept '${input}' (no note)`, ok(r.model) && r.note === undefined, r.model + (r.note ? ` note=${r.note}` : ''))
}

section('validateSeatModel — REJECT table (fail-closed to the pin + note, both polarities)')
const reject = [
  'haiku', 'haiku[1m]', 'HaIkU',
  'claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-3-5-haiku-20241022',
  'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  'claude-sonnet-4-6', 'garbage-model-id', 'claude-3-opus-20240229',
]
for (const input of reject) {
  const r = ss.validateSeatModel(input, FB)
  check(`reject '${input}' ⇒ pin + note`, r.model === FB && typeof r.note === 'string' && r.note.length > 0, r.note ?? '(no note)')
}
check("unset ⇒ pin, SILENT (no note)", (() => { const r = ss.validateSeatModel(undefined, FB); return r.model === FB && r.note === undefined })())
check("empty ⇒ pin, silent", (() => { const r = ss.validateSeatModel('  ', FB); return r.model === FB && r.note === undefined })())
// The old bare-'sonnet' special-case refusal claimed 'sonnet' resolves to
// sonnet-4-6 — stale copy since the catalog took the sonnet default (§7
// on firstParty the alias resolves claude-sonnet-5, an allowed family.
check("bare 'sonnet' resolves through the tier owner to sonnet-5 (accepted)", (() => { const r = ss.validateSeatModel('sonnet', FB); return r.model === 'claude-sonnet-5' && r.note === undefined })())
check("bare 'sonnet[1m]' resolves + keeps the suffix", (() => { const r = ss.validateSeatModel('sonnet[1m]', FB); return r.model === 'claude-sonnet-5[1m]' && r.note === undefined })())

section('validateSeatEffort — accept the 5 levels, reject junk (fail-closed)')
for (const e of ['low', 'medium', 'high', 'xhigh', 'max']) {
  check(`accept '${e}'`, ss.validateSeatEffort(e, 'high').effort === e)
}
check("accept 'XHIGH' (case-fold)", ss.validateSeatEffort('XHIGH', 'high').effort === 'xhigh')
check("reject 'ultra' ⇒ fallback + note", (() => { const r = ss.validateSeatEffort('ultra', 'high'); return r.effort === 'high' && Boolean(r.note) })())
check('unset ⇒ fallback, silent', (() => { const r = ss.validateSeatEffort(undefined, 'max'); return r.effort === 'max' && r.note === undefined })())

section('SEAT_EFFORTS mirrors effort.ts EFFORT_LEVELS (source cross-check — drift guard)')
const effortSrc = src('utils', 'effort.ts')
const effortLevels = effortSrc.match(/EFFORT_LEVELS = \[([\s\S]*?)\]/)?.[1]?.match(/'(\w+)'/g)?.map(s => s.replaceAll("'", '')) ?? []
const seatSlotsSrc = src('utils', 'model', 'seatSlots.ts')
const seatEfforts = seatSlotsSrc.match(/SEAT_EFFORTS: readonly string\[\] = \[([^\]]*)\]/)?.[1]?.match(/'(\w+)'/g)?.map(s => s.replaceAll("'", '')) ?? []
check('effort vocab identical', JSON.stringify(effortLevels) === JSON.stringify(seatEfforts), `effort.ts=[${effortLevels}] seatSlots=[${seatEfforts}]`)

section('resolveImplementerSeat / resolveScribeSeatModel — poisoned env fail-closed')
process.env.MERCURY_IMPLEMENTER_MODEL = 'haiku'
process.env.MERCURY_IMPLEMENTER_EFFORT = 'bogus'
const imp = ss.resolveImplementerSeat()
check('implementer haiku+bogus ⇒ opus-5@max + note', imp.model === 'claude-opus-5' && imp.effort === 'max' && Boolean(imp.note))
process.env.MERCURY_IMPLEMENTER_MODEL = 'sonnet5'
process.env.MERCURY_IMPLEMENTER_EFFORT = 'xhigh'
const imp2 = ss.resolveImplementerSeat()
check('implementer valid override honored', imp2.model === 'claude-sonnet-5' && imp2.effort === 'xhigh' && imp2.note === undefined)
delete process.env.MERCURY_IMPLEMENTER_MODEL
delete process.env.MERCURY_IMPLEMENTER_EFFORT
process.env.MERCURY_SCRIBE_MODEL = 'claude-haiku-4-5-20251001'
const scribe = ss.resolveScribeSeatModel()
check('scribe haiku ⇒ seat pin + note', scribe.model === 'claude-fable-5[1m]' && Boolean(scribe.note))
delete process.env.MERCURY_SCRIBE_MODEL

section('decision #6 — explicit gpt slotting (structural; live qual stays the runtime)')
{
  // An exact gpt id is accepted (canonical lowercase spelling) — engines
  // are default-on; LIVE qualification stays the dispatch runtime's law.
  // (The structural ≥5.6 floor refusal died with the generation
  // gate: any parseable gpt id slots; the dispatch refuses unserved ids.)
  const sol = ss.validateSeatModel('GPT-5.6-Sol', 'claude-sonnet-5')
  check('armed: exact gpt id accepted, canonicalized', sol.model === 'gpt-5.6-sol' && sol.note === undefined, sol.model + (sol.note ?? ''))
  const prevGen = ss.validateSeatModel('gpt-5.5', 'claude-sonnet-5')
  check('armed: any parseable gpt id slots (no generation gate — live qual at dispatch)', prevGen.model === 'gpt-5.5' && prevGen.note === undefined, prevGen.model + (prevGen.note ?? ''))
  const classAlias = ss.validateSeatModel('gpt', 'claude-sonnet-5')
  check("armed: the 'gpt' class alias never slots (not an exact id)", classAlias.model === 'claude-sonnet-5' && classAlias.note !== undefined)
  const glm = ss.validateSeatModel('glm-5.2', 'claude-sonnet-5')
  check('armed: glm ids never slot (GLM stays specialist-only)', glm.model === 'claude-sonnet-5' && glm.note !== undefined)
  // An explicit exact gpt id lands on the executor-tier seat.
  const impWrite = ss.setOperatorSeatSlot('implementer', { model: 'gpt-5.6-sol' })
  check('implementer write of gpt-5.6-sol lands (executor-tier seat)', impWrite.ok === true && impWrite.applied?.model === 'gpt-5.6-sol', impWrite.message)
  const impGpt = ss.resolveImplementerSeat()
  check('implementer resolves the persisted gpt slot with provenance', impGpt.model === 'gpt-5.6-sol' && impGpt.modelOrigin === 'persisted')
  // The cycle NEVER grows engines — explicit typed input is the only door.
  check('SEAT_MODEL_CYCLE stays the three Anthropic families (the frontier family with both members)', JSON.stringify(ss.SEAT_MODEL_CYCLE) === JSON.stringify(['claude-fable-5[1m]', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-opus-5']))
  ss.clearOperatorSeatSlot('implementer')
}

section('consumer wiring (structural)')
const pin = src('utils', 'scribe', 'scribeModelPin.ts')
check('scribeModelPin routes through resolveScribeSeatModel', /resolveScribeSeatModel\(\)/.test(pin) && !/process\.env\.MERCURY_SCRIBE_MODEL\?\.trim\(\) \|\|/.test(pin))
const main = src('daemon', 'main.ts')
check('daemon main uses resolveImplementerSeat (no raw env pin)', /resolveImplementerSeat\(\)/.test(main) && !/MERCURY_IMPLEMENTER_MODEL\?\.trim\(\) \|\|/.test(main))
const roster = src('daemon', 'roster.ts')
check('roster.reconfigureLongLived validates via seat slots', /validateSeatModel\(patch\.model/.test(roster) && /validateSeatEffort\(patch\.effort/.test(roster))

section('the reslot seam — ONE owner, the text path carries no local pre-check (F2)')
{
  const mm = src('commands', 'model', 'mercuryModel.tsx')
  // the text path does not carry its OWN pre-check — local
  // seat tokens ride ApplyLocalSeatReslot → applyOperatorReslot →
  // setOperatorSeatSlot, so validation is consulted at the ONE owner (the
  // same chain the picker ROLES rows use). The
  // structural leg pins the route; the functional leg drives the exact call
  // the text path lands on and asserts the owner's refusal.
  check(
    "the '/model scribe <id>' text path rides the ONE reslot seam (no local pre-check, no legacy fall-through)",
    /seat\.kind === 'local'[\s\S]{0,900}ApplyLocalSeatReslot role=\{seat\.target/.test(mm) &&
      /applyOperatorReslot\(role, \{ model \}/.test(mm),
  )
  const scribeHaiku = ss.setOperatorSeatSlot('scribe', { model: 'haiku' })
  check(
    "…and that seam refuses '/model scribe haiku' at the owner (nothing saved)",
    scribeHaiku.ok === false && /Refused/.test(scribeHaiku.message),
    scribeHaiku.message,
  )
}

// restore env
for (const k of ENV_KEYS) { if (stash[k] !== undefined) process.env[k] = stash[k]; else delete process.env[k] }

console.log('\n' + '='.repeat(60))
if (failures > 0) { console.log(` FAIL — ${failures} check(s) failed`); process.exit(1) }
console.log(' ALL PASS')
