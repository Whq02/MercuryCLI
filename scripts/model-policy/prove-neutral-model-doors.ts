#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'neutral-model-doors-'))
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = scratch
for (const key of ['MERCURY_MODEL', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'MERCURY_DEFAULT_HAIKU_MODEL', 'MERCURY_SMALL_FAST_MODEL', 'MERCURY_WORKER_PARENT_PID']) delete process.env[key]
delete process.env.NODE_ENV
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.MERCURY_CREW_DIR = join(scratch, 'crew')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 300)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}
const src = (...p: string[]): string => readFileSync(join(ROOT, 'src', ...p), 'utf8')

console.log('============================================================')
console.log(' every model door feeds from the live list; nothing substitutes')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
const agent = await import('../../src/utils/model/agent.ts')
const model = await import('../../src/utils/model/model.ts')

section('§1 the sub-agent resolver follows the parent whatever its provider and substitutes nothing')
{
  const haikuParent = 'claude-haiku-4-5-20251001'
  check('inherit from a parent on the small tier is that parent, exactly', agent.getAgentModel('inherit', haikuParent) === haikuParent, agent.getAgentModel('inherit', haikuParent))
  check("a definition that names 'haiku' runs the haiku default, not a stand-in", agent.getAgentModel('haiku', 'claude-opus-5') === model.getDefaultHaikuModel(), agent.getAgentModel('haiku', 'claude-opus-5'))
  check("a restored haiku id dispatches as itself", agent.getAgentModel('inherit', 'claude-opus-5', 'haiku') === model.getDefaultHaikuModel(), agent.getAgentModel('inherit', 'claude-opus-5', 'haiku'))
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
    check(`the family word '${word}' with a parent on that family inherits the parent's exact model (${parent})`, agent.getAgentModel(undefined, parent, word) === parent, agent.getAgentModel(undefined, parent, word))
    check(`  …and as the definition's own model too`, agent.getAgentModel(word, parent) === parent, agent.getAgentModel(word, parent))
  }
  check("a first-party family word with a parent on another family resolves to that family's default", agent.getAgentModel(undefined, 'gpt-5.6-sol', 'opus') === model.getDefaultOpusModel(), agent.getAgentModel(undefined, 'gpt-5.6-sol', 'opus'))
  check("an exact id of another family passes through unchanged", agent.getAgentModel(undefined, 'claude-opus-5', 'gemini-2.5-pro') === 'gemini-2.5-pro', agent.getAgentModel(undefined, 'claude-opus-5', 'gemini-2.5-pro'))
  check("an exact engine id in the definition passes through unchanged", agent.getAgentModel('openrouter/qwen/qwen3-coder', 'claude-opus-5') === 'openrouter/qwen/qwen3-coder')
  saveGlobalConfig(c => ({ ...c, agents: { defaultModel: 'gemini-2.5-pro' } }))
  check("the configured sub-agent default, an exact id of any family, is what a definition naming no model runs", agent.getAgentModel(undefined, 'claude-opus-5') === 'gemini-2.5-pro', agent.getAgentModel(undefined, 'claude-opus-5'))
  saveGlobalConfig(c => ({ ...c, agents: { defaultModel: 'gpt' } }))
  check("a configured family word naming the parent's family inherits the parent's exact model", agent.getAgentModel(undefined, 'gpt-5.6-sol') === 'gpt-5.6-sol', agent.getAgentModel(undefined, 'gpt-5.6-sol'))
  saveGlobalConfig(c => ({ ...c, agents: {} }))
  check("with no configured default, a definition naming no model inherits the parent", agent.getAgentModel(undefined, 'gpt-5.6-sol') === 'gpt-5.6-sol')
  check('no floor note rides the resolver any more', !('getAgentModelWithFloorNote' in agent))
}

section('§2 the model allowlist: a family word is any family the live list knows')
{
  const allow = await import('../../src/utils/model/modelAllowlist.ts')
  const { updateSettingsForSource } = await import('../../src/utils/settings/settings.ts')
  const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
  const settingsPath = join(scratch, 'settings.json')
  const withList = (list: string[] | null, fn: () => void): void => {
    writeFileSync(settingsPath, JSON.stringify(list === null ? {} : { availableModels: list }))
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
    const fam = await import('../../src/utils/model/modelFamilies.ts')
    words = fam.modelFamilyWords()
    check('the family words carry every route the id-space table declares, and anthropic', ['anthropic', 'openai', 'zai', 'moonshot', 'deepseek', 'gemini', 'openrouter', 'huggingface', 'local', 'openai-compat'].every(w => words.includes(w)), words.join(' · '))
    check("the family words carry every family's class alias", ['gpt', 'glm', 'kimi', 'deepseek', 'gemini', 'compat'].every(w => words.includes(w)), words.join(' · '))
    check('the family words carry the first-party sub-families', ['opus', 'sonnet', 'haiku', 'fable'].every(w => words.includes(w)), words.join(' · '))
    check('a model id is never a family word', !fam.isModelFamilyWord('gpt-5.6-sol') && !fam.isModelFamilyWord('claude-opus-5'))
  } catch (e) {
    check('the family vocabulary module exists', false, String(e))
  }
  const aliases = await import('../../src/utils/model/aliases.ts')
  check('the hand list of three first-party family aliases is gone from the alias module', !('MODEL_FAMILY_ALIASES' in aliases) && !('isModelFamilyAlias' in aliases))
}

