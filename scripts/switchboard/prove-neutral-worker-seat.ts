#!/usr/bin/env bun
// ============================================================================
//  prove-neutral-worker-seat — NO FAMILY IS FAVOURED for a worker seat.
//
//  The find (the deployed build, the operator's screenshot): every
//  coordinator-spawned worker refused "model refused (no-credential:anthropic)
//  · ask the operator to run /logins anthropic — the anthropic family holds
//  no credential on this account (got "claude-opus-5")" on an account
//  signed into another provider — the crew arm ran an Anthropic-only
//  vocabulary, the crew spawn's roster was four Claude keys, the workflow
//  executor a pinned Claude id, and a credential refusal named only the
//  family it refused.
//
//  The law: a seat nobody named a model for lands on the operator's own
//  default, else the NEUTRAL default — the most recent sign-in's provider,
//  its newest usable row (computedDefault, the one owner); a family WORD
//  picks that family's newest signed-in row; a choice exists per SIGNED-IN
//  family; a credential refusal names the family that IS signed in as the
//  way out. ONE resolver (workerModels) — the coordinator's launches, the
//  crew spawn and the workflow executor all ask it.
//
//    §1 the pure seed law over hand-built registries: operator default →
//       neutral default → first available → the first row, visibly
//    §2 a KEYLESS home: no neutral default, no roster, the two-door
//       sentence for an unnamed seat, nothing routed for an executor
//    §3 ONLY OPENAI SIGNED IN (the loopback fixture serves the OpenAI
//       models list; nothing Anthropic reaches the env): the neutral
//       default is the GPT row; the registry seeds BOTH arms on it; an
//       unnamed crew seat, the family word 'openai' and the workflow
//       executor all land there; the roster offers exactly OpenAI; a NAMED
//       Claude choice ('opus', 'claude-opus-5') refuses
//       no-credential:anthropic naming /logins anthropic AND OpenAI as the
//       way out; the bundled workflow's compatible set carries the GPT row
//       and no Claude id
//    §4 anthropic signs in LATER ⇒ the neutral default follows the most
//       recent sign-in; the roster gains the family and its generation keys
//
//  Run: ~/.bun/bin/bun run scripts/switchboard/prove-neutral-worker-seat.ts
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures = 1
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const text = (v: unknown): string => JSON.stringify(v)

