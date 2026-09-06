#!/usr/bin/env bun
//       global-config allowlist;
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

console.log('============================================================')
console.log(' the sub-agent default effort (a spawn without the field)')
console.log('============================================================')

const savedEnv: Record<string, string | undefined> = {}
for (const key of ['OPENAI_API_KEY', 'MERCURY_CONFIG_DIR', 'MERCURY_AUTH_SCOPE_DIR', 'MERCURY_EFFORT_LEVEL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_AGENT_FANOUT_CAP']) {
  savedEnv[key] = process.env[key]
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-subagent-effort-'))
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:9'

const defaults = await import('../../src/utils/agentDefaults.js')
const config = await import('../../src/utils/config.js')
const effort = await import('../../src/utils/effort.js')
const runner = await import('../../src/tools/AgentTool/runAgent.js')
const capabilities = await import('../../src/utils/model/capabilities.js')
const catalogue = await import('../../src/services/providers/openai/openaiCatalogue.js')
const store = await import('../../src/services/providers/openai/qualificationStore.js')
const localDiscovery = await import('../../src/services/providers/local/localDiscovery.js')
const localCatalogue = await import('../../src/services/providers/local/localCatalogue.js')
const wire = await import('../../src/services/providers/openaicompat/compatWire.js')
const doctrine = await import('../../src/constants/subagentDoctrine.js')

{
  console.log('\n— §1 · the defaults record: conventions, the setting, tolerance —')
  const none = defaults.subagentDefaultsOf(undefined)
  check('no record ⇒ high, the parent\'s model, eight — each marked as the convention', none.effort === 'high' && none.effortSource === 'convention' && none.model === undefined && none.maxConcurrent === 8 && none.maxConcurrentSource === 'convention')
  check('the conventions are the exported constants', defaults.SUBAGENT_DEFAULT_EFFORT === 'high' && defaults.SUBAGENT_DEFAULT_MAX_CONCURRENT === 8)
  const set = defaults.subagentDefaultsOf({ defaultEffort: 'low', defaultModel: 'sonnet', maxConcurrent: 3 })
  check('a full record reads back as set', set.effort === 'low' && set.effortSource === 'setting' && set.model === 'sonnet' && set.maxConcurrent === 3 && set.maxConcurrentSource === 'setting')
  const junk = defaults.subagentDefaultsOf({ defaultEffort: 'ultra' as never, defaultModel: '   ', maxConcurrent: 0 })
  check('a hand-edited file never breaks a spawn: a word off the ladder, a blank model and a cap of zero read as unset', junk.effort === 'high' && junk.effortSource === 'convention' && junk.model === undefined && junk.maxConcurrent === 8 && junk.maxConcurrentSource === 'convention')
  check('a fractional or negative cap reads as unset too', defaults.subagentDefaultsOf({ maxConcurrent: 2.5 }).maxConcurrent === 8 && defaults.subagentDefaultsOf({ maxConcurrent: -1 }).maxConcurrent === 8)
  check('the key is on the global-config allowlist', (config.GLOBAL_CONFIG_KEYS as readonly string[]).includes('agents') && config.isGlobalConfigKey('agents'))
  check('the live reader answers the convention on a fresh config home', defaults.subagentDefaultEffort() === 'high' && defaults.subagentDefaultModel() === undefined)
  config.saveGlobalConfig(current => ({ ...current, agents: { ...current.agents, defaultEffort: 'max' } }))
  check('a saved setting reaches the live reader without a restart', defaults.subagentDefaultEffort() === 'max' && defaults.subagentDefaults().effortSource === 'setting')
  config.saveGlobalConfig(current => ({ ...current, agents: undefined }))
  check('…and clearing it restores the convention', defaults.subagentDefaultEffort() === 'high')
}

{
  console.log('\n— §2 · the runner\'s ladder: the pin · the definition · the configured default —')
  const { resolveAgentEffort, agentOwnEffortWord } = runner
  check('nothing named ⇒ the configured default', resolveAgentEffort({ effortOverride: undefined, useExactTools: false, definitionEffort: undefined, defaultEffort: 'high' }) === 'high')
  check("the definition's word outranks the default", resolveAgentEffort({ effortOverride: undefined, useExactTools: false, definitionEffort: 'low', defaultEffort: 'high' }) === 'low')
  check("the call's word outranks both", resolveAgentEffort({ effortOverride: 'xhigh', useExactTools: false, definitionEffort: 'low', defaultEffort: 'high' }) === 'xhigh')
  check('an exact-tools run ignores the pin', resolveAgentEffort({ effortOverride: 'xhigh', useExactTools: true, definitionEffort: 'low', defaultEffort: 'high' }) === 'low')
  check('a pin off the ladder yields to the next rung', resolveAgentEffort({ effortOverride: 'turbo', useExactTools: false, definitionEffort: undefined, defaultEffort: 'high' }) === 'high')
  check('the own word is the pin else the definition, never the default', agentOwnEffortWord({ effortOverride: undefined, useExactTools: false, definitionEffort: undefined }) === undefined)
  const runAgent = src('src/tools/AgentTool/runAgent.ts')
  check('the runner reads the default through the one reader and never the session state', (runAgent.match(/defaultEffort: subagentDefaultEffort\(\)/g) ?? []).length === 2 && !/sessionEffort/.test(runAgent) && !/state\.effortValue/.test(runAgent))
  check('the runner notes the RESOLVED word for the effort owner', /noteAgentEffortWord\(agentId, resolvedEffort\)/.test(runAgent))
}

{
  console.log('\n— §3 · the Agent tool carries the field; the pin reaches the run —')
  const tool = src('src/tools/AgentTool/AgentTool.tsx')
  check('the input type carries an optional ladder word', /effort\?: EffortLevel/.test(tool))
  check('the schema enumerates the ladder from its one owner', /effort: z\s*\.enum\(EFFORT_LEVELS\)\s*\.optional\(\)/.test(tool))
  check("the field's text says a spawn without it rides the configured default, never the session's level", /Omitted, the configured sub-agent default applies \(high unless the operator changed it in \/config\) — never your own level/.test(tool))
  check("the call's word is the run's pin", /\.\.\.\(input\.effort !== undefined \? \{ effortOverride: input\.effort \} : \{\}\)/.test(tool))
  check('the harness note resolves the same ladder (the pin, the definition, the configured default)', /effortOverride: input\.effort,\s*useExactTools: undefined,\s*definitionEffort: agentDef\.effort,\s*defaultEffort: subagentDefaultEffort\(\),/.test(tool))
  check('the Agent tool\'s prompt tells the model what the field does', src('src/tools/AgentTool/prompt.ts').includes("parameter sets the agent's reasoning effort") && src('src/tools/AgentTool/prompt.ts').includes('never at your own level'))
  const hooks = src('src/tools/WorkflowTool/agentHooks.ts')
  check('a workflow\'s agent({effort}) validates against the ladder and rides as the pin', hooks.includes('!(EFFORT_LEVELS as readonly string[]).includes(opts.effort)') && hooks.includes("effortOverride: args.effort as RunAgentOpts['effortOverride']"))
  check('the workflow prompt says an omitted effort rides the configured default, never the session\'s', src('src/tools/WorkflowTool/workflowPrompt.ts').includes('Omitted, the configured sub-agent default applies (high unless the operator changed it in /config) — never the session\'s own level'))
}

{
  console.log('\n— §4 · the default word resolves per row through the one owner (never an error) —')
  const { resolveAgentEffort } = runner
  const spawnWord = resolveAgentEffort({ effortOverride: undefined, useExactTools: undefined, definitionEffort: undefined, defaultEffort: defaults.subagentDefaultEffort() })
  check('the spawn word is high', spawnWord === 'high')
  const stamped = (model: string, word = spawnWord) => effort.resolveStampedEffortTruth(model, word, { agentId: 'spawn' })

  const anthropic = stamped('claude-opus-4-8')
  check('an Anthropic row runs high (the ladder word itself)', anthropic.wire === 'high' && anthropic.applied === 'high' && anthropic.label === 'high', JSON.stringify(anthropic))
  const legacy = stamped('claude-haiku-4-5-20251001')
  check('a first-party row with no effort control: no key, the one absence word, no error', legacy.wire === undefined && legacy.supportsEffort === false && legacy.label === effort.NO_EFFORT_CONTROL_LABEL, JSON.stringify(legacy))

  process.env.OPENAI_API_KEY = 'prover-key'
  const fixtureFetch: typeof fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [
          { id: 'gpt-6-astra', display_name: 'GPT-6 Astra', visibility: 'list', priority: 1, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], default_reasoning_level: 'medium' },
          { id: 'gpt-5.6-deep', display_name: 'GPT-5.6 Deep', visibility: 'list', priority: 2, supported_reasoning_levels: ['xhigh', 'max'], default_reasoning_level: 'xhigh' },
          { id: 'gpt-5.6-void', display_name: 'GPT-5.6 Void', visibility: 'list', priority: 3, supported_reasoning_levels: [], default_reasoning_level: 'medium' },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch
  catalogue.__resetOpenaiCatalogueForTest()
  await catalogue.refreshOpenaiCatalogue('api-key', { force: true, fetchImpl: fixtureFetch })
  const astra = stamped('gpt-6-astra')
  check('an OpenAI row that lists high runs high', astra.wire === 'high' && astra.applied === 'high', JSON.stringify(astra))
  const deep = stamped('gpt-5.6-deep')
  check("an OpenAI row whose vocabulary starts above high runs its nearest served word (xhigh — the provider's equivalent) with the asked word on the record", deep.wire === 'xhigh' && deep.adjustedFrom === 'high', JSON.stringify(deep))
  store.recordWireEffortRefusal({ modelId: 'gpt-6-astra', sourceKind: 'api-key', refused: 'high', levels: ['none', 'minimal', 'low', 'medium'] })
  const taught = stamped('gpt-6-astra')
  check("the wire teaches: a row whose wire refused high runs the nearest word it serves (medium), remembered per row", taught.wire === 'medium' && taught.adjustedFrom === 'high', JSON.stringify(taught))
  store.noteWireEffortAccepted({ modelId: 'gpt-6-astra', sourceKind: 'api-key', word: 'high' })
  check('…and an accepted high clears the memory', stamped('gpt-6-astra').wire === 'high')
  const empty = stamped('gpt-5.6-void')
  check('an OpenAI row with no effort control: no key, no error', empty.wire === undefined && empty.supportsEffort === false, JSON.stringify(empty))
  catalogue.__resetOpenaiCatalogueForTest()
  delete process.env.OPENAI_API_KEY

  const OLLAMA_CAPS: Record<string, string[]> = {
    'qwen3:8b': ['completion', 'tools', 'thinking'],
    'llama3.2:latest': ['completion', 'tools'],
  }
  const jsonResponse = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  const ollamaFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.endsWith('/api/tags')) return jsonResponse({ models: Object.keys(OLLAMA_CAPS).map(model => ({ model, name: model })) })
    if (url.endsWith('/api/version')) return jsonResponse({ version: '0.fixture' })
    if (url.endsWith('/api/ps')) return jsonResponse({ models: [] })
    if (url.endsWith('/api/show')) {
      const model = String((JSON.parse(String(init?.body ?? '{}')) as { model?: string }).model ?? '')
      return jsonResponse({ capabilities: OLLAMA_CAPS[model] ?? [] })
    }
    return new Response('', { status: 404 })
  }) as unknown as typeof fetch
  localDiscovery.__resetLocalDiscoveryForTest()
  await localDiscovery.refreshLocalDiscovery({ force: true, fetchImpl: ollamaFetch, env: process.env })
  check('rig: the Ollama fixture was discovered', localCatalogue.localRecordFor('local/qwen3:8b')?.server === 'ollama' && localCatalogue.localRecordFor('local/llama3.2:latest') !== undefined)
  const localThinking = stamped('local/qwen3:8b')
  check('a local thinking model runs the default word where its server serves it (high, on the Ollama vocabulary)', localThinking.wire === 'high' && (wire.LOCAL_SERVER_EFFORTS.ollama as readonly string[]).includes('high'), JSON.stringify(localThinking))
  config.saveGlobalConfig(current => ({ ...current, agents: { ...current.agents, defaultEffort: 'max' } }))
  const configured = resolveAgentEffort({ effortOverride: undefined, useExactTools: undefined, definitionEffort: undefined, defaultEffort: defaults.subagentDefaultEffort() })
  const localConfigured = stamped('local/qwen3:8b', configured)
  check("the configured word (max) rides a local row that serves it", configured === 'max' && localConfigured.wire === 'max', JSON.stringify(localConfigured))
  const localPlain = stamped('local/llama3.2:latest', configured)
  check('a local model with no effort control: no key, the one absence word, no error', localPlain.wire === undefined && localPlain.supportsEffort === false && localPlain.label === effort.NO_EFFORT_CONTROL_LABEL, JSON.stringify(localPlain))
  config.saveGlobalConfig(current => ({ ...current, agents: undefined }))
  localDiscovery.__resetLocalDiscoveryForTest()
  check('no row above answered with an error (the owner never throws on a spawn word)', capabilities.modelSupportsEffort('claude-opus-4-8'))
}

