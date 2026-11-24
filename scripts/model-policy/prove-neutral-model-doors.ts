#!/usr/bin/env bun
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'neutral-model-doors-'))
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = scratch
for (const key of ['MERCURY_MODEL', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'MERCURY_DEFAULT_HAIKU_MODEL', 'MERCURY_WORKER_PARENT_PID']) delete process.env[key]
delete process.env.NODE_ENV
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.MERCURY_CREW_DIR = join(scratch, 'crew')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const NEUTRAL_DOORS_FIX_HINT_BY_SECTION: Record<string, string> = {
  '1': 'change getAgentModel in src/models/catalogue/crewmateModel.ts',
  '2': 'change isModelAllowed in src/models/catalogue/modelAllowlist.ts, or the family words in src/models/catalogue/modelFamilies.ts and src/models/facts/aliases.ts',
  '3': 'remove the substitution or floor text it names: src/screen/cockpit/runtimePosture.ts, src/screen/cockpit-gauges/substrateSnapshot.ts, src/screen/concourse-model/workerModels.ts, src/models/facts/seatSlots.ts or src/models/roads/modelRegistry.ts',
  '4': 'change the Crewmate tool model field in src/tools/crewmate/CrewmateTool.tsx, AGENT_DISPATCH_MODELS in src/models/facts/aliases.ts, or unrecognisedModelWordRefusal in src/crew/crewmates/engineDispatch.ts',
  '5': 'change the model picker door in src/commands/model/mercuryModel.tsx, parseUserSpecifiedModel in src/models/catalogue/engineModel.ts, or subagentDefaultsOf in src/crew/agents/crewmateDefaults.ts',
}
let neutralDoorsFixHint = ''
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${[neutralDoorsFixHint, detail.slice(0, 300)].filter(part => part !== '').join(' — ')}`.replace(/ — $/, '') : ''}`)
}
function section(t: string): void {
  neutralDoorsFixHint = NEUTRAL_DOORS_FIX_HINT_BY_SECTION[t.charAt(1)] ?? ''
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' every model door feeds from the live list; nothing substitutes')
console.log('============================================================')

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { saveGlobalConfig } = await import('../../src/platform/config/globalConfig.ts')
const agent = await import('../../src/models/catalogue/crewmateModel.ts')
const model = await import('../../src/models/catalogue/engineModel.ts')

section('§1 the sub-agent resolver follows the parent whatever its provider and substitutes nothing')
{
  const haikuParent = 'claude-haiku-4-5-20251001'
  check('inherit from a parent on the small tier is that parent, exactly', agent.getCrewmateModel('inherit', haikuParent) === haikuParent, agent.getCrewmateModel('inherit', haikuParent))
  check("a definition that names 'haiku' runs the haiku default, not a stand-in", agent.getCrewmateModel('haiku', 'claude-opus-5') === model.getDefaultHaikuModel(), agent.getCrewmateModel('haiku', 'claude-opus-5'))
  check("a restored haiku id dispatches as itself", agent.getCrewmateModel('inherit', 'claude-opus-5', 'haiku') === model.getDefaultHaikuModel(), agent.getCrewmateModel('inherit', 'claude-opus-5', 'haiku'))
  const ownFamily: Array<[string, string]> = [
    ['gpt', 'gpt-5.6-sol'],
    ['openai', 'gpt-5.6-sol'],
    ['glm', 'glm-5.3'],
    ['zai', 'glm-5.3'],
    ['kimi', 'moonshot-v1-8k'],
    ['moonshot', 'kimi-k3'],
    ['deepseek', 'deepseek-v4-pro'],
    ['gemini', 'gemini-2.5-pro'],
    ['openrouter', 'openrouter/qwen/qwen3-coder'],
    ['huggingface', 'huggingface/org/model'],
    ['local', 'local/llama3'],
    ['compat', 'compat/qwen3'],
    ['openai-compat', 'compat/qwen3'],
    ['anthropic', 'claude-opus-5[1m]'],
    ['opus', 'claude-opus-5[1m]'],
    ['sonnet', 'claude-sonnet-5'],
  ]
  for (const [word, parent] of ownFamily) {
    check(`the family word '${word}' with a parent on that family inherits the parent's exact model (${parent})`, agent.getCrewmateModel(undefined, parent, word) === parent, agent.getCrewmateModel(undefined, parent, word))
    check(`  …and as the definition's own model too`, agent.getCrewmateModel(word, parent) === parent, agent.getCrewmateModel(word, parent))
  }
  check("a first-party family word with a parent on another family resolves to that family's default", agent.getCrewmateModel(undefined, 'gpt-5.6-sol', 'opus') === model.getDefaultOpusModel(), agent.getCrewmateModel(undefined, 'gpt-5.6-sol', 'opus'))
  check("an exact id of another family passes through unchanged", agent.getCrewmateModel(undefined, 'claude-opus-5', 'gemini-2.5-pro') === 'gemini-2.5-pro', agent.getCrewmateModel(undefined, 'claude-opus-5', 'gemini-2.5-pro'))
  check("an exact engine id in the definition passes through unchanged", agent.getCrewmateModel('openrouter/qwen/qwen3-coder', 'claude-opus-5') === 'openrouter/qwen/qwen3-coder')
  saveGlobalConfig(c => ({ ...c, agents: { defaultModel: 'gemini-2.5-pro' } }))
  check("the configured sub-agent default, an exact id of any family, is what a definition naming no model runs", agent.getCrewmateModel(undefined, 'claude-opus-5') === 'gemini-2.5-pro', agent.getCrewmateModel(undefined, 'claude-opus-5'))
  saveGlobalConfig(c => ({ ...c, agents: { defaultModel: 'gpt' } }))
  check("a configured family word naming the parent's family inherits the parent's exact model", agent.getCrewmateModel(undefined, 'gpt-5.6-sol') === 'gpt-5.6-sol', agent.getCrewmateModel(undefined, 'gpt-5.6-sol'))
  saveGlobalConfig(c => ({ ...c, agents: {} }))
  check("with no configured default, a definition naming no model inherits the parent", agent.getCrewmateModel(undefined, 'gpt-5.6-sol') === 'gpt-5.6-sol')
  check('no floor note rides the resolver any more', !('getAgentModelWithFloorNote' in agent))
}

