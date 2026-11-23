#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

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

const defaults = await import('../../src/crew/agents/agentDefaults.js')
const config = await import('../../src/platform/settings/config.js')
const effort = await import('../../src/models/effort/effort.js')
const runner = await import('../../src/tools/crewmate/runCrewmate.js')
const capabilities = await import('../../src/models/facts/capabilities.js')
const catalogue = await import('../../src/models/roads/openai/openaiCatalogue.js')
const store = await import('../../src/models/roads/openai/qualificationStore.js')
const localDiscovery = await import('../../src/models/roads/local/localDiscovery.js')
const localCatalogue = await import('../../src/models/roads/local/localCatalogue.js')
const wire = await import('../../src/models/roads/openaicompat/compatWire.js')
const doctrine = await import('../../src/tools/crewmate/subagentDoctrine.js')

{
  console.log('\n— §1 · the defaults record: conventions, the setting, tolerance —')
  const none = defaults.subagentDefaultsOf(undefined)
  check('no record ⇒ high, the parent\'s model, eight — each marked as the convention', none.effort === 'high' && none.effortSource === 'convention' && none.model === undefined && none.maxConcurrent === 8 && none.maxConcurrentSource === 'convention', 'In src/crew/agents/agentDefaults.ts fix subagentDefaultsOf (the convention values) or the SUBAGENT_DEFAULT_* constants')
  check('the conventions are the exported constants', defaults.SUBAGENT_DEFAULT_EFFORT === 'high' && defaults.SUBAGENT_DEFAULT_MAX_CONCURRENT === 8, 'change SUBAGENT_DEFAULT_EFFORT or SUBAGENT_DEFAULT_MAX_CONCURRENT in src/crew/agents/agentDefaults.ts')
  const set = defaults.subagentDefaultsOf({ defaultEffort: 'low', defaultModel: 'sonnet', maxConcurrent: 3 })
  check('a full record reads back as set', set.effort === 'low' && set.effortSource === 'setting' && set.model === 'sonnet' && set.maxConcurrent === 3 && set.maxConcurrentSource === 'setting', 'In src/crew/agents/agentDefaults.ts fix subagentDefaultsOf so a valid agents record reads back as source setting')
  const junk = defaults.subagentDefaultsOf({ defaultEffort: 'ultra' as never, defaultModel: '   ', maxConcurrent: 0 })
  check('a hand-edited file never breaks a spawn: a word off the ladder, a blank model and a cap of zero read as unset', junk.effort === 'high' && junk.effortSource === 'convention' && junk.model === undefined && junk.maxConcurrent === 8 && junk.maxConcurrentSource === 'convention', 'In src/crew/agents/agentDefaults.ts make subagentDefaultsOf treat an off-ladder effort, blank model and zero cap as unset')
  check('a fractional or negative cap reads as unset too', defaults.subagentDefaultsOf({ maxConcurrent: 2.5 }).maxConcurrent === 8 && defaults.subagentDefaultsOf({ maxConcurrent: -1 }).maxConcurrent === 8, 'In src/crew/agents/agentDefaults.ts make subagentDefaultsOf treat a fractional or negative maxConcurrent as unset')
  check('the key is on the global-config allowlist', (config.GLOBAL_CONFIG_KEYS as readonly string[]).includes('agents') && config.isGlobalConfigKey('agents'), 'add \'agents\' to GLOBAL_CONFIG_KEYS in src/platform/settings/config.ts')
  check('the live reader answers the convention on a fresh config home', defaults.subagentDefaultEffort() === 'high' && defaults.subagentDefaultModel() === undefined, 'In src/crew/agents/agentDefaults.ts fix subagentDefaultEffort and subagentDefaultModel to answer the convention when the config has no agents record')
  config.saveGlobalConfig(current => ({ ...current, agents: { ...current.agents, defaultEffort: 'max' } }))
  check('a saved setting reaches the live reader without a restart', defaults.subagentDefaultEffort() === 'max' && defaults.subagentDefaults().effortSource === 'setting', 'In src/crew/agents/agentDefaults.ts make subagentDefaultEffort and subagentDefaults read the saved global config on each call')
  config.saveGlobalConfig(current => ({ ...current, agents: undefined }))
  check('…and clearing it restores the convention', defaults.subagentDefaultEffort() === 'high', 'In src/crew/agents/agentDefaults.ts make subagentDefaultEffort fall back to the convention when agents is cleared')
}

