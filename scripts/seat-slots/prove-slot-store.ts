#!/usr/bin/env bun
// ============================================================================
//  scripts/seat-slots/prove-slot-store.ts
//  PROOF: the persisted operator seat-slot tier + the
//  precedence law  env pin > persisted slot > ratified default.
//
//   (a) store IO: absent ⇒ {}, write→read round-trip, axis clear, slot
//       removal, damaged file ⇒ {} (the tier contributes nothing); NON-live
//       role keys (the retired party seats among them) ride as opaque
//       PASSENGERS — invisible to the typed read, byte-preserved through
//       the write path (an operator's historical rows are never repainted).
//   (b) precedence per axis, with provenance (origin + the NAMED env var):
//       persisted beats default; env beats persisted; an INVALID env value
//       falls THROUGH to the valid persisted tier (never to raw junk, never
//       skipping a valid lower tier); an invalid persisted value falls to the
//       ratified default with the 'persisted slot:' note.
//   (c) the SEAT LAW on the WRITE path: engines (gpt/glm class aliases),
//       Haiku in every spelling, and junk are REFUSED with nothing saved;
//       the SEAT_MODEL_CYCLE offers no engine and no Haiku — a picker
//       structurally cannot offer them.
//   (d) the ONE cycle: nextSeatModel (both surviving roles cycle whole);
//       unknown current ⇒ cycle head.
//   (e) scribe effort has NO env tier: MERCURY_SCRIBE_EFFORT (a var that does
//       not exist in the registry) is ignored even when set.
//
//  Hermetic: MERCURY_CONFIG_DIR points at a fresh temp dir; env stashed and
//  restored. Run:  ~/.bun/bin/bun run scripts/seat-slots/prove-slot-store.ts
// ============================================================================
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void { console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76)) }

console.log('============================================================')
console.log(' Seat-slot persisted tier + precedence law — proof')
console.log('============================================================')

// ── hermetic env ─────────────────────────────────────────────────────────────
const ENV_KEYS = [
  'MERCURY_PARTY_SLOTS', 'MERCURY_IMPLEMENTER_MODEL', 'MERCURY_IMPLEMENTER_EFFORT',
  'MERCURY_SCRIBE_MODEL', 'MERCURY_SCRIBE_EFFORT', 'MERCURY_CONFIG_DIR', 'MERCURY_HOME',
  'MERCURY_DURABLE_FSYNC',
] as const
const stash: Record<string, string | undefined> = {}
for (const k of ENV_KEYS) { stash[k] = process.env[k]; delete process.env[k] }
const HOME = `/tmp/hermes-prove-slot-store-${process.pid}`
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DURABLE_FSYNC = '0' // speed — atomicity still exercised
mkdirSync(HOME, { recursive: true })

const ss = (await import('../../src/utils/model/seatSlots.js')) as typeof import('../../src/utils/model/seatSlots.js')
const store = (await import('../../src/utils/model/seatSlotStore.js')) as typeof import('../../src/utils/model/seatSlotStore.js')
const storePath = join(HOME, 'seat-slots.json')

