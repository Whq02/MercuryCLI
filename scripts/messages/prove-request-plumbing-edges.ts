import { strict as assert } from 'node:assert'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const root = resolve(process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url)))
const { enableConfigs } = await import(`${root}/src/platform/settings/config.ts`)
enableConfigs()
const { getExtraBodyParams, getAPIMetadata } = await import(`${root}/src/models/roads/anthropic/requestParams.ts`)
const { getMergedBetas, getModelBetas } = await import(`${root}/src/models/facts/capabilities.ts`)
const { setSdkBetas } = await import(`${root}/src/boot/process-state/processState.ts`)
process.env.MERCURY_EXTRA_BODY = '{"anthropic_beta":["base"],"tag":1}'
assert.deepEqual(getExtraBodyParams(['base', 'new', 'new']), { anthropic_beta: ['base', 'new', 'new'], tag: 1 }, 'getExtraBodyParams in src/models/roads/anthropic/requestParams.ts must keep the incoming beta list as given (duplicates included) and merge the other MERCURY_EXTRA_BODY keys')
assert.deepEqual(getExtraBodyParams(), { anthropic_beta: ['base'], tag: 1 }, 'getExtraBodyParams in src/models/roads/anthropic/requestParams.ts must answer the MERCURY_EXTRA_BODY parse when called with no headers')
delete process.env.MERCURY_EXTRA_BODY
const headers = ['same', 'same']
assert.equal(getExtraBodyParams(headers).anthropic_beta, headers, 'getExtraBodyParams in src/models/roads/anthropic/requestParams.ts must return the caller beta array itself, not a deduplicated copy')
process.env.MERCURY_EXTRA_METADATA = '{"session_id":"wrong","tag":2,"account_uuid":"wrong"}'
const metadata = JSON.parse(getAPIMetadata().user_id)
assert.equal(metadata.tag, 2, 'getAPIMetadata in src/models/roads/anthropic/requestParams.ts must carry the extra keys from MERCURY_EXTRA_METADATA into user_id')
assert.notEqual(metadata.session_id, 'wrong', 'getAPIMetadata in src/models/roads/anthropic/requestParams.ts must keep its own session_id over the one in MERCURY_EXTRA_METADATA')
assert.notEqual(metadata.account_uuid, 'wrong', 'getAPIMetadata in src/models/roads/anthropic/requestParams.ts must keep its own account_uuid over the one in MERCURY_EXTRA_METADATA')
delete process.env.MERCURY_EXTRA_METADATA
const model = 'claude-haiku-4-5-20251001'
const base = getModelBetas(model).slice()
setSdkBetas(['proof-duplicate', 'proof-duplicate'])
assert.deepEqual(getMergedBetas(model).slice(-2), ['proof-duplicate', 'proof-duplicate'], 'getMergedBetas in src/models/facts/capabilities.ts must append the SDK betas as given, duplicates kept')
assert.deepEqual(getModelBetas(model), base, 'getMergedBetas in src/models/facts/capabilities.ts must not mutate the array getModelBetas caches')
setSdkBetas(undefined)
console.log('PASS request extras preserve incoming duplicates, cached parse isolation, identity overrides and model header ownership')
const { fetchSystemPromptParts, buildSideQuestionFallbackParams } = await import(`${root}/src/engine/system-prompt/systemPromptParts.ts`)
const parts = await fetchSystemPromptParts({ tools: [], engineModel: model, mcpClients: [], customSystemPrompt: '' })
assert.deepEqual(parts.defaultSystemPrompt, [], 'fetchSystemPromptParts in src/engine/system-prompt/systemPromptParts.ts must return an empty defaultSystemPrompt when customSystemPrompt is the empty string')
assert.deepEqual(parts.systemContext, {}, 'fetchSystemPromptParts in src/engine/system-prompt/systemPromptParts.ts must return an empty systemContext when customSystemPrompt is the empty string')
const rows: any[] = [{ type: 'user', message: { content: 'question' } }, { type: 'assistant', message: { stop_reason: null, content: [] } }]
let stateReads = 0
const getAppState = () => { stateReads++; return { toolPermissionContext: { mode: 'default' } } }
const readFileState = new Map()
const input = { tools: [], commands: [], mcpClients: [], messages: rows, readFileState, getAppState, setAppState: () => {}, customSystemPrompt: '', appendSystemPrompt: 'append', thinkingConfig: { type: 'disabled' }, agents: [] }
const fork = await buildSideQuestionFallbackParams(input)
assert.deepEqual(fork.systemPrompt, ['', 'append'], 'buildSideQuestionFallbackParams in src/engine/system-prompt/systemPromptParts.ts must keep the empty custom prompt and add the append prompt after it')
assert.deepEqual(fork.forkContextMessages, [rows[0]], 'buildSideQuestionFallbackParams in src/engine/system-prompt/systemPromptParts.ts must drop an assistant tail whose stop_reason is null')
assert.equal(fork.toolUseContext.messages, fork.forkContextMessages, 'buildSideQuestionFallbackParams in src/engine/system-prompt/systemPromptParts.ts must hand toolUseContext.messages the same array as forkContextMessages')
assert.equal(fork.toolUseContext.readFileState, readFileState, 'buildSideQuestionFallbackParams in src/engine/system-prompt/systemPromptParts.ts must share the caller readFileState, not copy it')
assert.equal(fork.toolUseContext.getAppState, getAppState, 'buildSideQuestionFallbackParams in src/engine/system-prompt/systemPromptParts.ts must pass the caller getAppState through')
assert.equal(fork.toolUseContext.options.thinkingConfig, input.thinkingConfig, 'buildSideQuestionFallbackParams in src/engine/system-prompt/systemPromptParts.ts must pass the caller thinkingConfig through')
assert.equal(stateReads, 1, 'buildSideQuestionFallbackParams in src/engine/system-prompt/systemPromptParts.ts must read getAppState exactly once')
rows[1].message.stop_reason = 'end_turn'
const finished = await buildSideQuestionFallbackParams({ ...input, appendSystemPrompt: '' })
assert.equal(finished.forkContextMessages, rows, 'buildSideQuestionFallbackParams in src/engine/system-prompt/systemPromptParts.ts must keep the same messages array when the last assistant turn has a stop_reason')
assert.deepEqual(finished.systemPrompt, [''], 'buildSideQuestionFallbackParams in src/engine/system-prompt/systemPromptParts.ts must leave out an empty appendSystemPrompt')
console.log('PASS empty custom prompts replace the default; side-question history trims only a null-stop tail and keeps shared context references')