{
  console.log('\n— §2 · the runner\'s ladder: the pin · the definition · the configured default —')
  const { resolveAgentEffort, agentOwnEffortWord } = runner
  check('nothing named ⇒ the configured default', resolveAgentEffort({ effortOverride: undefined, useExactTools: false, definitionEffort: undefined, defaultEffort: 'high' }) === 'high', 'fix resolveAgentEffort in src/tools/crewmate/runCrewmate.ts so the configured default is the last rung')
  check("the definition's word outranks the default", resolveAgentEffort({ effortOverride: undefined, useExactTools: false, definitionEffort: 'low', defaultEffort: 'high' }) === 'low', 'fix resolveAgentEffort in src/tools/crewmate/runCrewmate.ts so definitionEffort outranks defaultEffort')
  check("the call's word outranks both", resolveAgentEffort({ effortOverride: 'xhigh', useExactTools: false, definitionEffort: 'low', defaultEffort: 'high' }) === 'xhigh', 'fix resolveAgentEffort in src/tools/crewmate/runCrewmate.ts so effortOverride outranks the definition and default')
  check('an exact-tools run ignores the pin', resolveAgentEffort({ effortOverride: 'xhigh', useExactTools: true, definitionEffort: 'low', defaultEffort: 'high' }) === 'low', 'fix resolveAgentEffort in src/tools/crewmate/runCrewmate.ts so useExactTools ignores effortOverride')
  check('a pin off the ladder yields to the next rung', resolveAgentEffort({ effortOverride: 'turbo', useExactTools: false, definitionEffort: undefined, defaultEffort: 'high' }) === 'high', 'fix resolveAgentEffort in src/tools/crewmate/runCrewmate.ts so an effortOverride off the ladder falls to the next rung')
  check('the own word is the pin else the definition, never the default', agentOwnEffortWord({ effortOverride: undefined, useExactTools: false, definitionEffort: undefined }) === undefined, 'fix agentOwnEffortWord in src/tools/crewmate/runCrewmate.ts so it never returns the default')
}