section('§2 the model allowlist: a family word is any family the live list knows')
{
  const allow = await import('../../src/models/catalogue/modelAllowlist.ts')
  const { updateSettingsForSource } = await import('../../src/platform/settings/settings.ts')
  const { resetSettingsCache } = await import('../../src/platform/settings/settingsCache.ts')
  const settingsPath = join(scratch, 'settings.json')
  const withList = (list: string[] | null, fn: () => void): void => {
    writeFileSync(settingsPath, JSON.stringify(list === null ? {} : { engine: { roster: list } }))
    resetSettingsCache()
    fn()
  }
  withList(null, () => check('no list ⇒ everything allowed', allow.isModelAllowed('gemini-2.5-pro') && allow.isModelAllowed('claude-opus-5')))
  withList([], () => check('an empty list ⇒ nothing allowed', !allow.isModelAllowed('claude-opus-5')))
  const families: Array<[string, string, string]> = [
    ['anthropic', 'claude-opus-5', 'gpt-5.6-sol'],
    ['anthropic', 'opus', 'glm-5.3'],
    ['openai', 'gpt-5.6-sol', 'claude-opus-5'],
    ['gpt', 'gpt-5.6-sol', 'claude-opus-5'],
    ['zai', 'glm-5.3', 'gpt-5.6-sol'],
    ['glm', 'glm-5.3', 'gpt-5.6-sol'],
    ['moonshot', 'moonshot-v1-8k', 'glm-5.3'],
    ['kimi', 'moonshot-v1-8k', 'glm-5.3'],
    ['deepseek', 'deepseek-v4-pro', 'gpt-5.6-sol'],
    ['gemini', 'gemini-2.5-pro', 'gpt-5.6-sol'],
    ['openrouter', 'openrouter/qwen/qwen3-coder', 'gpt-5.6-sol'],
    ['huggingface', 'huggingface/org/model', 'gpt-5.6-sol'],
    ['local', 'local/llama3', 'gpt-5.6-sol'],
    ['compat', 'compat/qwen3', 'gpt-5.6-sol'],
    ['openai-compat', 'compat/qwen3', 'gpt-5.6-sol'],
  ]
  for (const [word, inside, outside] of families) {
    withList([word], () => {
      check(`['${word}'] admits ${inside}`, allow.isModelAllowed(inside))
      check(`['${word}'] refuses ${outside}`, !allow.isModelAllowed(outside))
    })
  }
  withList(['sonnet'], () => {
    check("['sonnet'] admits claude-sonnet-5 and refuses claude-opus-5 (the first-party sub-family words stay)", allow.isModelAllowed('claude-sonnet-5') && !allow.isModelAllowed('claude-opus-5'))
  })
  withList(['openai', 'gpt-5.5'], () => {
    check('a more specific entry narrows its family word (gpt-5.5 admitted, gpt-5.6-sol refused)', allow.isModelAllowed('gpt-5.5') && !allow.isModelAllowed('gpt-5.6-sol'))
  })
  withList(['anthropic', 'claude-sonnet-5'], () => {
    check('a more specific first-party entry narrows the anthropic word', allow.isModelAllowed('claude-sonnet-5') && !allow.isModelAllowed('claude-opus-5'))
  })
  withList(null, () => {})
  let words: readonly string[] = []
  try {
    const fam = await import('../../src/models/catalogue/modelFamilies.ts')
    words = fam.modelFamilyWords()
    check('the family words carry every route the id-space table declares, and anthropic', ['anthropic', 'openai', 'zai', 'moonshot', 'deepseek', 'xai', 'meta', 'gemini', 'openrouter', 'huggingface', 'local', 'openai-compat'].every(w => words.includes(w)), words.join(' · '))
    check("the family words carry every family's class alias", ['gpt', 'glm', 'kimi', 'deepseek', 'grok', 'muse', 'gemini', 'compat'].every(w => words.includes(w)), words.join(' · '))
    check('the family words carry the first-party sub-families', ['opus', 'sonnet', 'haiku', 'fable'].every(w => words.includes(w)), words.join(' · '))
    check('a model id is never a family word', !fam.isModelFamilyWord('gpt-5.6-sol') && !fam.isModelFamilyWord('claude-opus-5'))
  } catch (e) {
    check('the family vocabulary module exists', false, String(e))
  }
  const aliases = await import('../../src/models/facts/aliases.ts')
  check('the hand list of three first-party family aliases is gone from the alias module', !('MODEL_FAMILY_ALIASES' in aliases) && !('isModelFamilyAlias' in aliases))
}

