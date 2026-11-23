#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const text = (v: unknown): string => JSON.stringify(v) ?? ''
const whereAdmission = 'change validateWorkerModelChoice in src/screen/concourse-model/workerModels.ts'
const wherePreflight = 'change preflightConcourseDispatch in src/daemon/concourse-workers/concourseDispatch.ts'
const withHint = (value: string, hint: string): string => `${value} — ${hint}`

const scratch = mkdtempSync(join(tmpdir(), 'claude-door-capability-'))
const home = join(scratch, 'home')
const work = join(scratch, 'work')
mkdirSync(home, { recursive: true })
mkdirSync(work, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  process.env[spelling] = home
}
for (const key of [
  'OPENAI_API_KEY',
  'MERCURY_MODEL',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'HF_TOKEN',
  'DEEPSEEK_API_KEY',
  'ZAI_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
]) {
  delete process.env[key]
}
delete process.env.NODE_ENV
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CREW_DIR = join(scratch, 'crew')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const UNKNOWN_CLAUDE_ID = 'claude-zephyr-9-1'
const STRANGER = 'zephyr-9-1'
const REAL_ID = 'claude-sonnet-5-5'

console.log('============================================================')
console.log(' the Claude door — a Claude id the account can run starts from every door; the wire decides')
console.log('============================================================')

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const wm = await import('../../src/screen/concourse-model/workerModels.ts')
const { declaredRouteOf } = await import('../../src/models/roads/routeLaw.ts')
const { getModelOptions } = await import('../../src/models/catalogue/modelOptions.ts')
const { getEngineModel } = await import('../../src/models/catalogue/engineModel.ts')
const { refreshSignInReads } = await import('../../src/daemon/session-seat/signInView.ts')

section(`§1 the session and crew doors: '${UNKNOWN_CLAUDE_ID}' (no catalogue knows it) dispatches on capability`)
{
  check('the id is inside the first-party space (the claude- mark routes it to the Anthropic lane)', declaredRouteOf(UNKNOWN_CLAUDE_ID) === 'anthropic', withHint(String(declaredRouteOf(UNKNOWN_CLAUDE_ID)), 'change declaredRouteOf in src/models/roads/routeLaw.ts so the claude- mark routes to anthropic'))
  check('no catalogue row lists it', !getModelOptions().some(o => o.value === UNKNOWN_CLAUDE_ID), 'the fixture id appeared in getModelOptions (src/models/catalogue/modelOptions.ts); pick an id no catalogue lists')
  const session = await wm.validateWorkerModelChoice(UNKNOWN_CLAUDE_ID, 'session')
  check('the SESSION door admits it — dispatched to the Anthropic lane, the wire decides', session.ok && session.entry.modelId === UNKNOWN_CLAUDE_ID && session.entry.session.availability === 'available', withHint(text(session), whereAdmission + ' so a claude- id no catalogue knows is admitted as available on the Anthropic lane'))
  check('…with the ratified effort convention on the row', session.ok && session.entry.effort === 'high', withHint(text(session), whereAdmission + ' so the admitted row carries effort high'))
  const { preflightConcourseDispatch } = await import('../../src/daemon/concourse-workers/concourseDispatch.ts')
  const preflight = await preflightConcourseDispatch({ workspaceDir: work, modelKey: UNKNOWN_CLAUDE_ID })
  check("the birth door's preflight (the boot face's New Session road) is CLEAN on it", preflight.ok === true, withHint(text(preflight), wherePreflight + ' so an unknown claude- id passes'))
  const twin = await wm.validateWorkerModelChoice(`${UNKNOWN_CLAUDE_ID}[1m]`, 'session')
  check('the [1m] rider folds and the bare id dispatches', twin.ok && twin.entry.modelId === UNKNOWN_CLAUDE_ID, withHint(text(twin), whereAdmission + ' so the [1m] rider folds to the bare id'))
}

