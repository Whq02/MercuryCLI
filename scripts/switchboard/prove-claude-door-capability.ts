#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const text = (v: unknown): string => JSON.stringify(v) ?? ''

const scratch = mkdtempSync(join(tmpdir(), 'claude-door-capability-'))
const home = join(scratch, 'home')
const work = join(scratch, 'work')
mkdirSync(home, { recursive: true })
mkdirSync(work, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  process.env[spelling] = home
}
for (const key of [
  'CLAUDE_CODE_OAUTH_TOKEN',
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

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const wm = await import('../../src/services/concourse/workerModels.ts')
const { declaredRouteOf } = await import('../../src/services/providers/routeLaw.ts')
const { getModelOptions } = await import('../../src/utils/model/modelOptions.ts')
const { getMainLoopModel } = await import('../../src/utils/model/model.ts')
const { refreshSignInReads } = await import('../../src/daemon/signInView.ts')

section(`§1 the session and crew doors: '${UNKNOWN_CLAUDE_ID}' (no catalogue knows it) dispatches on capability`)
{
  check('the id is inside the first-party space (the claude- mark routes it to the Anthropic lane)', declaredRouteOf(UNKNOWN_CLAUDE_ID) === 'anthropic', String(declaredRouteOf(UNKNOWN_CLAUDE_ID)))
  check('no catalogue row lists it', !getModelOptions().some(o => o.value === UNKNOWN_CLAUDE_ID))
  const session = await wm.validateWorkerModelChoice(UNKNOWN_CLAUDE_ID, 'session')
  check('the SESSION door admits it — dispatched to the Anthropic lane, the wire decides', session.ok && session.entry.modelId === UNKNOWN_CLAUDE_ID && session.entry.session.availability === 'available', text(session))
  check('…with the ratified effort convention on the row', session.ok && session.entry.effort === 'high', text(session))
  const crew = await wm.validateWorkerModelChoice(UNKNOWN_CLAUDE_ID, 'crew')
  check('the CREW door admits it the same way (no door refuses what the account can run)', crew.ok && crew.entry.modelId === UNKNOWN_CLAUDE_ID, text(crew))
  const { resolveCrewSeatModel } = await import('../../src/daemon/crewSpawn.ts')
  const seat = await resolveCrewSeatModel(UNKNOWN_CLAUDE_ID)
  check("the crew seat resolver (the crew spawn's one door) seats it", seat.ok && seat.model === UNKNOWN_CLAUDE_ID, text(seat))
  const { preflightConcourseDispatch } = await import('../../src/daemon/concourseDispatch.ts')
  const preflight = await preflightConcourseDispatch({ workspaceDir: work, modelKey: UNKNOWN_CLAUDE_ID })
  check("the birth door's preflight (the boot face's New Session road) is CLEAN on it", preflight.ok === true, text(preflight))
  const twin = await wm.validateWorkerModelChoice(`${UNKNOWN_CLAUDE_ID}[1m]`, 'session')
  check('the [1m] rider folds and the bare id dispatches', twin.ok && twin.entry.modelId === UNKNOWN_CLAUDE_ID, text(twin))
}

section('§2 the honest refusals stay: a family-less stranger, and a keyless family')
{
  const stranger = await wm.validateWorkerModelChoice(STRANGER, 'session')
  check(`'${STRANGER}' (no family declares it) still refuses not-runnable:unrecognised`, !stranger.ok && stranger.reason === 'not-runnable:unrecognised' && /no provider family declares/.test(stranger.detail ?? ''), text(stranger))
  check("…and its action names the picker, never a family's door", !stranger.ok && /model picker/.test(stranger.action ?? ''), text(stranger))
  const spoken = await wm.validateWorkerModelChoice('sonnet 5', 'session')
  check("a spoken name still lands on its one row ('sonnet 5' → claude-sonnet-5)", spoken.ok && spoken.entry.modelId === 'claude-sonnet-5', text(spoken))
  const listed = await wm.validateWorkerModelChoice('claude-opus-5-5', 'session')
  check('a listed row keeps its display name (the catalogue still names what it knows)', listed.ok && listed.entry.displayName === 'Opus 5.5', text(listed))

  delete process.env.ANTHROPIC_API_KEY
  refreshSignInReads(true)
  const keyless = await wm.validateWorkerModelChoice(UNKNOWN_CLAUDE_ID, 'session')
  check("with no Anthropic credential the id refuses no-credential:anthropic — the family's door, never 'unknown-model'", !keyless.ok && keyless.reason === 'no-credential:anthropic', text(keyless))
  check('…with the /logins anthropic action riding the refusal', !keyless.ok && /\/logins anthropic/.test(keyless.action ?? ''), text(keyless))
  process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
  refreshSignInReads(true)

  const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ engine: { roster: ['claude-opus-5-5'] } }, null, 2))
  resetSettingsCache()
  const forbidden = await wm.validateWorkerModelChoice(UNKNOWN_CLAUDE_ID, 'session')
  check("an organization's engine.roster still binds the door (the REPL refuses on it before any call)", !forbidden.ok && forbidden.reason === 'not-runnable:not-allowed' && /engine\.roster/.test(forbidden.detail ?? ''), text(forbidden))
  const forbiddenEngine = await wm.validateWorkerModelChoice('gpt-5.9-nova', 'session')
  check('…and binds an engine namespace id the same way', !forbiddenEngine.ok && forbiddenEngine.reason === 'not-runnable:not-allowed', text(forbiddenEngine))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({}, null, 2))
  resetSettingsCache()
}