section('§3 the floor is gone: no substitution anywhere, no telemetry of one, no document naming one')
{
  const posture = await import('../../src/screen/cockpit/runtimePosture.ts')
  const { setAskChannel } = await import('../../src/boot/process-state/processState.ts')
  posture.resetRuntimePostureForTest()
  setAskChannel('none')
  posture.markSessionNonInteractive('default')
  const section = posture.getRuntimePostureSection() ?? ''
  check('the runtime posture block (the headless one, which still speaks) states no agent-model floor', section.length > 0 && !/floor/i.test(section) && !/Haiku/.test(section), section.split('\n').filter(l => /floor|Haiku/i.test(l)).join(' | '))
  const doctrine = posture.getRuntimePostureDoctrineLine() ?? ''
  check('the doctrine line states no floored spawn', doctrine.length > 0 && !/floor/i.test(doctrine) && !/Haiku/.test(doctrine), doctrine)
  posture.resetRuntimePostureForTest()
  setAskChannel('operator')
  const { substrateSnapshot } = await import('../../src/screen/cockpit-gauges/substrateSnapshot.ts')
  const rows = substrateSnapshot().data.sections.flatMap(s => s.rows)
  check('the substrate panel carries no floor row', rows.length > 0 && rows.every(r => !/floor/i.test(r.name) && !/Haiku/.test(r.hint)), rows.filter(r => /floor|Haiku/i.test(`${r.name} ${r.hint}`)).map(r => r.name).join(', '))
  const ledger = await import('../../src/models/sign-in/account-ledger/signInLedger.ts')
  ledger.recordSignIn('anthropic', 'api-key')
  ;(await import('../../src/models/catalogue/computedDefault.ts')).resetComputedDefaultMemo()
  const wm = await import('../../src/screen/concourse-model/workerModels.ts')
  const seat = await wm.validateWorkerModelChoice('claude-haiku-4-5-20251001', 'session')
  check('a session worker runs the small tier when the account runs it', seat.ok === true, JSON.stringify(seat))
  const seats = await import('../../src/models/facts/seatSlots.ts')
  check('the seat family allowlist and its substituting validator are gone', !('SEAT_ALLOWED_FAMILIES' in seats) && !('validateSeatModel' in seats))
  const kernel = await import('../../src/models/roads/modelRegistry.ts')
  const snapshot = kernel.buildProviderSnapshot()
  check("the kernel's exact pin resolves the sonnet family word as the sonnet class", snapshot.resolveExact('sonnet')?.modelClass === 'sonnet')
  check("the kernel's exact pin refuses an id no available provider lists (typed null, never a substitute)", snapshot.resolveExact('gpt-5.6-sol') === null)
}

