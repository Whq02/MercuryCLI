#!/usr/bin/env bun
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'roster-frontier-default-'))
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = scratch
for (const key of ['MERCURY_MODEL', 'MERCURY_DEFAULT_FABLE_MODEL', 'MERCURY_DEFAULT_OPUS_MODEL', 'MERCURY_DEFAULT_SONNET_MODEL', 'MERCURY_DEFAULT_HAIKU_MODEL', 'MERCURY_DISABLE_1M_CONTEXT', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'MERCURY_WORKER_PARENT_PID']) delete process.env[key]
delete process.env.NODE_ENV
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' the default under a settings roster is a model the roster permits')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const model = await import('../../src/utils/model/model.ts')
const policy = await import('../../src/utils/model/frontierPolicy.ts')
const allow = await import('../../src/utils/model/modelAllowlist.ts')
const { computedDefault, resetComputedDefaultMemo } = await import('../../src/utils/model/computedDefault.ts')
const { providerFrontierFact } = await import('../../src/utils/model/providerFrontier.ts')
const { FAMILY_GENERATIONS, ALL_MODEL_CONFIGS } = await import('../../src/utils/model/configs.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
const { recordSignIn } = await import('../../src/utils/accounts/signInLedger.ts')
recordSignIn('anthropic', 'api-key')

const settingsPath = join(scratch, 'settings.json')
interface Reading {
  sent: string
  setting: string
  source: string
  code: string
  candidates: string[]
  provider: string | null
  row: string
  why: string
  frontierFact: string | undefined
  allowed: boolean
}
function underRoster(roster: string[] | null): Reading {
  writeFileSync(settingsPath, JSON.stringify(roster === null ? {} : { engine: { roster } }))
  resetSettingsCache()
  resetComputedDefaultMemo()
  const decision = policy.frontierOperatorDecision()
  const computed = computedDefault()
  const sent = model.normalizeModelStringForAPI(model.getEngineModel())
  return {
    sent,
    setting: model.getDefaultEngineModelSetting(),
    source: decision.source,
    code: decision.code,
    candidates: decision.candidates.map(c => c.id),
    provider: computed.provider,
    row: computed.row,
    why: computed.why,
    frontierFact: providerFrontierFact('anthropic')?.modelId,
    allowed: allow.isModelAllowed(sent),
  }
}
const show = (r: Reading): string => JSON.stringify(r)

const HEAD = ALL_MODEL_CONFIGS[FAMILY_GENERATIONS.fable[0]].firstParty
const PREVIOUS = 'claude-fable-5-1'
const OLDEST = 'claude-fable-5'

section('§1 nothing saved and no roster: the family head, as before')
{
  const r = underRoster(null)
  check(`the fable family's head is ${HEAD} and the first-party candidate is that id alone`, HEAD === 'claude-fable-5-2' && r.candidates.join(',') === HEAD, show(r))
  check('a key sign-in with no roster runs the large fallback (the candidate needs a subscription tier)', r.source === 'fallback' && r.code === 'not-subscriber' && r.sent === 'claude-opus-5-5' && r.provider === 'anthropic', show(r))
}

section('§2 a roster of only claude-fable-5-1 and nothing saved: the default is Fable 5.1, the newest fable generation the roster permits')
{
  const r = underRoster([PREVIOUS])
  check('the request model the live chain resolves is claude-fable-5-1', r.sent === PREVIOUS, show(r))
  check('the roster permits what the default sends', r.allowed, show(r))
  check("the decision is the frontier's, on the roster's own word (eligible-allowlist), with one candidate", r.source === 'frontier' && r.code === 'eligible-allowlist' && r.candidates.join(',') === PREVIOUS, show(r))
  check('the setting is the bare id (Fable 5.1 states a 1M window as the head does, so no [1m] rider is at stake in this case)', r.setting === PREVIOUS, show(r))
  check("the default row and its reason name Fable 5.1 as the allowlist's row", r.row === 'Fable 5.1' && r.why.includes('the model allowlist names it'), show(r))
  check("the frontier fact's own id is the chosen generation", r.frontierFact === PREVIOUS, show(r))
  check("the alias 'best' follows the same decision under that roster", model.parseUserSpecifiedModel('best') === PREVIOUS, model.parseUserSpecifiedModel('best'))
}

section('§3 the same answer for the other spellings of that roster')
{
  for (const roster of [['fable51'], ['fable', PREVIOUS], [PREVIOUS, 'opus'], [`${PREVIOUS}[1m]`]]) {
    const r = underRoster(roster)
    check(`${JSON.stringify(roster)} → claude-fable-5-1, permitted`, r.sent === PREVIOUS && r.allowed && r.source === 'frontier' && r.candidates.join(',') === PREVIOUS, show(r))
  }
}

section('§4 the walk is newest first and stops at the first generation the roster permits')
{
  const head = underRoster([HEAD, PREVIOUS])
  check('a roster that permits the head keeps the head', head.sent === HEAD && head.candidates.join(',') === HEAD && head.allowed, show(head))
  const word = underRoster(['fable'])
  check("the family word alone permits the head: 'fable' still means the newest row", word.sent === HEAD && word.allowed, show(word))
  const dated = underRoster([`${OLDEST}-20260401`])
  check('a roster no declared fable generation satisfies leaves the head as the one candidate, excluded', dated.source === 'fallback' && dated.code === 'allowlist-excluded' && dated.candidates.join(',') === HEAD, show(dated))
}

section('§5 a roster with no fable in it: the candidate stays the head and reads excluded')
{
  const r = underRoster(['opus'])
  check('the head is the one candidate and the allowlist excludes it', r.source === 'fallback' && r.code === 'allowlist-excluded' && r.candidates.join(',') === HEAD, show(r))
  check('the large fallback the roster names is what runs', r.sent === 'claude-opus-5-5' && r.allowed, show(r))
}

section('§6 the operator pin outranks the walk: MERCURY_DEFAULT_FABLE_MODEL stays the candidate verbatim')
{
  process.env.MERCURY_DEFAULT_FABLE_MODEL = HEAD
  try {
    const r = underRoster([PREVIOUS])
    check('with the pin set the candidate is the pinned id, never a walked one', r.candidates.join(',') === HEAD && r.code === 'allowlist-excluded', show(r))
  } finally {
    delete process.env.MERCURY_DEFAULT_FABLE_MODEL
  }
  process.env.MERCURY_DEFAULT_FABLE_MODEL = PREVIOUS
  try {
    const r = underRoster([PREVIOUS])
    check('a pin the roster permits wins as the env pin (its own evidence word)', r.sent === PREVIOUS && r.code === 'eligible-env-pin', show(r))
  } finally {
    delete process.env.MERCURY_DEFAULT_FABLE_MODEL
  }
}

section('§7 the 1M kill-switch leaves the chosen generation without a rider')
{
  process.env.MERCURY_DISABLE_1M_CONTEXT = '1'
  try {
    const off = underRoster([PREVIOUS])
    check('with 1M disabled the chosen generation still carries no rider', off.setting === PREVIOUS && off.sent === PREVIOUS, show(off))
  } finally {
    delete process.env.MERCURY_DISABLE_1M_CONTEXT
  }
}

underRoster(null)
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`}`)
process.exit(failures === 0 ? 0 : 1)