{
  console.log('\n— §4 · the default word resolves per row through the one owner (never an error) —')
  const { resolveAgentEffort } = runner
  const spawnWord = resolveAgentEffort({ effortOverride: undefined, useExactTools: undefined, definitionEffort: undefined, defaultEffort: defaults.subagentDefaultEffort() })
  check('the spawn word is high', spawnWord === 'high', 'In src/crew/agents/agentDefaults.ts subagentDefaultEffort should answer high on a fresh config home')
  const stamped = (model: string, word = spawnWord) => effort.resolveStampedEffortTruth(model, word, { agentId: 'spawn' })

  const anthropic = stamped('claude-opus-4-8')
  check('an Anthropic row runs high (the ladder word itself)', anthropic.wire === 'high' && anthropic.applied === 'high' && anthropic.label === 'high', JSON.stringify(anthropic) + ' — fix resolveStampedEffortTruth in src/models/effort/effort.ts for an Anthropic row given high')
  const legacy = stamped('claude-haiku-4-5-20251001')
  check('a first-party row with no effort control: no key, the one absence word, no error', legacy.wire === undefined && legacy.supportsEffort === false && legacy.label === effort.NO_EFFORT_CONTROL_LABEL, JSON.stringify(legacy) + ' — fix resolveStampedEffortTruth in src/models/effort/effort.ts so a row without effort control sends no key and reports NO_EFFORT_CONTROL_LABEL')

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
  check('an OpenAI row that lists high runs high', astra.wire === 'high' && astra.applied === 'high', JSON.stringify(astra) + ' — fix resolveStampedEffortTruth in src/models/effort/effort.ts for an OpenAI catalogue row that lists high')
  const deep = stamped('gpt-5.6-deep')
  check("an OpenAI row whose vocabulary starts above high runs its nearest served word (xhigh — the provider's equivalent) with the asked word on the record", deep.wire === 'xhigh' && deep.adjustedFrom === 'high', JSON.stringify(deep) + ' — fix resolveStampedEffortTruth in src/models/effort/effort.ts so a row starting above high runs its nearest served word and records adjustedFrom')
  store.recordWireEffortRefusal({ modelId: 'gpt-6-astra', sourceKind: 'api-key', refused: 'high', levels: ['none', 'minimal', 'low', 'medium'] })
  const taught = stamped('gpt-6-astra')
  check("the wire teaches: a row whose wire refused high runs the nearest word it serves (medium), remembered per row", taught.wire === 'medium' && taught.adjustedFrom === 'high', JSON.stringify(taught) + ' — fix resolveStampedEffortTruth in src/models/effort/effort.ts to use the refusal that recordWireEffortRefusal (src/models/roads/openai/qualificationStore.ts) stored for that row')
  store.noteWireEffortAccepted({ modelId: 'gpt-6-astra', sourceKind: 'api-key', word: 'high' })
  check('…and an accepted high clears the memory', stamped('gpt-6-astra').wire === 'high', 'noteWireEffortAccepted in src/models/roads/openai/qualificationStore.ts should clear the stored refusal so high resolves again')
  const empty = stamped('gpt-5.6-void')
  check('an OpenAI row with no effort control: no key, no error', empty.wire === undefined && empty.supportsEffort === false, JSON.stringify(empty) + ' — fix resolveStampedEffortTruth in src/models/effort/effort.ts so a row with empty reasoning levels sends no key')
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
  await localDiscovery.refreshLocalDiscovery({ force: true, fetchImpl: ollamaFetch, env: { ...process.env, MERCURY_LOCAL_PROBE_TARGETS: 'ollama=http://fixture.invalid:11434' } as NodeJS.ProcessEnv })
  check('rig: the Ollama fixture was discovered', localCatalogue.localRecordFor('local/qwen3:8b')?.server === 'ollama' && localCatalogue.localRecordFor('local/llama3.2:latest') !== undefined, 'refreshLocalDiscovery in src/models/roads/local/localDiscovery.ts did not record the fixture Ollama models for localRecordFor')
  const localThinking = stamped('local/qwen3:8b')
  check('a local thinking model runs the default word where its server serves it (high, on the Ollama vocabulary)', localThinking.wire === 'high' && (wire.LOCAL_SERVER_EFFORTS.ollama as readonly string[]).includes('high'), JSON.stringify(localThinking) + ' — fix resolveStampedEffortTruth in src/models/effort/effort.ts or LOCAL_SERVER_EFFORTS in src/models/roads/openaicompat/compatWire.ts so a local thinking row runs high')
  config.saveGlobalConfig(current => ({ ...current, agents: { ...current.agents, defaultEffort: 'max' } }))
  const configured = resolveAgentEffort({ effortOverride: undefined, useExactTools: undefined, definitionEffort: undefined, defaultEffort: defaults.subagentDefaultEffort() })
  const localConfigured = stamped('local/qwen3:8b', configured)
  check("the configured word (max) rides a local row that serves it", configured === 'max' && localConfigured.wire === 'max', JSON.stringify(localConfigured) + ' — fix resolveStampedEffortTruth in src/models/effort/effort.ts so a local row that serves max carries the configured word')
  const localPlain = stamped('local/llama3.2:latest', configured)
  check('a local model with no effort control: no key, the one absence word, no error', localPlain.wire === undefined && localPlain.supportsEffort === false && localPlain.label === effort.NO_EFFORT_CONTROL_LABEL, JSON.stringify(localPlain) + ' — fix resolveStampedEffortTruth in src/models/effort/effort.ts so a local row without thinking sends no key and reports NO_EFFORT_CONTROL_LABEL')
  config.saveGlobalConfig(current => ({ ...current, agents: undefined }))
  localDiscovery.__resetLocalDiscoveryForTest()
  check('no row above answered with an error (the owner never throws on a spawn word)', capabilities.modelSupportsEffort('claude-opus-4-8'), 'modelSupportsEffort in src/models/facts/capabilities.ts should answer true for claude-opus-4-8')
}