section('(a) store IO — round-trip, clears, damage tolerance')
check('absent file ⇒ {}', Object.keys(store.readPersistedSeatSlots()).length === 0)
store.writePersistedSeatSlot('implementer', { model: 'claude-fable-5', effort: 'xhigh' })
check('write→read round-trip', (() => { const s = store.readPersistedSeatSlots(); return s.implementer?.model === 'claude-fable-5' && s.implementer?.effort === 'xhigh' })())
check('file exists at the config-home path', existsSync(storePath))
check('file shape carries version 1', JSON.parse(readFileSync(storePath, 'utf-8')).version === 1)
store.writePersistedSeatSlot('implementer', { effort: null })
check('axis clear (effort null) keeps the model axis', (() => { const s = store.readPersistedSeatSlots(); return s.implementer?.model === 'claude-fable-5' && s.implementer?.effort === undefined })())
store.writePersistedSeatSlot('implementer', { model: null })
check('clearing the last axis removes the slot', store.readPersistedSeatSlots().implementer === undefined)
writeFileSync(storePath, '{ not json', 'utf-8')
store.__resetSeatSlotStoreCache()
check('damaged file ⇒ {} (tier contributes nothing, never throws)', Object.keys(store.readPersistedSeatSlots()).length === 0)
writeFileSync(storePath, JSON.stringify({ version: 1, slots: { bogus: { model: 'claude-fable-5' }, tank: { model: 'claude-fable-5' }, healer: 'junk', scribe: { model: 'claude-fable-5' } } }), 'utf-8')
store.__resetSeatSlotStoreCache()
check('non-live role keys invisible to the typed read; valid rows kept', (() => { const s = store.readPersistedSeatSlots(); return Object.keys(s).length === 1 && s.scribe?.model === 'claude-fable-5' })())
// THE PASSENGERS LAW: a scribe/implementer write re-emits the retired/unknown
// rows byte-preserved — the operator's historical party slots survive every
// write, never repainted away, never resurrected.
store.writePersistedSeatSlot('implementer', { model: 'claude-opus-5' })
check('passengers preserved through a live write (the retired tank row survives verbatim)', (() => { const raw = JSON.parse(readFileSync(storePath, 'utf-8')) as { slots: Record<string, unknown> }; return JSON.stringify(raw.slots.tank) === JSON.stringify({ model: 'claude-fable-5' }) && raw.slots.bogus !== undefined && (raw.slots.implementer as { model?: string })?.model === 'claude-opus-5' })())
store.writePersistedSeatSlot('implementer', { model: null, effort: null })
rmSync(storePath, { force: true })
store.__resetSeatSlotStoreCache()

section('(b) precedence: env pin > persisted slot > ratified default (per axis)')
const d0 = ss.resolveImplementerSeat()
check('no tiers ⇒ ratified default, origins default', d0.model === 'claude-opus-5' && d0.effort === 'max' && d0.modelOrigin === 'default' && d0.effortOrigin === 'default' && d0.modelEnvVar === undefined)
const w1 = ss.setOperatorSeatSlot('implementer', { model: 'fable', effort: 'high' })
check('setOperatorSeatSlot accepts alias + persists resolved id', w1.ok && /Saved implementer slot/.test(w1.message) && /persists/.test(w1.message), w1.message)
const d1 = ss.resolveImplementerSeat()
check('persisted beats default (both axes, origins persisted)', d1.model === 'claude-fable-5' && d1.effort === 'high' && d1.modelOrigin === 'persisted' && d1.effortOrigin === 'persisted')
process.env.MERCURY_IMPLEMENTER_MODEL = 'sonnet5'
process.env.MERCURY_IMPLEMENTER_EFFORT = 'xhigh'
const d2 = ss.resolveImplementerSeat()
check('env pin beats persisted (both axes)', d2.model === 'claude-sonnet-5' && d2.effort === 'xhigh' && d2.modelOrigin === 'env' && d2.effortOrigin === 'env')
check('env origin NAMES the pinning var (canonical spelling)', d2.modelEnvVar === 'MERCURY_IMPLEMENTER_MODEL' && d2.effortEnvVar === 'MERCURY_IMPLEMENTER_EFFORT')
delete process.env.MERCURY_IMPLEMENTER_EFFORT
const d3 = ss.resolveImplementerSeat()
check('per-axis mixing: env model + persisted effort', d3.model === 'claude-sonnet-5' && d3.modelOrigin === 'env' && d3.effort === 'high' && d3.effortOrigin === 'persisted' && d3.effortEnvVar === undefined)
process.env.MERCURY_IMPLEMENTER_MODEL = 'haiku'
process.env.MERCURY_IMPLEMENTER_EFFORT = 'bogus'
const d4 = ss.resolveImplementerSeat()
check('INVALID env falls THROUGH to the valid persisted tier (never junk, never skipping)', d4.model === 'claude-fable-5' && d4.modelOrigin === 'persisted' && d4.effort === 'high' && d4.effortOrigin === 'persisted')
check('…with the honest env-refusal note', /Haiku-tier/.test(d4.note ?? '') && /not an effort level/.test(d4.note ?? ''), d4.note)
delete process.env.MERCURY_IMPLEMENTER_MODEL
delete process.env.MERCURY_IMPLEMENTER_EFFORT
ss.clearOperatorSeatSlot('implementer')
// invalid persisted falls to default with the persisted-slot note
writeFileSync(storePath, JSON.stringify({ version: 1, slots: { implementer: { model: 'claude-haiku-4-5', effort: 'ultra' } } }), 'utf-8')
store.__resetSeatSlotStoreCache()
const d5 = ss.resolveImplementerSeat()
check('INVALID persisted falls to the ratified default + note', d5.model === 'claude-opus-5' && d5.effort === 'max' && d5.modelOrigin === 'default' && d5.effortOrigin === 'default')
check("…note names the persisted tier", /persisted slot: .*Haiku-tier/.test(d5.note ?? ''), d5.note)
rmSync(storePath, { force: true })
store.__resetSeatSlotStoreCache()