section(`§3 the real case: '${REAL_ID}' saved after the daemon booted, judged by a bundle whose catalogue predates the row`)
{
  const primed = getMainLoopModel()
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ engine: { model: REAL_ID } }, null, 2))
  check("the saved setting names the row while this process's settings read still holds its boot-time value (the daemon's read)", getMainLoopModel() === primed && primed !== REAL_ID, `${primed} → ${getMainLoopModel()}`)
  const { parseUserSpecifiedModel } = await import('../../src/utils/model/model.ts')
  const canonical = (value: string): string => parseUserSpecifiedModel(value).replace(/\[1m]$/, '')
  const preRow = () => getModelOptions().filter(o => canonical(o.value) !== REAL_ID)
  check('the pre-row catalogue read lists no Sonnet 5.5 row', !preRow().some(o => canonical(o.value) === REAL_ID))
  const registry = await wm.composeWorkerModelRegistry({ modelOptions: preRow })
  check("the registry composes from the injected read — a bundle whose catalogue predates the row (a build without the read judges by its own catalogue alone)", !registry.entries.some(e => e.modelId === REAL_ID), text(registry.entries.map(e => e.modelId)))
  const born = await wm.validateWorkerModelChoice(REAL_ID, 'session', { modelOptions: preRow })
  check(`the boot face's new session on '${REAL_ID}' resolves under that read — dispatched to the Anthropic lane, never "'${REAL_ID}' is not an exact model id"`, born.ok && born.entry.modelId === REAL_ID && born.entry.session.availability === 'available', text(born))
}

const FUTURE_IDS = [UNKNOWN_CLAUDE_ID, 'claude-sonnet-7-3']

