#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'


let failures = 0
const check = (label: string, ok: boolean, detail = '', fixHint = ''): void => {
  if (!ok) failures = 1
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}${!ok && fixHint ? ` — ${fixHint}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const text = (v: unknown): string => JSON.stringify(v)

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'neutral-worker-seat-')))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  process.env[spelling] = home
}
const CREDENTIAL_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_OAUTH_TOKEN',
  'MERCURY_GEMINI_OAUTH_TOKEN',
  'MOONSHOT_API_KEY',
  'MOONSHOT_TOKEN',
  'HF_TOKEN',
  'HF_OAUTH_TOKEN',
  'MERCURY_COMPAT_API_KEY',
  'MERCURY_COMPAT_BASE_URL',
] as const
for (const key of CREDENTIAL_KEYS) delete process.env[key]
for (const ambient of ['MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN']) {
  delete process.env[ambient]
}
delete process.env.NODE_ENV
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CREW_DIR = join(scratch, 'crew')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
mkdirSync(join(scratch, 'daemon'), { recursive: true })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

console.log('============================================================')
console.log(' the neutral worker seat — no family is favoured')
console.log('============================================================')

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const wm = await import('../../src/screen/concourse-model/workerModels.ts')
const { resetComputedDefaultMemo } = await import('../../src/models/catalogue/computedDefault.ts')
const { recordSignIn } = await import('../../src/models/sign-in/account-ledger/signInLedger.ts')

type Entry = import('../../src/screen/concourse-model/workerModels.ts').WorkerModelEntryV1
const reg = (entries: Entry[]) => ({ schema: 1 as const, entries })
const ok = { availability: 'available' } as const
const refusedAnthropic = { availability: 'refused', refusal: 'no-credential:anthropic', detail: 'x', action: 'y' } as const

section('§1 — the seed law, pure: operator default → neutral default → first available → the first row')
{
  const claudePinned: Entry = { modelId: 'claude-opus-5', displayName: 'Opus 5', session: refusedAnthropic, crew: refusedAnthropic, isOperatorDefault: true }
  const gptNeutral: Entry = { modelId: 'gpt-5.5', displayName: 'GPT-5.5', session: ok, crew: ok, effort: 'high', isNeutralDefault: true }
  const glmFirst: Entry = { modelId: 'glm-5.3', displayName: 'GLM-5.3', session: ok, crew: ok, effort: 'high' }
  check('the operator default wins while it dispatches', wm.defaultWorkerModelId(reg([{ ...claudePinned, session: ok, crew: ok }, glmFirst, gptNeutral]), 'session') === 'claude-opus-5', '', 'defaultWorkerModelId in src/screen/concourse-model/workerModels.ts must return the operator default row while it dispatches')
  check(
    'a refused operator pin falls to the NEUTRAL row on both arms — never the first listed row of a family nobody chose',
    wm.defaultWorkerModelId(reg([claudePinned, glmFirst, gptNeutral]), 'session') === 'gpt-5.5' && wm.defaultWorkerModelId(reg([claudePinned, glmFirst, gptNeutral]), 'crew') === 'gpt-5.5',
    '',
    'defaultWorkerModelId in src/screen/concourse-model/workerModels.ts must fall to the row marked isNeutralDefault, for both session and crew, when the operator pin is refused',
  )
  check('no marked row ⇒ the first available row (visible on the chip like any choice)', wm.defaultWorkerModelId(reg([claudePinned, glmFirst]), 'session') === 'glm-5.3', '', 'defaultWorkerModelId in src/screen/concourse-model/workerModels.ts must take the first available row when no row is marked')
  check('nothing available ⇒ the first row, typed-refused and visible, never a silent substitute', wm.defaultWorkerModelId(reg([claudePinned]), 'crew') === 'claude-opus-5', '', 'defaultWorkerModelId in src/screen/concourse-model/workerModels.ts must return the first row when nothing is available')
}

section('§2 — a keyless home: no neutral default, no roster, the two-door sentence, nothing routed')
{
  resetComputedDefaultMemo()
  check('neutralSeatDefault() is null with no usable sign-in', wm.neutralSeatDefault() === null, text(wm.neutralSeatDefault()), 'neutralSeatDefault in src/screen/concourse-model/workerModels.ts must return null when no provider is signed in')
  check('seatFamilyChoices() is empty', wm.seatFamilyChoices().length === 0, text(wm.seatFamilyChoices()), 'seatFamilyChoices in src/screen/concourse-model/workerModels.ts must list no family when none is signed in')
  const word = await wm.validateWorkerModelChoice('openai', 'session')
  check(
    "the family word 'openai' with no sign-in refuses that family's own door (no-credential:openai), never an 'unrecognised' about the word",
    !word.ok && word.reason === 'no-credential:openai' && String(word.action).includes('/logins openai'),
    text(word),
    'validateWorkerModelChoice in src/screen/concourse-model/workerModels.ts must refuse a family word with no-credential:<family> and an action naming /logins <family>',
  )

  const facts = await import('../../src/daemon/switchboard/bootBirthFacts.ts')
  check('screenBirthModel() is undefined on a keyless home — the birth door passes no model', facts.screenBirthModel() === undefined, text(facts.screenBirthModel()), 'screenBirthModel in src/daemon/switchboard/bootBirthFacts.ts must return undefined on a keyless home')
  check('birthModelOf carries the nothing through (no record model, no door model)', facts.birthModelOf({ model: null }, null, facts.screenBirthModel()) === undefined, '', 'birthModelOf in src/daemon/switchboard/bootBirthFacts.ts must return undefined when neither the record nor the door names a model')
  const spelled = await wm.validateWorkerModelChoice('claude-opus-5', 'session')
  check("a spelled-out Claude id on a keyless home keeps its family's own door (only a launch with no id admits keyless)", !spelled.ok && spelled.reason === 'no-credential:anthropic', text(spelled), 'validateWorkerModelChoice in src/screen/concourse-model/workerModels.ts must refuse a spelled-out Claude id on a keyless home with no-credential:anthropic')
  const { operatorFacingBirthReason } = await import('../../src/daemon/switchboard/bornSession.ts')
  const relayed = "model refused (no-credential:anthropic) · ask the operator to run /logins anthropic — or OpenAI is signed in: leave the model out for its newest row (gpt-5.6), or name 'openai' to pick that family — the anthropic family holds no credential on this account (got \"claude-opus-5\")"
  const spoken = operatorFacingBirthReason(relayed)
  check("the operator's door strips the relay preamble and keeps the imperative", !/ask the operator/.test(spoken) && spoken.includes('· run /logins anthropic'), spoken, 'operatorFacingBirthReason in src/daemon/switchboard/bornSession.ts must drop the ask the operator preamble and keep the run /logins imperative')
  check("…and turns the launch-arg way-out into the operator's own (/model picks the newest row)", spoken.includes('/model gpt-5.6 picks its newest row') && !/leave the model out|name 'openai'/.test(spoken), spoken, 'operatorFacingBirthReason in src/daemon/switchboard/bornSession.ts must turn the launch-argument way-out into the /model <id> picks its newest row wording')
  check('a sentence with no relay words passes through untouched', operatorFacingBirthReason('every seat is taken — 1 of 1') === 'every seat is taken — 1 of 1', '', 'operatorFacingBirthReason in src/daemon/switchboard/bornSession.ts must pass a sentence with no relay words through unchanged')
  const keylessAdmit = await wm.validateWorkerModelChoice(undefined, 'session')
  check('the daemon admits the unnamed SESSION launch keyless (never a refusal naming a family)', keylessAdmit.ok && keylessAdmit.keyless === true, text(keylessAdmit), 'validateWorkerModelChoice in src/screen/concourse-model/workerModels.ts must admit an unnamed session launch as keyless')
}

section('§3 — ONLY OPENAI SIGNED IN: the seat is the GPT row everywhere; a named Claude choice refuses naming the way out')
const { startCrossfamilyFixture } = await import('../lib/crossfamilyConcourseFixture.ts')
const fixture = await startCrossfamilyFixture({ port: 0 })
try {
  for (const key of ['MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'OPENAI_API_KEY'] as const) {
    process.env[key] = fixture.env[key]
  }
  recordSignIn('openai', 'api-key')
  const { refreshOpenaiCatalogue } = await import('../../src/models/roads/openai/openaiCatalogue.ts')
  await refreshOpenaiCatalogue('api-key', { force: true }).catch(() => null)
  let neutral = null as ReturnType<typeof wm.neutralSeatDefault>
  for (let i = 0; i < 40 && (neutral === null || neutral.family !== 'openai'); i++) {
    resetComputedDefaultMemo()
    neutral = wm.neutralSeatDefault()
    if (neutral === null || neutral.family !== 'openai') await new Promise(r => setTimeout(r, 250))
  }
  check('the neutral seat default is the OpenAI family (the only sign-in)', neutral !== null && neutral.family === 'openai', text(neutral), 'neutralSeatDefault in src/screen/concourse-model/workerModels.ts must answer the OpenAI family when it is the only sign-in; the OpenAI catalogue refresh may also have failed against the fixture')
  const gptRow = neutral?.setting ?? ''
  check('…its newest usable row is a GPT id', /gpt/i.test(gptRow), gptRow, 'the neutral default setting must be the newest usable GPT row: see neutralSeatDefault in src/screen/concourse-model/workerModels.ts')
  const registry = await wm.composeWorkerModelRegistry()
  const seedSession = wm.defaultWorkerModelId(registry, 'session')
  check('the registry seeds the session arm on the GPT row', /gpt/i.test(seedSession), text({ seedSession }), 'composeWorkerModelRegistry and defaultWorkerModelId in src/screen/concourse-model/workerModels.ts must seed the session arm on the GPT row')
  const facts3 = await import('../../src/daemon/switchboard/bootBirthFacts.ts')
  check('with only OpenAI signed in the birth door hands the daemon the GPT row (screenBirthModel = the neutral default)', facts3.screenBirthModel() === gptRow, text({ screen: facts3.screenBirthModel(), gptRow }), 'screenBirthModel in src/daemon/switchboard/bootBirthFacts.ts must equal the neutral default setting')

  section('§4 — anthropic signs in LATER: the neutral default follows the most recent sign-in')
  process.env.ANTHROPIC_API_KEY = fixture.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_BASE_URL = fixture.env.ANTHROPIC_BASE_URL
  await new Promise(r => setTimeout(r, 5))
  recordSignIn('anthropic', 'api-key')
  resetComputedDefaultMemo()
  const later = wm.neutralSeatDefault()
  check('the neutral default is now the Anthropic family (the most recent sign-in)', later !== null && later.family === 'anthropic', text(later), 'neutralSeatDefault in src/screen/concourse-model/workerModels.ts must follow the most recent sign-in recorded by recordSignIn')
  const stillWord = await wm.validateWorkerModelChoice('openai', 'session')
  check("the family word 'openai' still picks the GPT row beside it", stillWord.ok && /gpt/i.test(stillWord.entry.modelId), text(stillWord), 'validateWorkerModelChoice in src/screen/concourse-model/workerModels.ts must still resolve the family word openai to its GPT row')
} finally {
  await fixture.close()
  removeScratch(scratch)
}

console.log(failures === 0 ? '\nprove-neutral-worker-seat: NO FAMILY IS FAVOURED' : '\nprove-neutral-worker-seat: FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