section('(b2) implementer + scribe resolvers ride the same ladder')
ss.setOperatorSeatSlot('implementer', { model: 'sonnet5', effort: 'xhigh' })
const imp = ss.resolveImplementerSeat()
check('implementer persisted slot honored', imp.model === 'claude-sonnet-5' && imp.effort === 'xhigh' && imp.modelOrigin === 'persisted')
process.env.MERCURY_IMPLEMENTER_MODEL = 'opus'
const imp2 = ss.resolveImplementerSeat()
check('the implementer model env pin (legacy spelling via the alias) wins over the slot', /opus/.test(imp2.model) && imp2.modelOrigin === 'env' && imp2.modelEnvVar === 'MERCURY_IMPLEMENTER_MODEL' && imp2.effortOrigin === 'persisted')
delete process.env.MERCURY_IMPLEMENTER_MODEL
ss.clearOperatorSeatSlot('implementer')
const imp3 = ss.resolveImplementerSeat()
check('clearOperatorSeatSlot ⇒ back to the pinned default', imp3.model === 'claude-opus-5' && imp3.effort === 'max' && imp3.modelOrigin === 'default')
ss.setOperatorSeatSlot('scribe', { model: 'fable', effort: 'high' })
const scr = ss.resolveScribeSeat()
check('scribe persisted slot honored (model + the NEW effort axis)', scr.model === 'claude-fable-5' && scr.effort === 'high' && scr.modelOrigin === 'persisted' && scr.effortOrigin === 'persisted')
check('resolveScribeSeatModel projection matches', ss.resolveScribeSeatModel().model === 'claude-fable-5')
process.env.MERCURY_SCRIBE_MODEL = 'opus'
const scr2 = ss.resolveScribeSeat()
check('the scribe model env pin (legacy spelling via the alias) wins', /opus/.test(scr2.model) && scr2.modelOrigin === 'env' && scr2.modelEnvVar === 'MERCURY_SCRIBE_MODEL')
delete process.env.MERCURY_SCRIBE_MODEL
ss.clearOperatorSeatSlot('scribe')
const scr3 = ss.resolveScribeSeat()
check('scribe defaults: fable-5[1m]@xhigh', scr3.model === 'claude-fable-5[1m]' && scr3.effort === 'xhigh' && scr3.effortOrigin === 'default')