section('§4 the guarantee — a future Claude id starts from EVERY door, the wire deciding')
{
  process.env.MERCURY_WORKFLOW_ROUTING = '1'
  const { resolveCrewSeatModel } = await import('../../src/daemon/crewSpawn.ts')
  const { preflightConcourseDispatch } = await import('../../src/daemon/concourseDispatch.ts')
  const { resolveWorkflowRoutedModel } = await import('../../src/tools/WorkflowTool/workflowRouting.ts')
  const { setSubModel, resolveSubModel } = await import('../../src/utils/model/subModelSlots.ts')
  const { resolveAdvisorModel } = await import('../../src/services/advisor/advisorSettings.ts')
  const { validateCoordinatorModelChoice } = await import('../../src/services/concourse/coordinatorModels.ts')
  const { validateModel } = await import('../../src/utils/model/validateModel.ts')
  const { homeLaneAdmissionRefusal } = await import('../../src/services/providers/homeLaneAdmission.ts')
  const { canonicalWireModelId } = await import('../../src/services/providers/routeLaw.ts')
  const { recognizeModelId } = await import('../../src/services/providers/idSpaces.ts')
  const { parseUserSpecifiedModel } = await import('../../src/utils/model/model.ts')
  const { isModelAllowed } = await import('../../src/utils/model/modelAllowlist.ts')
  for (const id of FUTURE_IDS) {
    console.log(`  · ${id}`)
    check(`identity: the id passes through the setting parser byte-identical, is first-party by the claude- mark, admitted by the home lane, allowed, and rides the wire as itself`, parseUserSpecifiedModel(id) === id && recognizeModelId(id).kind === 'first-party' && homeLaneAdmissionRefusal(id) === null && isModelAllowed(id) && canonicalWireModelId(id).ok, id)
    const admission = await wm.validateWorkerModelChoice(id, 'session')
    check("door · the daemon's session admission (the boot face's New Session, /clear, --model and a saved setting all reach it through bornSession)", admission.ok && admission.entry.modelId === id, text(admission))
    const preflight = await preflightConcourseDispatch({ workspaceDir: work, modelKey: id })
    check("door · the birth door's preflight", preflight.ok === true, text(preflight))
    const seat = await resolveCrewSeatModel(id)
    check('door · the crew and crewmate seats', seat.ok && seat.model === id, text(seat))
    const crewArm = await wm.validateWorkerModelChoice(id, 'crew')
    check("door · the crew arm of the one validator", crewArm.ok && crewArm.entry.modelId === id, text(crewArm))
    check('door · the workflow seats: an explicit model stands (routing never substitutes it)', resolveWorkflowRoutedModel({ tier: 'executor', model: id }) === undefined)
    const picked = setSubModel('advisor', id)
    const advisor = resolveAdvisorModel()
    check("door · the advisor pick (/submodels) and AskAdvisor's model", picked.ok && advisor.origin === 'saved' && advisor.model === id && advisor.route === 'anthropic', `${text(picked)} ${text(advisor)}`)
    setSubModel('advisor', null)
    const console_ = setSubModel('console', id)
    check('door · the console pick', console_.ok, text(console_))
    setSubModel('console', null)
    const coordinator = await validateCoordinatorModelChoice(id)
    check("door · the coordinator's assist model, selectable under its family's label", coordinator.ok && coordinator.entry.modelId === id && coordinator.entry.source === 'anthropic' && coordinator.entry.availability === 'ready', text(coordinator))
  }
  check("door · the REPL's /model <id>: the validator's home-lane road admits the id and hands it to the wire (no catalogue read between)", typeof validateModel === 'function' && (() => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const src = readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'model', 'validateModel.ts'), 'utf8')
    const admission = src.indexOf('homeLaneAdmissionRefusal(trimmed)')
    const probe = src.indexOf('queryModelWithoutStreaming(')
    return admission !== -1 && probe !== -1 && admission < probe && !src.includes('is not an exact model id')
  })())
  delete process.env.MERCURY_WORKFLOW_ROUTING

  check('the shape guards stay: a bare vendor slug is carrier-shaped junk for the home lane', !canonicalWireModelId('anthropic/claude-zephyr-9-1').ok)
  check("the shape guards stay: a spelling without the claude- mark is no family's ('claude zephyr 9' → unrecognised)", recognizeModelId('claude zephyr 9').kind === 'unrecognised')
  const spaced = await wm.validateWorkerModelChoice('claude zephyr 9', 'session')
  check('…and the door refuses it not-runnable:unrecognised, the honest class', !spaced.ok && spaced.reason === 'not-runnable:unrecognised', text(spaced))
}