section('§2 the honest refusals stay: a family-less stranger, and a keyless family')
{
  const stranger = await wm.validateWorkerModelChoice(STRANGER, 'session')
  check(`'${STRANGER}' (no family declares it) still refuses not-runnable:unrecognised`, !stranger.ok && stranger.reason === 'not-runnable:unrecognised' && /no provider family declares/.test(stranger.detail ?? ''), withHint(text(stranger), whereAdmission + ' to refuse a family-less id as not-runnable:unrecognised with the no provider family declares detail'))
  check("…and its action names the picker, never a family's door", !stranger.ok && /model picker/.test(stranger.action ?? ''), withHint(text(stranger), whereAdmission + ' so the unrecognised refusal action names the model picker'))
  const spoken = await wm.validateWorkerModelChoice('sonnet 5', 'session')
  check("a spoken name still lands on its one row ('sonnet 5' → claude-sonnet-5)", spoken.ok && spoken.entry.modelId === 'claude-sonnet-5', withHint(text(spoken), whereAdmission + ' so a spoken name resolves to its one catalogue row'))
  const listed = await wm.validateWorkerModelChoice('claude-opus-5-5', 'session')
  check('a listed row keeps its display name (the catalogue still names what it knows)', listed.ok && listed.entry.displayName === 'Opus 5.5', withHint(text(listed), whereAdmission + ' so a listed row keeps its catalogue display name'))

  delete process.env.ANTHROPIC_API_KEY
  refreshSignInReads(true)
  const keyless = await wm.validateWorkerModelChoice(UNKNOWN_CLAUDE_ID, 'session')
  check("with no Anthropic credential the id refuses no-credential:anthropic — the family's door, never 'unknown-model'", !keyless.ok && keyless.reason === 'no-credential:anthropic', withHint(text(keyless), whereAdmission + ' to refuse a keyless first-party id as no-credential:anthropic'))
  check('…with the /logins anthropic action riding the refusal', !keyless.ok && /\/logins anthropic/.test(keyless.action ?? ''), withHint(text(keyless), whereAdmission + ' so the no-credential refusal action carries /logins anthropic'))
  process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
  refreshSignInReads(true)

  const { resetSettingsCache } = await import('../../src/platform/settings/settingsCache.ts')
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ engine: { roster: ['claude-opus-5-5'] } }, null, 2))
  resetSettingsCache()
  const forbidden = await wm.validateWorkerModelChoice(UNKNOWN_CLAUDE_ID, 'session')
  check("an organization's engine.roster still binds the door (the Chat refuses on it before any call)", !forbidden.ok && forbidden.reason === 'not-runnable:not-allowed' && /engine\.roster/.test(forbidden.detail ?? ''), withHint(text(forbidden), whereAdmission + ' so engine.roster binds the id as not-runnable:not-allowed and the detail names engine.roster'))
  const forbiddenEngine = await wm.validateWorkerModelChoice('gpt-5.9-nova', 'session')
  check('…and binds an engine namespace id the same way', !forbiddenEngine.ok && forbiddenEngine.reason === 'not-runnable:not-allowed', withHint(text(forbiddenEngine), whereAdmission + ' so engine.roster also binds an engine namespace id'))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({}, null, 2))
  resetSettingsCache()
}

section(`§3 the real case: '${REAL_ID}' saved after the daemon booted, judged by a bundle whose catalogue predates the row`)
{
  const primed = getEngineModel()
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ engine: { model: REAL_ID } }, null, 2))
  check("the saved setting names the row while this process's settings read still holds its boot-time value (the daemon's read)", getEngineModel() === primed && primed !== REAL_ID, withHint(`${primed} → ${getEngineModel()}`, 'getEngineModel in src/models/catalogue/engineModel.ts must keep its boot-time value until the settings cache resets; the proof relies on that'))
  const { parseUserSpecifiedModel } = await import('../../src/models/catalogue/engineModel.ts')
  const canonical = (value: string): string => parseUserSpecifiedModel(value).replace(/\[1m]$/, '')
  const preRow = () => getModelOptions().filter(o => canonical(o.value) !== REAL_ID)
  check('the pre-row catalogue read lists no Sonnet 5.5 row', !preRow().some(o => canonical(o.value) === REAL_ID), 'preRow filters on canonical(parseUserSpecifiedModel); check parseUserSpecifiedModel in src/models/catalogue/engineModel.ts')
  const registry = await wm.composeWorkerModelRegistry({ modelOptions: preRow })
  check("the registry composes from the injected read — a bundle whose catalogue predates the row (a build without the read judges by its own catalogue alone)", !registry.entries.some(e => e.modelId === REAL_ID), withHint(text(registry.entries.map(e => e.modelId)), 'change composeWorkerModelRegistry in src/screen/concourse-model/workerModels.ts so it builds from the injected modelOptions read alone'))
  const born = await wm.validateWorkerModelChoice(REAL_ID, 'session', { modelOptions: preRow })
  check(`the boot face's new session on '${REAL_ID}' resolves under that read — dispatched to the Anthropic lane, never "'${REAL_ID}' is not an exact model id"`, born.ok && born.entry.modelId === REAL_ID && born.entry.session.availability === 'available', withHint(text(born), whereAdmission + ' so a Claude id the injected catalogue lacks is still admitted as available'))
}