section('§4 the Crewmate tool: haiku is a dispatch word like any other, and the words name no provider as the exact case')
{
  const aliases = await import('../../src/models/facts/aliases.ts')
  check("AGENT_DISPATCH_MODELS carries 'haiku'", (aliases.CREWMATE_DISPATCH_MODELS as readonly string[]).includes('haiku'))
  const { CrewmateTool } = await import('../../src/tools/crewmate/CrewmateTool.tsx')
  const schema = CrewmateTool.inputSchema as { safeParse: (v: unknown) => { success: boolean }; shape: { model: { description?: string } } }
  check("the Crewmate tool schema accepts model 'haiku'", schema.safeParse({ description: 'test', prompt: 'test', model: 'haiku' }).success === true)
  const description = schema.shape.model.description ?? ''
  const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
  const { getAllBaseTools } = await import('../../src/tools/kit/toolList.ts')
  const permissionContext = getEmptyToolPermissionContext()
  const manual = await CrewmateTool.prompt({ getToolPermissionContext: async () => permissionContext, tools: [...getAllBaseTools()], agents: [] })
  const MODEL_SECTION = '\n## Model selection\n'
  const modelWords = manual.includes(MODEL_SECTION) ? manual.slice(manual.indexOf(MODEL_SECTION) + MODEL_SECTION.length).split('\n## ')[0]! : ''
  check('the model field names no provider as the exact-id case, and the manual has no model section of its own', description.length > 0 && !/Anthropic/.test(description) && modelWords.length === 0, description.slice(0, 200))
  check("the model field says an exact id or a family word, and where to read the ids", /Exact model id or family word/.test(description) && /mercury:\/\/models/.test(description), description.slice(0, 200))
  check('the schema admits an exact gemini or openrouter id (the dispatch grammar validates it)', schema.safeParse({ description: 'test', prompt: 'test', model: 'gemini-2.5-pro' }).success === true && schema.safeParse({ description: 'test', prompt: 'test', model: 'openrouter/qwen/qwen3-coder' }).success === true)
  check('neither the schema text nor the manual enumerates a per-boot id list', !description.includes('gpt-5.6-sol') && !description.includes('glm-5.2') && !modelWords.includes('gpt-5.6-sol') && !modelWords.includes('glm-5.2'))
  const { unrecognisedModelWordRefusal } = await import('../../src/crew/crewmates/engineDispatch.ts')
  check("the dispatch grammar refuses a word no family declares, naming it", (unrecognisedModelWordRefusal('banana') ?? '').includes("'banana'") && unrecognisedModelWordRefusal('haiku') === null && unrecognisedModelWordRefusal('gemini-2.5-pro') === null)
}

section('§5 the doors store exact ids; the words come from a lookup of the id')
{
  const picker = await import('../../src/commands/model/mercuryModel.tsx')
  const fable = model.parseUserSpecifiedModel('fable')
  check("a first-party family word resolves to its exact id at write time", /^claude-/.test(fable) && fable !== 'fable', fable)
  check("the row's words come from a lookup of the exact id", picker.modelChoiceLabel(fable) === model.renderModelName(fable), picker.modelChoiceLabel(fable))
  check("the stored exact id is the picker's own row for the current mark, and an already-saved family word maps to that same row", picker.modelChoiceRow(fable) === fable && picker.modelChoiceRow('fable') === fable, `${picker.modelChoiceRow(fable)} · ${picker.modelChoiceRow('fable')}`)
  check('an exact id of another family keeps its own row and words', picker.modelChoiceRow('gemini-2.5-pro') === 'gemini-2.5-pro' && picker.modelChoiceLabel('gemini-2.5-pro').length > 0)
  const familyHeads: Array<[string, string]> = [['deepseek', 'deepseek-v4-pro'], ['kimi', 'kimi-k3'], ['glm', 'glm-5.3']]
  for (const [word, head] of familyHeads) {
    check(`the bare family word '${word}' resolves to its family's first recorded row (${head}) at write time, the way 'grok' resolves to xAI's newest row`, model.parseUserSpecifiedModel(word) === head, model.parseUserSpecifiedModel(word))
    check(`  …and the picker door maps the word onto that row`, picker.modelChoiceRow(word) === head && picker.modelChoiceLabel(word) === picker.modelChoiceLabel(head), `${picker.modelChoiceRow(word)} · ${picker.modelChoiceLabel(word)}`)
  }
  const { crewmateDefaultsOf } = await import('../../src/crew/agents/crewmateDefaults.ts')
  check("the sub-agent default reader takes the choice word 'inherit' as unset", crewmateDefaultsOf({ defaultModel: 'inherit' }).model === undefined && crewmateDefaultsOf({ defaultModel: fable }).model === fable)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`}`)
process.exit(failures === 0 ? 0 : 1)
