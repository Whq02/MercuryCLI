import { strict as assert } from 'node:assert'
import { resolve } from 'node:path'
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const root = resolve(process.argv[2] ?? new URL('../..', import.meta.url).pathname)
const { enableConfigs } = await import(`${root}/src/utils/config.ts`)
enableConfigs()
const { getExtraBodyParams, getAPIMetadata } = await import(`${root}/src/services/providers/anthropic/requestParams.ts`)
const { getMergedBetas, getModelBetas } = await import(`${root}/src/utils/model/capabilities.ts`)
const { setSdkBetas } = await import(`${root}/src/bootstrap/state.ts`)
process.env.MERCURY_EXTRA_BODY = '{"anthropic_beta":["base"],"tag":1}'
assert.deepEqual(getExtraBodyParams(['base', 'new', 'new']), { anthropic_beta: ['base', 'new', 'new'], tag: 1 })
assert.deepEqual(getExtraBodyParams(), { anthropic_beta: ['base'], tag: 1 })
delete process.env.MERCURY_EXTRA_BODY
const headers = ['same', 'same']
assert.equal(getExtraBodyParams(headers).anthropic_beta, headers)
process.env.MERCURY_EXTRA_METADATA = '{"session_id":"wrong","tag":2,"account_uuid":"wrong"}'
const metadata = JSON.parse(getAPIMetadata().user_id)
assert.equal(metadata.tag, 2)
assert.notEqual(metadata.session_id, 'wrong')
assert.notEqual(metadata.account_uuid, 'wrong')
delete process.env.MERCURY_EXTRA_METADATA
const model = 'claude-haiku-4-5-20251001'
const base = getModelBetas(model).slice()
setSdkBetas(['proof-duplicate', 'proof-duplicate'])
assert.deepEqual(getMergedBetas(model).slice(-2), ['proof-duplicate', 'proof-duplicate'])
assert.deepEqual(getModelBetas(model), base)
setSdkBetas(undefined)
console.log('PASS request extras preserve incoming duplicates, cached parse isolation, identity overrides and model header ownership')
const { fetchSystemPromptParts, buildSideQuestionFallbackParams } = await import(`${root}/src/utils/queryContext.ts`)
const parts = await fetchSystemPromptParts({ tools: [], engineModel: model, mcpClients: [], customSystemPrompt: '' })
assert.deepEqual(parts.defaultSystemPrompt, [])
assert.deepEqual(parts.systemContext, {})
const rows: any[] = [{ type: 'user', message: { content: 'question' } }, { type: 'assistant', message: { stop_reason: null, content: [] } }]
let stateReads = 0
const getAppState = () => { stateReads++; return { toolPermissionContext: { mode: 'default' } } }
const readFileState = new Map()
const input = { tools: [], commands: [], mcpClients: [], messages: rows, readFileState, getAppState, setAppState: () => {}, customSystemPrompt: '', appendSystemPrompt: 'append', thinkingConfig: { type: 'disabled' }, agents: [] }
const fork = await buildSideQuestionFallbackParams(input)
assert.deepEqual(fork.systemPrompt, ['', 'append'])
assert.deepEqual(fork.forkContextMessages, [rows[0]])
assert.equal(fork.toolUseContext.messages, fork.forkContextMessages)
assert.equal(fork.toolUseContext.readFileState, readFileState)
assert.equal(fork.toolUseContext.getAppState, getAppState)
assert.equal(fork.toolUseContext.options.thinkingConfig, input.thinkingConfig)
assert.equal(stateReads, 1)
rows[1].message.stop_reason = 'end_turn'
const finished = await buildSideQuestionFallbackParams({ ...input, appendSystemPrompt: '' })
assert.equal(finished.forkContextMessages, rows)
assert.deepEqual(finished.systemPrompt, [''])
console.log('PASS empty custom prompts replace the default; side-question history trims only a null-stop tail and keeps shared context references')
