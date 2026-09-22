#!/usr/bin/env bun
import { mkdtempSync as mkScratch } from 'node:fs'
import { tmpdir as osTmp } from 'node:os'
import { join as pathJoin } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const proofHome = mkScratch(pathJoin(osTmp(), 'opus-55-row-proof-'))
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = proofHome
for (const key of ['MERCURY_MODEL', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) delete process.env[key]
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
;(await import('../../src/utils/config.js')).enableConfigs()

for (const k of [
  'MERCURY_DEFAULT_OPUS_MODEL',
  'MERCURY_DEFAULT_SONNET_MODEL',
  'MERCURY_DEFAULT_FABLE_MODEL',
  'MERCURY_MODEL',
  'MERCURY_DISABLE_1M_CONTEXT',
  'MERCURY_AUTOPILOT_MODELS',
]) {
  delete process.env[k]
}

const {
  firstPartyNameToCanonical,
  getCanonicalName,
  getMarketingNameForModel,
  getPublicModelName,
  parseUserSpecifiedModel,
  renderModelChip,
  renderModelName,
} = await import('../../src/utils/model/model.ts')
const { recognizeModelId } = await import('../../src/services/providers/idSpaces.ts')

let failures = 0
function check(label: string, cond: boolean, detail?: string): void {
  const mark = cond ? 'PASS' : 'FAIL'
  if (!cond) failures++
  console.log(`  [${mark}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const ID = 'claude-opus-5-5'
const PREVIOUS = 'claude-opus-5'

section('§1 the fold order and the names: claude-opus-5-5 is its own canonical, never swallowed by the opus-5 arm')
{
  check('its own canonical', getCanonicalName(ID) === ID, getCanonicalName(ID))
  check('the [1m] twin folds to the same canonical', getCanonicalName(`${ID}[1m]`) === ID, getCanonicalName(`${ID}[1m]`))
  check('a spelling with case folds to the same canonical', getCanonicalName('Claude-Opus-5-5') === ID, getCanonicalName('Claude-Opus-5-5'))
  check('the first-party fold agrees', firstPartyNameToCanonical(ID) === ID, firstPartyNameToCanonical(ID))
  check('Opus 5 keeps its own canonical (the previous generation is not the newest)', getCanonicalName(PREVIOUS) === PREVIOUS, getCanonicalName(PREVIOUS))
  check('a dated Opus 5 spelling still folds onto Opus 5, never onto 5.5', getCanonicalName('claude-opus-5-20260401') === PREVIOUS, getCanonicalName('claude-opus-5-20260401'))
  check('a carrier-shaped row never joins the first-party fold', getCanonicalName('openrouter/anthropic/claude-opus-5-5') === 'openrouter/anthropic/claude-opus-5-5')
  check("the one display owner names it 'Opus 5.5'", renderModelName(ID) === 'Opus 5.5', renderModelName(ID))
  check("the marketing name is 'Opus 5.5'", getMarketingNameForModel(ID) === 'Opus 5.5', String(getMarketingNameForModel(ID)))
  check("the [1m] twin displays as 'Opus 5.5 (1M context)'", renderModelName(`${ID}[1m]`) === 'Opus 5.5 (1M context)', renderModelName(`${ID}[1m]`))
  check("the chip reads 'Opus 5.5'", renderModelChip(ID) === 'Opus 5.5', renderModelChip(ID))
  check("the commit-trailer name reads 'Claude Opus 5.5'", getPublicModelName(ID) === 'Claude Opus 5.5', getPublicModelName(ID))
  check("Opus 5 still displays as 'Opus 5'", renderModelName(PREVIOUS) === 'Opus 5', renderModelName(PREVIOUS))
  check("the exact-generation alias 'opus55' resolves to the bare id", parseUserSpecifiedModel('opus55') === ID, parseUserSpecifiedModel('opus55'))
  check("'opus55[1m]' keeps its rider", parseUserSpecifiedModel('opus55[1m]') === `${ID}[1m]`, parseUserSpecifiedModel('opus55[1m]'))
  check("the exact-generation alias 'opus5' still names Opus 5", parseUserSpecifiedModel('opus5') === PREVIOUS, parseUserSpecifiedModel('opus5'))
  check('the bare id passes through the setting parser byte-identical', parseUserSpecifiedModel(ID) === ID, parseUserSpecifiedModel(ID))
  const recognised = recognizeModelId('opus55')
  check("the id space recognises 'opus55' as a first-party alias spelling (the opus5 shape)", recognised.kind === 'first-party' && recognised.why === 'alias', JSON.stringify(recognised))
  check('the id space recognises the bare id by its claude- mark', recognizeModelId(ID).kind === 'first-party')
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` FAIL — ${failures} Opus 5.5 row check(s) failed`)
  process.exit(1)
}
console.log(' ALL OPUS 5.5 ROW PROOFS PASS')