section('§3 the floor is gone: no substitution anywhere, no telemetry of one, no document naming one')
{
  check('modelFloor.ts no longer exists', !existsSync(join(ROOT, 'src', 'utils', 'model', 'modelFloor.ts')))
  const offenders: string[] = []
  for (const file of walk(join(ROOT, 'src'))) {
    const text = readFileSync(file, 'utf8')
    if (/modelFloor|enforceSubagentModelFloor|NEVER_HAIKU_FALLBACK|isHaikuTier|recentFloorEvents|flooredFrom/.test(text)) offenders.push(file.slice(ROOT.length + 1))
  }
  check('no source file names the floor, its fallback, its predicate, its ring or its note', offenders.length === 0, offenders.join(', '))
  const posture = await import('../../src/utils/cockpit/runtimePosture.ts')
  posture.resetRuntimePostureForTest()
  const section = posture.getRuntimePostureSection() ?? ''
  check('the runtime posture block states no agent-model floor', section.length > 0 && !/floor/i.test(section) && !/Haiku/.test(section), section.split('\n').filter(l => /floor|Haiku/i.test(l)).join(' | '))
  const doctrine = posture.getRuntimePostureDoctrineLine() ?? ''
  check('the doctrine line states no floored spawn', doctrine.length > 0 && !/floor/i.test(doctrine) && !/Haiku/.test(doctrine), doctrine)
  const { substrateSnapshot } = await import('../../src/utils/cockpit/substrateSnapshot.ts')
  const rows = substrateSnapshot().data.sections.flatMap(s => s.rows)
  check('the substrate panel carries no floor row', rows.length > 0 && rows.every(r => !/floor/i.test(r.name) && !/Haiku/.test(r.hint)), rows.filter(r => /floor|Haiku/i.test(`${r.name} ${r.hint}`)).map(r => r.name).join(', '))
  const flags = src('substrate', 'flagRegistry.ts')
  check('the worker-parent flag row names no floor', !/never-Haiku|worker-loop floor/.test(flags))
  const ledger = await import('../../src/utils/accounts/signInLedger.ts')
  ledger.recordSignIn('anthropic', 'api-key')
  ;(await import('../../src/utils/model/computedDefault.ts')).resetComputedDefaultMemo()
  const wm = await import('../../src/services/concourse/workerModels.ts')
  const crew = await wm.validateWorkerModelChoice('claude-haiku-4-5-20251001', 'crew')
  check('a crew seat runs the small tier when the account runs it (the crew arm carries the session verdict)', crew.ok === true, JSON.stringify(crew))
  const cs = await import('../../src/daemon/crewSpawn.ts')
  const seat = await cs.resolveCrewSeatModel('haiku')
  check("the crew seat resolver seats 'haiku' as the haiku row, refusing nothing for its tier", seat.ok === true && /haiku/.test(seat.ok ? seat.model : ''), JSON.stringify(seat))
  const seats = await import('../../src/utils/model/seatSlots.ts')
  const v = seats.validateSeatModel('claude-opus-5', 'claude-sonnet-5')
  check('the seat validator keeps its allowed-family road for the families it lists', v.model === 'claude-opus-5' && v.note === undefined)
  const teams = readFileSync(join(ROOT, 'docs', 'TEAMS.md'), 'utf8')
  const engines = readFileSync(join(ROOT, 'docs', 'ENGINES.md'), 'utf8')
  check('docs/TEAMS.md names no Haiku refusal', !/Haiku/.test(teams))
  check('docs/ENGINES.md names no frontier-only refusal', !/frontier-only/.test(engines) && !/economy-tier rows refuse/.test(engines))
}

section('§4 the Agent tool: haiku is a dispatch word like any other, and the words name no provider as the exact case')
{
  const aliases = await import('../../src/utils/model/aliases.ts')
  check("AGENT_DISPATCH_MODELS carries 'haiku'", (aliases.AGENT_DISPATCH_MODELS as readonly string[]).includes('haiku'))
  const { AgentTool } = await import('../../src/tools/AgentTool/AgentTool.tsx')
  const schema = AgentTool.inputSchema as { safeParse: (v: unknown) => { success: boolean }; shape: { model: { description?: string } } }
  check("the Agent tool schema accepts model 'haiku'", schema.safeParse({ description: 'test', prompt: 'test', model: 'haiku' }).success === true)
  const description = schema.shape.model.description ?? ''
  check('the model description names no provider as the exact-id case', description.length > 0 && !/Anthropic/.test(description), description.slice(0, 200))
  check("the model description says an exact id names its model exactly", /an exact id names its model exactly/.test(description), description.slice(0, 200))
  const config = src('components', 'Settings', 'Config.tsx')
  check('the /config sub-agent default row is a picker door, not an alias walk', !config.includes('AGENT_DISPATCH_MODELS') && /id: 'agentsDefaultModel',[\s\S]{0,400}kind: 'managed-enum'/.test(config))
  check("the /config teammate default row's door opens the same picker", /subMenu === 'teammate-model'[\s\S]{0,1200}MercuryModelChoicePicker/.test(config) && /subMenu === 'agent-model'[\s\S]{0,1200}MercuryModelChoicePicker/.test(config))
  check("the rows' warnings name no alias walk", !/walk the aliases/.test(config))
  check("each door's leading row is a choice, never painted as a model id", (config.match(/\bchoice: ["']/g) ?? []).length === 3)
  const picker = src('components', 'MercuryModelPicker.tsx')
  check('the picker prints a choice row\'s own sentence in the footer and never counts it as available', /focusedModel!\.choice !== undefined/.test(picker) && /m\.choice === undefined\)\.length\} AVAILABLE/.test(picker))
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`}`)
process.exit(failures === 0 ? 0 : 1)
