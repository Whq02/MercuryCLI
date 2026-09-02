#!/usr/bin/env bun
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
savedEnv['MERCURY_OPENAI_API_BASE'] = process.env.MERCURY_OPENAI_API_BASE
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:9'

const catalogue = await import('../../src/services/providers/openai/openaiCatalogue.js')
const { getGptSeatAvailability, refreshOpenaiCatalogue, __resetOpenaiCatalogueForTest } = catalogue
const { SEAT_MODEL_CYCLE, SLOT_ROLES, seatModelCycleFor, setOperatorSeatSlot, clearOperatorSeatSlot } =
  await import('../../src/utils/model/seatSlots.js')

{
  __resetOpenaiCatalogueForTest()
  let a = getGptSeatAvailability()
  check('no account ⇒ disabled steering to /logins', a.state === 'disabled' && a.why === 'no-account' && /connect OpenAI to browse its models/.test(a.reason) && /\/logins/.test(a.reason), JSON.stringify(a))

  process.env.OPENAI_API_KEY = 'prover-key'
  __resetOpenaiCatalogueForTest()
  a = getGptSeatAvailability()
  check('account present, unfetched catalogue ⇒ disabled, honestly labelled', a.state === 'disabled' && /not fetched/.test(a.reason))

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
  __resetOpenaiCatalogueForTest()
  await refreshOpenaiCatalogue('api-key', { force: true, fetchImpl: fixtureFetch })
  a = getGptSeatAvailability()
  check('fixture catalogue ⇒ READY', a.state === 'ready')
  if (a.state === 'ready') {
    check('qualified ids visibility-filtered, priority-ordered (no generation floor)', a.ids.join(',') === 'gpt-5.6-sol,gpt-5.6-luna,gpt-5.2-orbit', a.ids.join(','))
    check('account source NAMED (billing honesty — env key never wears subscription clothes)', /OpenAI API key \(env\)/.test(a.source), a.source)
  }
}

{
  check('SEAT_MODEL_CYCLE stays Anthropic-only', SEAT_MODEL_CYCLE.every(m => m.startsWith('claude-')))
  check(
    'no role cycle ever yields a gpt id (explicit input is the only gpt path)',
    SLOT_ROLES.every(r => seatModelCycleFor(r).every(m => m.startsWith('claude-'))),
  )
}

{
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

{
  const wrapper = readFileSync(join(ROOT, 'src', 'commands', 'model', 'mercuryModel.tsx'), 'utf8')
  check(
    'GPT seat roles are the living pair (the party seats left with the multiplayer estate)',
    /GPT_SEAT_ROLES: readonly SlotRole\[\] = \['scribe', 'implementer'\]/.test(wrapper),
  )
  check("the 'g' action routes through applyOperatorReslot (→ setOperatorSeatSlot, the ONE validator)", /action === 'gpt'[\s\S]{0,2000}applyOperatorReslot\(role, \{ model: next \}/.test(wrapper))
  check('the g hint paints only when the press works (availability- and role-gated)', /gptAvailability\.state === 'ready' && GPT_SEAT_ROLES\.includes\(role\) \? ' · g slots gpt'/.test(wrapper))
  const picker = readFileSync(join(ROOT, 'src', 'components', 'MercuryModelPicker.tsx'), 'utf8')
  check("the picker wires input 'g' → RoleAction 'gpt' (own explicit keypress)", /input === 'g'[\s\S]{0,400}onRoleAction\?\.\(focusedRole\.role, 'gpt'\)/.test(picker))
  check('gptDetail renders on the focused row only (compact sheds it — CN-14 law 5)', /on && !compact && r\.gptDetail \?/.test(picker))
}

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