section('(c) SEAT LAW on the write path — engines/Haiku/junk refused, NOTHING saved')
const before = existsSync(storePath) ? readFileSync(storePath, 'utf-8') : null
// bare 'sonnet' left this table at the de-stale: the alias now resolves
// claude-sonnet-5 (an allowed family) through the catalogue tier owner.
for (const bad of ['gpt', 'glm', 'glm-5.2', 'glm-4.7', 'haiku', 'claude-haiku-4-5-20251001', 'garbage-id']) {
  const r = ss.setOperatorSeatSlot('implementer', { model: bad })
  check(`refuse '${bad}' (nothing saved)`, !r.ok && /Refused/.test(r.message) && !/; using '/.test(r.message), r.message)
}
check('file untouched by refused writes', (existsSync(storePath) ? readFileSync(storePath, 'utf-8') : null) === before)
// Decision #6: an EXPLICIT exact gpt id lands on an executor seat (the
// closed families plus exact gpt ids); the bare 'gpt' alias above stays refused.
for (const exact of ['gpt-5.2', 'gpt-5.2-codex']) {
  const r = ss.setOperatorSeatSlot('implementer', { model: exact })
  check(`explicit exact '${exact}' lands on the executor-tier seat`, r.ok && r.applied?.model === exact, r.message)
}
ss.clearOperatorSeatSlot('implementer')
{
  const okWrite = ss.setOperatorSeatSlot('implementer', { model: 'sonnet' })
  check("bare 'sonnet' now lands on the executor-tier seat (resolves sonnet-5)", okWrite.ok && okWrite.applied?.model === 'claude-sonnet-5', okWrite.message)
  ss.clearOperatorSeatSlot('implementer')
}
const badEff = ss.setOperatorSeatSlot('implementer', { effort: 'ultra' })
check("refuse effort 'ultra'", !badEff.ok && /Refused/.test(badEff.message))
const nothing = ss.setOperatorSeatSlot('implementer', {})
check('empty patch refused honestly', !nothing.ok && /Nothing to save/.test(nothing.message))
rmSync(storePath, { force: true })
store.__resetSeatSlotStoreCache()

section('(c2) the cycle offers no engine, no Haiku — structurally')
check('SEAT_MODEL_CYCLE = the three ratified families (the frontier family with both members)', JSON.stringify(ss.SEAT_MODEL_CYCLE) === JSON.stringify(['claude-fable-5[1m]', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-opus-5']))
check('no gpt/glm/haiku spelling in any cycle', [...ss.SEAT_MODEL_CYCLE, ...ss.seatModelCycleFor('implementer'), ...ss.seatModelCycleFor('scribe')].every(m => !/gpt|glm|haiku/i.test(m)))
check('both surviving roles cycle whole (the orchestration skip retired with its seats)', ss.seatModelCycleFor('implementer').length === 4 && ss.seatModelCycleFor('scribe').length === 4)

section('(d) nextSeatModel — the one cycle')
check('implementer: opus → fable[1m]', ss.nextSeatModel('implementer', 'claude-opus-4-8[1m]') === 'claude-fable-5[1m]')
check('implementer: sonnet → opus-5', ss.nextSeatModel('implementer', 'claude-sonnet-5') === 'claude-opus-5')
check('implementer: bare fable (family match) → fable-5-1', ss.nextSeatModel('implementer', 'claude-fable-5') === 'claude-fable-5-1')
check('implementer: fable[1m] (exact) → fable-5-1', ss.nextSeatModel('implementer', 'claude-fable-5[1m]') === 'claude-fable-5-1')
check('implementer: fable-5-1 (exact) → sonnet-5 — the walk moves on past the second frontier member', ss.nextSeatModel('implementer', 'claude-fable-5-1') === 'claude-sonnet-5')
check('implementer: unknown ⇒ cycle head (fable[1m])', ss.nextSeatModel('implementer', 'weird') === 'claude-fable-5[1m]')
check('200k opus variant matches the opus family', ss.nextSeatModel('implementer', 'claude-opus-4-8') === 'claude-fable-5[1m]')

section('(e) no invented env tier — MERCURY_SCRIBE_EFFORT is ignored')
process.env.MERCURY_SCRIBE_EFFORT = 'low'
const scrNoEnv = ss.resolveScribeSeat()
check('scribe effort ignores MERCURY_SCRIBE_EFFORT (default kept)', scrNoEnv.effort === 'xhigh' && scrNoEnv.effortOrigin === 'default')
delete process.env.MERCURY_SCRIBE_EFFORT

section('(f) resolveSeatSlot dispatcher + env-shadow honesty')
check('dispatcher routes both surviving roles', ss.resolveSeatSlot('scribe').model === ss.resolveScribeSeat().model && ss.resolveSeatSlot('implementer').model === ss.resolveImplementerSeat().model)
process.env.MERCURY_IMPLEMENTER_MODEL = 'opus'
const shadowed = ss.setOperatorSeatSlot('implementer', { model: 'fable', effort: 'max' })
check('saved-under-shadow NAMES the overriding env var (canonical)', shadowed.ok && /MERCURY_IMPLEMENTER_MODEL overrides this session/.test(shadowed.message), shadowed.message)
delete process.env.MERCURY_IMPLEMENTER_MODEL
const afterShadow = ss.resolveSeatSlot('implementer')
check('once the pin clears, the saved slot applies', afterShadow.model === 'claude-fable-5' && afterShadow.effort === 'max' && afterShadow.modelOrigin === 'persisted')
ss.clearOperatorSeatSlot('implementer')

// ── restore env + scrub temp ─────────────────────────────────────────────────
rmSync(HOME, { recursive: true, force: true })
for (const k of ENV_KEYS) { if (stash[k] !== undefined) process.env[k] = stash[k]; else delete process.env[k] }

console.log('\n' + '='.repeat(60))
if (failures > 0) { console.log(` FAIL — ${failures} check(s) failed`); process.exit(1) }
console.log(' ALL SLOT-STORE PROOFS PASS')
