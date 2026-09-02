#!/usr/bin/env bun
// ============================================================================
//  scripts/model-routing/prove-gpt-seat-rows.ts
//  PROOF (the /model ROLES GPT seat rows — operator-confirmed
//  design): honest per-seat GPT state from the ONE availability chain, and
//  the slotting laws around it.
//    1. getGptSeatAvailability states (engines default-on) — no account ·
//       unfetched catalogue · READY (fixture-seeded live catalogue,
//       priority-ordered qualified ids, floor/visibility filtered, account
//       source named).
//    2. The m-cycle NEVER grows gpt (SEAT_MODEL_CYCLE Anthropic-only for
//       every role) — gpt slots only by explicit input.
//    3. setOperatorSeatSlot: an explicit gpt id lands on executor seats;
//       tank/healer REFUSE (orchestration doctrine).
//    4. Structural (the picker surfaces): tank/healer excluded from the GPT
//       seat roles; `g` is its OWN action routed through applyOperatorReslot;
//       the picker wires input 'g' → RoleAction 'gpt'.
//  Run:  ~/.bun/bin/bun run scripts/model-routing/prove-gpt-seat-rows.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' /model ROLES GPT seat rows (honest states + slot laws)')
console.log('============================================================')

const ROOT = join(import.meta.dir, '..', '..')
const savedEnv: Record<string, string | undefined> = {}
for (const key of ['OPENAI_API_KEY', 'MERCURY_CONFIG_DIR', 'MERCURY_AUTH_SCOPE_DIR', 'MERCURY_PARTY_SLOTS', 'MERCURY_IMPLEMENTER_MODEL']) {
  savedEnv[key] = process.env[key]
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-gpt-rows-'))
// Any accidental real fetch (the unfetched-state background kick) must die
// instantly instead of touching the network (ambient-state law).
savedEnv['MERCURY_OPENAI_API_BASE'] = process.env.MERCURY_OPENAI_API_BASE
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:9'

const catalogue = await import('../../src/services/providers/openai/openaiCatalogue.js')
const { getGptSeatAvailability, refreshOpenaiCatalogue, __resetOpenaiCatalogueForTest } = catalogue
const { SEAT_MODEL_CYCLE, SLOT_ROLES, seatModelCycleFor, setOperatorSeatSlot, clearOperatorSeatSlot } =
  await import('../../src/utils/model/seatSlots.js')

// ── 1. the availability chain, state by state ───────────────────────────────
{
  __resetOpenaiCatalogueForTest()
  let a = getGptSeatAvailability()
  // The ruled signed-out sentence (catalogueGate's connectToBrowseReason) plus
  // the /logins action hint.
  check('no account ⇒ disabled steering to /logins', a.state === 'disabled' && a.why === 'no-account' && /connect OpenAI to browse its models/.test(a.reason) && /\/logins/.test(a.reason), JSON.stringify(a))

  process.env.OPENAI_API_KEY = 'prover-key'
  __resetOpenaiCatalogueForTest()
  a = getGptSeatAvailability()
  check('account present, unfetched catalogue ⇒ disabled, honestly labelled', a.state === 'disabled' && /not fetched/.test(a.reason))

  // Seed the LIVE catalogue through the real refresh path (fixture endpoint).
  const fixtureFetch: typeof fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [
          { id: 'gpt-5.6-luna', display_name: 'GPT-5.6 Luna', visibility: 'list', priority: 2, supported_reasoning_levels: ['low', 'medium', 'high'] },
          { id: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list', priority: 1, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'] },
          { id: 'gpt-5.2-orbit', display_name: 'older era, served', visibility: 'list', priority: 3, supported_reasoning_levels: ['low'] },
          { id: 'gpt-5.7-ghost', display_name: 'hidden', visibility: 'hide', priority: 0, supported_reasoning_levels: ['low'] },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch
  // The unfetched-state probe above KICKED a fire-and-forget refresh whose
  // in-flight entry would swallow this forced call — clear it first.
  __resetOpenaiCatalogueForTest()
  await refreshOpenaiCatalogue('api-key', { force: true, fetchImpl: fixtureFetch })
  a = getGptSeatAvailability()
  check('fixture catalogue ⇒ READY', a.state === 'ready')
  if (a.state === 'ready') {
    // The era generation floor was removed (openaiCatalogue.ts law: every
    // model the account serves is pickable) — visibility still filters and
    // priority still orders.
    check('qualified ids visibility-filtered, priority-ordered (no generation floor)', a.ids.join(',') === 'gpt-5.6-sol,gpt-5.6-luna,gpt-5.2-orbit', a.ids.join(','))
    check('account source NAMED (billing honesty — env key never wears subscription clothes)', /OpenAI API key \(env\)/.test(a.source), a.source)
  }
}

// ── 2. the m-cycle NEVER grows gpt ──────────────────────────────────────────
{
  check('SEAT_MODEL_CYCLE stays Anthropic-only', SEAT_MODEL_CYCLE.every(m => m.startsWith('claude-')))
  check(
    'no role cycle ever yields a gpt id (explicit input is the only gpt path)',
    SLOT_ROLES.every(r => seatModelCycleFor(r).every(m => m.startsWith('claude-'))),
  )
}

// ── 3. setOperatorSeatSlot — the ONE validator holds the seat laws ──────────
{
  // The party seats (tank/healer/dps1-3) left with the multiplayer estate,
  // and the orchestration-refuses-gpt doctrine retired with them (the
  // multiauth estate blessed GPT chairs). The living law is the wrapper's
  // own GPT_SEAT_ROLES = scribe + implementer: an explicit gpt id SAVES on
  // both (the g door), while the m-cycle stays Anthropic-only (§2) —
  // explicit input remains the only gpt path.
  const scribe = setOperatorSeatSlot('scribe', { model: 'gpt-5.6-sol' })
  check('explicit gpt id lands on the scribe seat (the living g door)', scribe.ok && scribe.applied?.model === 'gpt-5.6-sol')
  clearOperatorSeatSlot('scribe')
  const imp = setOperatorSeatSlot('implementer', { model: 'gpt-5.6-sol' })
  check('explicit gpt id lands on the implementer seat', imp.ok && imp.applied?.model === 'gpt-5.6-sol')
  clearOperatorSeatSlot('implementer')
  check(
    'the party seats left the store vocabulary (multiplayer re-slotted post-release)',
    (['tank', 'healer', 'dps1', 'dps2', 'dps3'] as const).every(r => !(SLOT_ROLES as readonly string[]).includes(r)),
  )
}

// ── 4. the picker surfaces (structural) ─────────────────────────────────────
{
  const wrapper = readFileSync(join(ROOT, 'src', 'commands', 'model', 'mercuryModel.tsx'), 'utf8')
  check(
    'GPT seat roles are the living pair (the party seats left with the multiplayer estate)',
    /GPT_SEAT_ROLES: readonly SlotRole\[\] = \['scribe', 'implementer'\]/.test(wrapper),
  )
  check("the 'g' action routes through applyOperatorReslot (→ setOperatorSeatSlot, the ONE validator)", /action === 'gpt'[\s\S]{0,2000}applyOperatorReslot\(role, \{ model: next \}/.test(wrapper))
  // The honest-press law survives as the gated hint: g is advertised only
  // where the press works (availability ready + a GPT seat role) — no dead
  // key, no false title.
  check('the g hint paints only when the press works (availability- and role-gated)', /gptAvailability\.state === 'ready' && GPT_SEAT_ROLES\.includes\(role\) \? ' · g slots gpt'/.test(wrapper))
  const picker = readFileSync(join(ROOT, 'src', 'components', 'MercuryModelPicker.tsx'), 'utf8')
  check("the picker wires input 'g' → RoleAction 'gpt' (own explicit keypress)", /input === 'g'[\s\S]{0,400}onRoleAction\?\.\(focusedRole\.role, 'gpt'\)/.test(picker))
  check('gptDetail renders on the focused row only (compact sheds it — CN-14 law 5)', /on && !compact && r\.gptDetail \?/.test(picker))
}

// ── the ALWAYS-VISIBLE group law ───────────────
// The /model GPT group never silently vanishes: the not-ready states project
// ONE action row (sign-in / connecting) whose ↵ runs /logins — and BOTH
// pickers intercept the sentinel before any model write.
{
  console.log('\n— always-visible group: the sign-in action row —')
  const modelOptions = readFileSync(join(ROOT, 'src', 'utils', 'model', 'modelOptions.ts'), 'utf8')
  check('the sentinel exists and never resolves as a model (dedup-listed)',
    /GPT_CONNECT_OPTION_VALUE = '__hermes_gpt_connect__'/.test(modelOptions) &&
      /v === GPT_CONNECT_OPTION_VALUE/.test(modelOptions))
  check('not-ready projects the action row (sign in / connecting)',
    /'GPT — sign in'/.test(modelOptions) && /'GPT — connecting…'/.test(modelOptions))
  const mercuryModel = readFileSync(join(ROOT, 'src', 'commands', 'model', 'mercuryModel.tsx'), 'utf8')
  check('the /model picker intercepts the sentinel → /logins (the one login home)',
    /id === GPT_CONNECT_OPTION_VALUE/.test(mercuryModel) && /requestCommandDispatch\('\/logins'\)/.test(mercuryModel))
  const promptInput = readFileSync(join(ROOT, 'src', 'components', 'PromptInput', 'PromptInput.tsx'), 'utf8')
  check('the inline picker intercepts the sentinel too (never a model write)',
    /value === GPT_CONNECT_OPTION_VALUE/.test(promptInput) && /requestCommandDispatch\('\/logins'\)/.test(promptInput))
  const repl = readFileSync(join(ROOT, 'src', 'screens', 'REPL.tsx'), 'utf8')
  check('boot idle primes the live catalogue (first /model is seamless when signed in)',
    /getGptSeatAvailability\(\)/.test(repl))
}

for (const [key, value] of Object.entries(savedEnv)) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

console.log('============================================================')
if (failures > 0) {
  console.error(`❌ ${failures} gpt-seat-row proof(s) failed`)
  process.exit(1)
}
console.log('✅ GPT SEAT ROWS PROVEN (states · cycle law · validator · surfaces)')