section('§5 the road census — every door reaches a capability owner; a new judge must be declared here')
{
  const { readFileSync } = await import('node:fs')
  const { join: j } = await import('node:path')
  const { execFileSync } = await import('node:child_process')
  const ROOT = j(import.meta.dir, '..', '..')
  const read = (rel: string): string => readFileSync(j(ROOT, rel), 'utf8')
  const doors: Array<[string, string, string]> = [
    ['src/components/BootSplashScreen.tsx', "the boot face's New Session", 'bornSession'],
    ['src/services/switchboard/hopIntoSession.ts', '/clear', 'bornSession('],
    ['src/screens/REPL.tsx', "the screen's own birth", 'bornSession('],
    ['src/services/switchboard/bornSession.ts', 'the birth door reaches the daemon admission', "op: 'sessionAdmit'"],
    ['src/daemon/concourseSupervisor.ts', 'the daemon admission', 'validateWorkerModelChoice('],
    ['src/daemon/concourseDispatch.ts', 'the birth preflight', 'validateWorkerModelChoice('],
    ['src/daemon/crewSpawn.ts', 'the crew seat', 'validateWorkerModelChoice('],
    ['src/daemon/controlServer.ts', 'the seat reconfigure', 'validateWorkerModelChoice('],
    ['src/daemon/sessionSeat.ts', 'the switch on a gone runner', 'validateWorkerModelChoice('],
    ['src/commands/model/model.tsx', "the REPL's /model <id>", 'validateModel('],
    ['src/services/advisor/advisorSettings.ts', "the advisor's model", "resolveSubModel("],
    ['src/tools/WorkflowTool/workflowRouting.ts', 'the workflow seat', 'neutralSeatDefault'],
  ]
  for (const [file, door, owner] of doors) {
    check(`${door} (${file}) reaches ${owner}`, read(file).includes(owner))
  }
  const owners: Array<[string, string]> = [
    ['src/services/concourse/workerModels.ts', 'validateWorkerModelChoice'],
    ['src/services/concourse/coordinatorModels.ts', 'validateCoordinatorModelChoice'],
    ['src/utils/model/subModelSlots.ts', 'setSubModel'],
  ]
  for (const [file, fn] of owners) {
    const src = read(file)
    check(`${fn} (${file}) carries the capability clause (declaredRouteOf) and no exact-id membership refusal`, src.includes('declaredRouteOf(') && !src.includes('is not an exact model id'))
  }
  const composers = execFileSync('grep', ['-rl', '-e', 'composeWorkerModelRegistry(', '-e', 'composeSubModelRegistry(', '-e', 'composeCoordinatorModelRegistry(', 'src'], { cwd: ROOT })
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .sort()
  const declared = [
    'src/components/SubModelPicker.tsx',
    'src/components/concourse/CoordinatorModelPicker.tsx',
    'src/services/concourse/concourseSnapshot.ts',
    'src/services/concourse/coordinatorModels.ts',
    'src/services/concourse/workerModels.ts',
    'src/utils/model/subModelSlots.ts',
  ]
  check('every file that composes a model registry is declared here (the pickers and the snapshot paint rows; the three owners judge) — a new judge joins this list and takes the clause', JSON.stringify(composers) === JSON.stringify(declared), composers.join(' · '))
  const docs = read('docs/ENGINES.md').replace(/\s+/g, ' ')
  check('the docs say a new Anthropic model runs before a catalogue row lands, and what a row adds', /runs before its catalogue row lands/.test(docs) && /A catalogue row adds/.test(docs) && /display name/.test(docs) && /price tier/.test(docs) && /1M twin/.test(docs) && /wire laws/.test(docs))
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ prove-claude-door-capability — all checks pass' : `\n❌ prove-claude-door-capability — ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