{
  console.log('\n— §5 · a seat stamped max pins it on the lead alone —')
  process.env.MERCURY_EFFORT_LEVEL = 'max'
  const lead = effort.resolveEffortTruth('claude-opus-4-8', 'max')
  check("the seat's own request carries the stamp (max)", lead.wire === 'max' && lead.requestedSource === 'env', JSON.stringify(lead) + ' — fix resolveEffortTruth in src/models/effort/effort.ts so MERCURY_EFFORT_LEVEL gives the lead requestedSource env')
  const word = runner.resolveAgentEffort({ effortOverride: undefined, useExactTools: undefined, definitionEffort: undefined, defaultEffort: defaults.subagentDefaultEffort() })
  effort.noteAgentEffortWord('crew-1', word)
  const crew = effort.resolveEffortTruth('claude-opus-4-8', word, { agentId: 'crew-1' })
  check("a sub-agent without a word of its own runs the configured default (high) under that stamp — the stamp is the seat's, never the crew's", crew.wire === 'high' && crew.requestedSource === 'agent', JSON.stringify(crew) + ' — fix resolveEffortTruth in src/models/effort/effort.ts so an agent with a noted word (noteAgentEffortWord) is not overridden by the env stamp')
  effort.forgetAgentEffortWord('crew-1')
  delete process.env.MERCURY_EFFORT_LEVEL
}

{
  console.log('\n— §6 · the cap: the env knob · the setting · eight —')
  check('no knob, no setting ⇒ eight by convention', JSON.stringify(defaults.subagentConcurrencyCap(null, undefined)) === JSON.stringify({ cap: 8, source: 'convention' }), 'fix subagentConcurrencyCap in src/crew/agents/agentDefaults.ts so the convention is eight')
  check('the setting ⇒ its number', JSON.stringify(defaults.subagentConcurrencyCap(null, { maxConcurrent: 3 })) === JSON.stringify({ cap: 3, source: 'setting' }), 'fix subagentConcurrencyCap in src/crew/agents/agentDefaults.ts so maxConcurrent gives source setting')
  check('the env knob outranks the setting', JSON.stringify(defaults.subagentConcurrencyCap(12, { maxConcurrent: 3 })) === JSON.stringify({ cap: 12, source: 'env' }), 'fix subagentConcurrencyCap in src/crew/agents/agentDefaults.ts so the env value outranks the setting')
  process.env.MERCURY_AGENT_FANOUT_CAP = '5'
  check('the env read is the doctrine module\'s (one owner of the knob) and the fold reads it', doctrine.agentFanoutCap() === 5 && defaults.subagentConcurrencyCap(doctrine.agentFanoutCap()).cap === 5, 'fix agentFanoutCap in src/tools/crewmate/subagentDoctrine.ts or its use in subagentConcurrencyCap')
  delete process.env.MERCURY_AGENT_FANOUT_CAP
  check('the knob unset ⇒ the live fold answers the setting or the convention', defaults.subagentConcurrencyCap(doctrine.agentFanoutCap()).source !== 'env', 'fix subagentConcurrencyCap in src/crew/agents/agentDefaults.ts and agentFanoutCap in src/tools/crewmate/subagentDoctrine.ts so an unset MERCURY_AGENT_FANOUT_CAP is not source env')
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
