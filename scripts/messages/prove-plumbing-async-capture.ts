import { strict as assert } from 'node:assert'
import { mock } from 'bun:test'
import { resolve } from 'node:path'
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const root = resolve(process.argv[2] ?? new URL('../..', import.meta.url).pathname)
const events: string[] = []
let releaseUser: () => void = () => {}
let userPending = false
mock.module(`${root}/src/context.ts`, () => ({
  isInstructionDiscoveryDisabled: () => false,
  getGitStatus: async () => null,
  getUserContext: () => { events.push('user'); return userPending ? new Promise(resolve => { releaseUser = () => resolve({ user: 'context' }) }) : Promise.resolve({ user: 'context' }) },
  getSystemContext: () => { events.push('system'); return Promise.resolve({ system: 'context' }) },
}))
mock.module(`${root}/src/constants/prompts.ts`, () => ({
  computeEnvInfo: async () => '', computeSimpleEnvInfo: async () => '', enhanceSystemPromptWithEnvDetails: async () => [],
  getSystemPrompt: async () => { events.push('prompt'); return ['default'] },
}))
let recorded: any[] = []
let routed: any
let duringRecording = () => {}
mock.module(`${root}/src/services/vcr.ts`, () => ({
  withVCR: async (rows: any[], callback: () => Promise<any>) => { recorded = rows; duringRecording(); return callback() },
  withStreamingVCR: (_rows: any, callback: any) => callback(),
  withTokenCountVCR: async () => { throw new Error('unexpected token count') },
}))
const routes = await import(`${root}/src/services/providers/routeLaw.ts`)
mock.module(`${root}/src/services/providers/callModelRouter.ts`, () => ({
  ...routes,
  routedCallModelSettled: async () => { throw new Error('unexpected direct settlement') },
  routedCallModel: async function* (params: any) { routed = params; yield { type: 'system' }; yield { type: 'assistant', marker: 'one' }; yield { type: 'assistant', marker: 'two' } },
  settleAssistantTurn: (rows: any[], aborted: boolean) => ({ type: 'assistant', rows, aborted }),
}))
const { enableConfigs } = await import(`${root}/src/utils/config.ts`)
enableConfigs()
const { setEngineModelOverride } = await import(`${root}/src/bootstrap/state.ts`)
setEngineModelOverride('claude-haiku-4-5-20251001')
const context = await import(`${root}/src/services/agents/queryContext.ts`)
const parts = await context.fetchSystemPromptParts({ tools: [], engineModel: 'model', mcpClients: [] })
assert.deepEqual(events, ['prompt', 'user', 'system'], 'fetchSystemPromptParts in src/services/agents/queryContext.ts must start the default prompt, user context and system context calls in that order')
assert.deepEqual(parts, { defaultSystemPrompt: ['default'], userContext: { user: 'context' }, systemContext: { system: 'context' } }, 'fetchSystemPromptParts in src/services/agents/queryContext.ts must return the three parts it awaited')
events.length = 0
const custom = await context.fetchSystemPromptParts({ tools: [], engineModel: 'model', mcpClients: [], customSystemPrompt: '' })
assert.deepEqual(events, ['user'], 'fetchSystemPromptParts in src/services/agents/queryContext.ts must call only the user context when customSystemPrompt is an empty string')
assert.deepEqual(custom.defaultSystemPrompt, [], 'fetchSystemPromptParts in src/services/agents/queryContext.ts must return an empty defaultSystemPrompt for a custom prompt')
assert.deepEqual(custom.systemContext, {}, 'fetchSystemPromptParts in src/services/agents/queryContext.ts must return an empty systemContext for a custom prompt')
console.log('PASS prompt calls start in order; empty custom prompt skips both default companions')
userPending = true
const rows: any[] = [{ type: 'user', message: { content: 'original rows' } }]
const originalTools: any[] = []
const input: any = { tools: originalTools, commands: [], mcpClients: [], messages: rows, readFileState: new Map(), getAppState: function(this: unknown) { assert.equal(this, undefined); return { toolPermissionContext: { mode: 'default' } } }, setAppState: () => {}, customSystemPrompt: 'original', appendSystemPrompt: 'append', thinkingConfig: { type: 'disabled' }, agents: [] }
const pending = context.buildSideQuestionFallbackParams(input)
input.customSystemPrompt = 'mutated'
input.appendSystemPrompt = 'changed'
input.messages = []
input.tools = [{ name: 'new' }]
releaseUser()
const fallback = await pending
assert.deepEqual(fallback.systemPrompt, ['original', 'append'], 'buildSideQuestionFallbackParams in src/services/agents/queryContext.ts must read customSystemPrompt and appendSystemPrompt from the input before it awaits the prompt parts')
assert.equal(fallback.forkContextMessages, rows, 'buildSideQuestionFallbackParams in src/services/agents/queryContext.ts must capture input.messages before it awaits the prompt parts')
assert.equal(fallback.toolUseContext.options.tools, originalTools, 'buildSideQuestionFallbackParams in src/services/agents/queryContext.ts must capture input.tools before it awaits the prompt parts')
console.log('PASS fallback parameters capture the caller fields before awaiting prompt parts')
const { queryWithModel } = await import(`${root}/src/services/providers/anthropic/streamCore.ts`)
const originalSignal = new AbortController().signal
const question: any = { systemPrompt: ['system'], userPrompt: 'original user', outputFormat: { type: 'json_schema', schema: {} }, signal: originalSignal, options: { model: 'fixture', querySource: 'fixture' } }
const oldFormat = question.outputFormat
const oldOptions = question.options
duringRecording = () => { question.userPrompt = 'mutated'; question.outputFormat = undefined; question.signal = new AbortController().signal; question.options = { model: 'wrong' } }
const reply = await queryWithModel(question)
assert.equal(recorded[1].message.content, 'original user', 'queryWithModel in src/services/providers/anthropic/streamCore.ts must copy question.userPrompt before the recording callback runs')
assert.equal(routed.messages[0].message.content, 'original user', 'queryWithModel in src/services/providers/anthropic/streamCore.ts must route the user prompt captured before recording')
assert.equal(routed.signal, originalSignal, 'queryWithModel in src/services/providers/anthropic/streamCore.ts must route the signal captured before recording')
assert.equal(routed.options.model, oldOptions.model, 'queryWithModel in src/services/providers/anthropic/streamCore.ts must route the model from the options captured before recording')
assert.equal(routed.options.outputFormat, oldFormat, 'queryWithModel in src/services/providers/anthropic/streamCore.ts must route the outputFormat captured before recording')
assert.equal(routed.options.enablePromptCaching, false, 'queryWithModel in src/services/providers/anthropic/streamCore.ts must route enablePromptCaching as false')
assert.deepEqual(routed.tools, [], 'queryWithModel in src/services/providers/anthropic/streamCore.ts must route an empty tools list')
assert.deepEqual(routed.thinkingConfig, { type: 'disabled' }, 'queryWithModel in src/services/providers/anthropic/streamCore.ts must route thinkingConfig as disabled')
assert.deepEqual(reply.rows.map((r: any) => r.marker), ['one', 'two'], 'queryWithModel in src/services/providers/anthropic/streamCore.ts must drain every assistant row from the routed stream and settle them once')
assert.equal(reply.aborted, false, 'queryWithModel in src/services/providers/anthropic/streamCore.ts must settle with aborted false when the stream ends normally')
console.log('PASS one-shot call captures fields before recording, drains assistants, preserves routing options and settles once')