{
  console.log('\n— §5 · a supercode seat pins max on the lead alone —')
  process.env.MERCURY_EFFORT_LEVEL = 'max'
  const lead = effort.resolveEffortTruth('claude-opus-4-8', 'max')
  check("the seat's own request carries the stamp (max)", lead.wire === 'max' && lead.requestedSource === 'env', JSON.stringify(lead))
  const word = runner.resolveAgentEffort({ effortOverride: undefined, useExactTools: undefined, definitionEffort: undefined, defaultEffort: defaults.subagentDefaultEffort() })
  effort.noteAgentEffortWord('crew-1', word)
  const crew = effort.resolveEffortTruth('claude-opus-4-8', word, { agentId: 'crew-1' })
  check("a sub-agent without a word of its own runs the configured default (high) under that stamp — the stamp is the seat's, never the crew's", crew.wire === 'high' && crew.requestedSource === 'agent', JSON.stringify(crew))
  effort.forgetAgentEffortWord('crew-1')
  delete process.env.MERCURY_EFFORT_LEVEL
}

{
  console.log('\n— §6 · the cap: the env knob · the setting · eight —')
  check('no knob, no setting ⇒ eight by convention', JSON.stringify(defaults.subagentConcurrencyCap(null, undefined)) === JSON.stringify({ cap: 8, source: 'convention' }))
  check('the setting ⇒ its number', JSON.stringify(defaults.subagentConcurrencyCap(null, { maxConcurrent: 3 })) === JSON.stringify({ cap: 3, source: 'setting' }))
  check('the env knob outranks the setting', JSON.stringify(defaults.subagentConcurrencyCap(12, { maxConcurrent: 3 })) === JSON.stringify({ cap: 12, source: 'env' }))
  process.env.MERCURY_AGENT_FANOUT_CAP = '5'
  check('the env read is the doctrine module\'s (one owner of the knob) and the fold reads it', doctrine.agentFanoutCap() === 5 && defaults.subagentConcurrencyCap(doctrine.agentFanoutCap()).cap === 5)
  delete process.env.MERCURY_AGENT_FANOUT_CAP
  check('the knob unset ⇒ the live fold answers the setting or the convention', defaults.subagentConcurrencyCap(doctrine.agentFanoutCap()).source !== 'env')
  const tool = src('src/tools/AgentTool/AgentTool.tsx')
  check('the Agent tool refuses past the folded cap and names the door', /const fanout = subagentConcurrencyCap\(agentFanoutCap\(\)\)/.test(tool) && /if \(runningAgents >= fanout\.cap\)/.test(tool) && tool.includes("fanout.source === 'env' ? 'MERCURY_AGENT_FANOUT_CAP' : 'Sub-agents at once in /config'"))
  const configScreen = src('src/components/Settings/Config.tsx')
  check('/config carries the three rows over the one record', /id: 'agentsDefaultEffort'/.test(configScreen) && /id: 'agentsDefaultModel'/.test(configScreen) && /id: 'agentsMaxConcurrent'/.test(configScreen) && /agents: \{ \.\.\.c\.agents, \.\.\.patch \}/.test(configScreen))
  check('the agent-model resolver takes the configured default model for a definition that names none, and an explicit inherit keeps the parent', /if \(agentModel === undefined\) \{\s*const configured = subagentDefaultModel\(\)/.test(src('src/utils/model/agent.ts')))
}

for (const [key, value] of Object.entries(savedEnv)) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('ALL SUB-AGENT EFFORT-DEFAULT PROOFS PASS')
else console.log(`${failures} SUB-AGENT EFFORT-DEFAULT PROOF(S) FAILED`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