const FUTURE_IDS = [UNKNOWN_CLAUDE_ID, 'claude-sonnet-7-3']

section('§4 the guarantee — a future Claude id starts from EVERY door, the wire deciding')
{
  const { preflightConcourseDispatch } = await import('../../src/daemon/concourse-workers/concourseDispatch.ts')
  const { setSubModel, resolveSubModel } = await import('../../src/models/catalogue/subModelSlots.ts')
  const { resolveAdvisorModel } = await import('../../src/models/advisor/advisorSettings.ts')
  const { validateModel } = await import('../../src/models/roads/validateModel.ts')
  const { homeLaneAdmissionRefusal } = await import('../../src/models/roads/homeLaneAdmission.ts')
  const { canonicalWireModelId } = await import('../../src/models/roads/routeLaw.ts')
  const { recognizeModelId } = await import('../../src/models/roads/idSpaces.ts')
  const { parseUserSpecifiedModel } = await import('../../src/models/catalogue/engineModel.ts')
  const { isModelAllowed } = await import('../../src/models/catalogue/modelAllowlist.ts')
  for (const id of FUTURE_IDS) {
    console.log(`  · ${id}`)
    check(`identity: the id passes through the setting parser byte-identical, is first-party by the claude- mark, admitted by the home lane, allowed, and rides the wire as itself`, parseUserSpecifiedModel(id) === id && recognizeModelId(id).kind === 'first-party' && homeLaneAdmissionRefusal(id) === null && isModelAllowed(id) && canonicalWireModelId(id).ok, withHint(id, 'one leg failed: parseUserSpecifiedModel (src/models/catalogue/engineModel.ts), recognizeModelId (src/models/roads/idSpaces.ts), homeLaneAdmissionRefusal (src/models/roads/homeLaneAdmission.ts), isModelAllowed (src/models/catalogue/modelAllowlist.ts) or canonicalWireModelId (src/models/roads/routeLaw.ts)'))
    const admission = await wm.validateWorkerModelChoice(id, 'session')
    check("door · the daemon's session admission (the boot face's New Session, /clear, --model and a saved setting all reach it through bornSession)", admission.ok && admission.entry.modelId === id, withHint(text(admission), whereAdmission))
    const preflight = await preflightConcourseDispatch({ workspaceDir: work, modelKey: id })
    check("door · the birth door's preflight", preflight.ok === true, withHint(text(preflight), wherePreflight))
    const picked = setSubModel('advisor', id)
    const advisor = resolveAdvisorModel()
    check("door · the advisor pick (/submodels) and AskAdvisor's model", picked.ok && advisor.origin === 'saved' && advisor.model === id && advisor.route === 'anthropic', withHint(`${text(picked)} ${text(advisor)}`, 'change setSubModel in src/models/catalogue/subModelSlots.ts or resolveAdvisorModel in src/models/advisor/advisorSettings.ts'))
    setSubModel('advisor', null)
  }

  check('the shape guards stay: a bare vendor slug is carrier-shaped junk for the home lane', !canonicalWireModelId('anthropic/claude-zephyr-9-1').ok, 'change canonicalWireModelId in src/models/roads/routeLaw.ts to refuse a vendor-slug id on the home lane')
  check("the shape guards stay: a spelling without the claude- mark is no family's ('claude zephyr 9' → unrecognised)", recognizeModelId('claude zephyr 9').kind === 'unrecognised', 'change recognizeModelId in src/models/roads/idSpaces.ts so a spelling without the claude- mark is unrecognised')
  const spaced = await wm.validateWorkerModelChoice('claude zephyr 9', 'session')
  check('…and the door refuses it not-runnable:unrecognised, the honest class', !spaced.ok && spaced.reason === 'not-runnable:unrecognised', withHint(text(spaced), whereAdmission + ' to refuse a spelling no family claims as not-runnable:unrecognised'))
}

removeScratch(scratch)
console.log(failures === 0 ? '\n✅ prove-claude-door-capability — all checks pass' : `\n❌ prove-claude-door-capability — ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