// ── env hygiene BEFORE any src import ───────────────────────────────────────
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
  'CLAUDE_CODE_OAUTH_TOKEN',
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
for (const ambient of ['ANTHROPIC_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_WORKFLOW_ROUTING', 'MERCURY_DAEDALUS_MODEL', 'MERCURY_DAEDALUS_EXECUTOR_MODEL']) {
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

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const wm = await import('../../src/services/concourse/workerModels.ts')
const crew = await import('../../src/daemon/crewSpawn.ts')
const wr = await import('../../src/tools/WorkflowTool/workflowRouting.ts')
const daedalus = await import('../../src/tools/WorkflowTool/bundled/daedalus.ts')
const { resetComputedDefaultMemo } = await import('../../src/utils/model/computedDefault.ts')
const { recordSignIn } = await import('../../src/utils/accounts/signInLedger.ts')

type Entry = import('../../src/services/concourse/workerModels.ts').WorkerModelEntryV1
const reg = (entries: Entry[]) => ({ schema: 1 as const, entries })
const ok = { availability: 'available' } as const
const refusedAnthropic = { availability: 'refused', refusal: 'no-credential:anthropic', detail: 'x', action: 'y' } as const

//
section('§1 — the seed law, pure: operator default → neutral default → first available → the first row')
//
{
  const claudePinned: Entry = { modelId: 'claude-opus-5', displayName: 'Opus 5', session: refusedAnthropic, crew: refusedAnthropic, isOperatorDefault: true }
  const gptNeutral: Entry = { modelId: 'gpt-5.5', displayName: 'GPT-5.5', session: ok, crew: ok, effort: 'high', isNeutralDefault: true }
  const glmFirst: Entry = { modelId: 'glm-5.3', displayName: 'GLM-5.3', session: ok, crew: ok, effort: 'high' }
  check('the operator default wins while it dispatches', wm.defaultWorkerModelId(reg([{ ...claudePinned, session: ok, crew: ok }, glmFirst, gptNeutral]), 'session') === 'claude-opus-5')
  check(
    'a refused operator pin falls to the NEUTRAL row on both arms — never the first listed row of a family nobody chose',
    wm.defaultWorkerModelId(reg([claudePinned, glmFirst, gptNeutral]), 'session') === 'gpt-5.5' && wm.defaultWorkerModelId(reg([claudePinned, glmFirst, gptNeutral]), 'crew') === 'gpt-5.5',
  )
  check('no marked row ⇒ the first available row (visible on the chip like any choice)', wm.defaultWorkerModelId(reg([claudePinned, glmFirst]), 'session') === 'glm-5.3')
  check('nothing available ⇒ the first row, typed-refused and visible, never a silent substitute', wm.defaultWorkerModelId(reg([claudePinned]), 'crew') === 'claude-opus-5')
}

//
section('§2 — a keyless home: no neutral default, no roster, the two-door sentence, nothing routed')
//
{
  resetComputedDefaultMemo()
  check('neutralSeatDefault() is null with no usable sign-in', wm.neutralSeatDefault() === null, text(wm.neutralSeatDefault()))
  check('seatFamilyChoices() is empty', wm.seatFamilyChoices().length === 0, text(wm.seatFamilyChoices()))
  check('crewModelChoices() offers nothing — no favoured family, no Claude key on a keyless home', crew.crewModelChoices().length === 0, text(crew.crewModelChoices()))
  const unnamed = await crew.resolveCrewSeatModel(undefined)
  check(
    'an unnamed crew seat refuses with the two-door sentence (no family named)',
    !unnamed.ok && unnamed.error.includes(wm.NO_ACCOUNT_REFUSAL) && unnamed.error.includes('/logins to choose an account'),
    text(unnamed),
  )
  const word = await wm.validateWorkerModelChoice('openai', 'crew')
  check(
    "the family word 'openai' with no sign-in refuses that family's own door (no-credential:openai), never an 'unrecognised' about the word",
    !word.ok && word.reason === 'no-credential:openai' && String(word.action).includes('/logins openai'),
    text(word),
  )
  process.env.MERCURY_WORKFLOW_ROUTING = '1'
  check('the workflow executor routes nothing on a keyless home (never a family the account does not hold)', wr.resolveWorkflowRoutedModel({ tier: 'executor' }) === undefined)
  check('the bundled workflow offers no model (nothing signed in)', daedalus.daedalusCompatibleModels().size === 0, text([...daedalus.daedalusCompatibleModels()]))

  // THE BIRTH CARRIES NO MODEL (the neutral-default ruling): the door's
  // screen arm is NOTHING on a keyless home, the admit frame omits the
  // field, the daemon admits the unnamed session launch keyless and boots
  // the runner modelless — the cockpit paints, its composer's own gate
  // names the logins door, and the first send is what a credential gates.
  const facts = await import('../../src/services/switchboard/bootBirthFacts.ts')
  check('screenBirthModel() is undefined on a keyless home — the birth door passes no model', facts.screenBirthModel() === undefined, text(facts.screenBirthModel()))
  check('birthModelOf carries the nothing through (no record model, no door model)', facts.birthModelOf({ model: null }, null, facts.screenBirthModel()) === undefined)
  const door = read('src/services/switchboard/bornSession.ts')
  check('the admit frame omits the model field when the door has none', door.includes('...(model !== undefined ? { model } : {}),') && door.includes('screenBirthModel()'))
  check('the door drops every inherited or chosen model on a keyless home', door.includes('const model = screen === undefined ? undefined : birthModelOf(facts, req.model ?? null, screen)'))
  const spelled = await wm.validateWorkerModelChoice('claude-opus-5', 'session')
  check("a spelled-out Claude id on a keyless home keeps its family's own door (only a launch with no id admits keyless)", !spelled.ok && spelled.reason === 'no-credential:anthropic', text(spelled))
  // THE OPERATOR'S OWN DOOR speaks the refusal to its reader: the daemon's
  // way-out is addressed to a relay ("ask the operator to run …"; "leave
  // the model out … or name 'openai'"); bornSession rewrites it for the
  // operator's own chat — the imperative stays, the launch-arg way-out
  // becomes /model.
  const { operatorFacingBirthReason } = await import('../../src/services/switchboard/bornSession.ts')
  const relayed = "model refused (no-credential:anthropic) · ask the operator to run /logins anthropic — or OpenAI is signed in: leave the model out for its newest row (gpt-5.6), or name 'openai' to pick that family — the anthropic family holds no credential on this account (got \"claude-opus-5\")"
  const spoken = operatorFacingBirthReason(relayed)
  check("the operator's door strips the relay preamble and keeps the imperative", !/ask the operator/.test(spoken) && spoken.includes('· run /logins anthropic'), spoken)
  check("…and turns the launch-arg way-out into the operator's own (/model picks the newest row)", spoken.includes('/model gpt-5.6 picks its newest row') && !/leave the model out|name 'openai'/.test(spoken), spoken)
  check('a sentence with no relay words passes through untouched', operatorFacingBirthReason('every seat is taken — 1 of 1') === 'every seat is taken — 1 of 1')
  const keylessAdmit = await wm.validateWorkerModelChoice(undefined, 'session')
  check('the daemon admits the unnamed SESSION launch keyless (never a refusal naming a family)', keylessAdmit.ok && keylessAdmit.keyless === true, text(keylessAdmit))
  check('a keyless runner boots with NO --model', read('src/daemon/headlessRun.ts').includes("...(spec.keyless ? [] : ['--model', model]),"))
  const supervisor = read('src/daemon/concourseSupervisor.ts')
  check('the admission stamps the record keyless, skips the warm claim, and a resume re-validates it unnamed', supervisor.includes('const keyless = admission.keyless === true') && supervisor.includes('!keyless &&') && supervisor.includes('r.keyless !== true'))
  check('a keyless home warms nothing (no runner pinned to the placeholder)', read('src/daemon/warmRunner.ts').includes('validated.keyless === true'))
}

//
section('§3 — ONLY OPENAI SIGNED IN: the seat is the GPT row everywhere; a named Claude choice refuses naming the way out')
//
const { startCrossfamilyFixture } = await import('../lib/crossfamilyConcourseFixture.ts')
const fixture = await startCrossfamilyFixture({ port: 41000 + (process.pid % 10000) })
try {
  // ONLY the OpenAI half of the fixture's env — nothing Anthropic, nothing
  // Z.AI, nothing OpenRouter reaches this process.
  for (const key of ['MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'OPENAI_API_KEY'] as const) {
    process.env[key] = fixture.env[key]
  }
  recordSignIn('openai', 'api-key')
  const { refreshOpenaiCatalogue } = await import('../../src/services/providers/openai/openaiCatalogue.ts')
  await refreshOpenaiCatalogue('api-key', { force: true }).catch(() => null)
  // The neutral default is the OpenAI row once the lineup qualifies against
  // the fixture catalogue — a bounded wait (the picker's own refresh lands
  // asynchronously).
  let neutral = null as ReturnType<typeof wm.neutralSeatDefault>
  for (let i = 0; i < 40 && (neutral === null || neutral.family !== 'openai'); i++) {
    resetComputedDefaultMemo()
    neutral = wm.neutralSeatDefault()
    if (neutral === null || neutral.family !== 'openai') await new Promise(r => setTimeout(r, 250))
  }
  check('the neutral seat default is the OpenAI family (the only sign-in)', neutral !== null && neutral.family === 'openai', text(neutral))
  const gptRow = neutral?.setting ?? ''
  check('…its newest usable row is a GPT id', /gpt/i.test(gptRow), gptRow)
  const registry = await wm.composeWorkerModelRegistry()
  const seedSession = wm.defaultWorkerModelId(registry, 'session')
  const seedCrew = wm.defaultWorkerModelId(registry, 'crew')
  check('the registry seeds BOTH arms on the GPT row', /gpt/i.test(seedSession) && /gpt/i.test(seedCrew), text({ seedSession, seedCrew }))
  const unnamedCrew = await wm.validateWorkerModelChoice(undefined, 'crew')
  check('an UNNAMED crew seat validates ok on the GPT row (the operator’s screenshot, closed)', unnamedCrew.ok && /gpt/i.test(unnamedCrew.entry.modelId), text(unnamedCrew))
  const word = await wm.validateWorkerModelChoice('openai', 'crew')
  check("the family word 'openai' resolves to that family's newest row", word.ok && /gpt/i.test(word.entry.modelId), text(word))
  const spawn = await crew.resolveCrewSeatModel(undefined)
  check('crew spawn, nothing named ⇒ the GPT row at the convention effort', spawn.ok && /gpt/i.test(spawn.model) && spawn.effort === 'high', text(spawn))
  const spawnWord = await crew.resolveCrewSeatModel('openai')
  check('crew spawn by family word ⇒ the GPT row', spawnWord.ok && /gpt/i.test(spawnWord.model), text(spawnWord))
  const roster = crew.crewModelChoices()
  check(
    'the roster offers exactly the signed-in family — OpenAI — and no Claude key',
    roster.length === 1 && roster[0]?.key === 'openai' && /gpt/i.test(roster[0]?.model ?? '') && !roster.some(c => /claude|opus|sonnet|fable/i.test(c.key + c.model)),
    text(roster),
  )
  for (const named of ['opus', 'claude-opus-5']) {
    const refused = await crew.resolveCrewSeatModel(named)
    check(`a NAMED Claude choice '${named}' refuses no-credential:anthropic`, !refused.ok && refused.error.includes('no-credential:anthropic'), text(refused))
    check(
      `…naming /logins anthropic AND OpenAI as the way out`,
      !refused.ok && refused.error.includes('/logins anthropic') && /openai/i.test(refused.error) && refused.error.includes("name 'openai'"),
      text(refused),
    )
  }
  process.env.MERCURY_WORKFLOW_ROUTING = '1'
  check('the workflow executor routes to the same GPT row (one resolver)', wr.resolveWorkflowRoutedModel({ tier: 'executor' }) === gptRow, text({ routed: wr.resolveWorkflowRoutedModel({ tier: 'executor' }), gptRow }))
  // With a sign-in the birth door hands the daemon the neutral default —
  // the modelless birth is the KEYLESS home's shape only, never an
  // over-correction that strips every birth of its model.
  const facts3 = await import('../../src/services/switchboard/bootBirthFacts.ts')
  check('with only OpenAI signed in the birth door hands the daemon the GPT row (screenBirthModel = the neutral default)', facts3.screenBirthModel() === gptRow, text({ screen: facts3.screenBirthModel(), gptRow }))
  const compatible = daedalus.daedalusCompatibleModels()
  check(
    "the bundled workflow's compatible set carries 'openai' and the GPT row, and no Claude id",
    compatible.has('openai') && compatible.has(gptRow) && ![...compatible].some(id => /claude|^opus$|^sonnet$|^fable/.test(id)),
    text([...compatible]),
  )

  //
  section('§4 — anthropic signs in LATER: the neutral default follows the most recent sign-in')
  //
  process.env.ANTHROPIC_API_KEY = fixture.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_BASE_URL = fixture.env.ANTHROPIC_BASE_URL
  await new Promise(r => setTimeout(r, 5))
  recordSignIn('anthropic', 'api-key')
  resetComputedDefaultMemo()
  const later = wm.neutralSeatDefault()
  check('the neutral default is now the Anthropic family (the most recent sign-in)', later !== null && later.family === 'anthropic', text(later))
  const both = crew.crewModelChoices()
  check(
    'the roster offers both families, the most recent first, plus the Anthropic generation keys',
    both[0]?.key === 'anthropic' && both.some(c => c.key === 'openai') && both.some(c => c.key === 'opus'),
    text(both.map(c => c.key)),
  )
  const stillWord = await wm.validateWorkerModelChoice('openai', 'crew')
  check("the family word 'openai' still picks the GPT row beside it", stillWord.ok && /gpt/i.test(stillWord.entry.modelId), text(stillWord))
} finally {
  await fixture.close()
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-neutral-worker-seat: NO FAMILY IS FAVOURED' : '\nprove-neutral-worker-seat: FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
