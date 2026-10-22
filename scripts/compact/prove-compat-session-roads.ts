import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { validateEngineRequest } from '../provider-compat/fixtures/engineRules.mjs'

assert.ok(process.env.MERCURY_CONFIG_DIR, 'a scratch MERCURY_CONFIG_DIR is required')
const originalFetch = globalThis.fetch
const dialects = ['llamacpp', 'vllm', 'sglang', 'ollama', 'lmstudio'] as const
const f = await llmhostFixture()
const previousCwd = process.cwd()
let dialect: string = dialects[0]
const ruleFaults: unknown[] = []
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  assert.equal(url.hostname, '127.0.0.1', 'all provider traffic stays on loopback')
  if (url.pathname === '/v1/chat/completions' && dialect !== 'lmstudio') {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : await (input as Request).clone().text())
    const fault = validateEngineRequest(dialect, body)
    if (fault) { ruleFaults.push(fault); return Response.json(fault.body, { status: fault.status }) }
  }
  return originalFetch(input, init)
}, originalFetch)
writeFileSync(join(f.home, 'settings.json'), JSON.stringify({ compatProvider: Object.fromEntries(dialects.map(name => [name, { baseUrl: f.baseUrl, dialect: name, models: [f.model] }])) }))
process.env.MERCURY_COMPACT_KEEP_TAIL = '1'
process.chdir(f.home)
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
bootstrap.setOriginalCwd(f.home)
bootstrap.setCwdState(f.home)
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
resetSettingsCache()
const { saveGlobalConfig } = await import('../../src/utils/config.ts')
saveGlobalConfig(current => ({ ...current, autoCompactEnabled: true }))
const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages.ts')
const { refreshCompatCatalogues } = await import('../../src/services/providers/openaicompat/compatCatalogue.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { contextFill } = await import('../../src/utils/tokens.ts')
const { compactConversation, buildPostCompactMessages, withFoldStatus } = await import('../../src/services/compact/compact.ts')
const { resolveAutoCompactWindow, getAutoCompactThreshold, calculateTokenWarningState, shouldAutoCompact } = await import('../../src/services/compact/autoCompact.ts')
const cr = await import('../../src/services/compact/checkpointRewind.ts')
const { CheckpointTool } = await import('../../src/tools/CheckpointTool/CheckpointTool.tsx')
const { RewindTool } = await import('../../src/tools/RewindTool/RewindTool.tsx')
let checks = 0
let failures = 0
const check = (name: string, truth: unknown, detail?: unknown) => { checks++; if (!truth) failures++; console.log(`${truth ? 'PASS' : 'FAIL'} ${dialect}: ${name}${!truth && detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`) }
const assistant = (model: string, content: any) => {
  const row = createAssistantMessage({ content })
  row.message.model = model
  return row
}
try {
  for (const name of dialects) {
    dialect = name
    f.state.dialect = name
    f.state.window = 32768
    f.state.thinkingValues = ['low', 'medium', 'high', 'max']
    f.state.field = name === 'llamacpp' ? '' : 'max_model_len'
    const model = `compat/${name}/${f.model}`
    await refreshCompatCatalogues({ force: true, name })
    check('the served 32k window owns the fold threshold', resolveAutoCompactWindow(model).window === 32768, resolveAutoCompactWindow(model))
    const threshold = getAutoCompactThreshold(model)
    const weighted = (tokens: number) => {
      const row = assistant(model, 'prior turn')
      row.message.usage = { input_tokens: tokens, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as never
      return [createUserMessage({ content: 'continue' }), row]
    }
    check('warning and auto-compact meet at the same served-window threshold', calculateTokenWarningState(threshold - 1, model).level === 'warn' && calculateTokenWarningState(threshold, model).level === 'compact' && !await shouldAutoCompact(weighted(threshold - 1), model) && await shouldAutoCompact(weighted(threshold), model))

    const history = [createUserMessage({ content: 'KEEP-BEFORE-CHECKPOINT' })]
    const checkpoint = { type: 'tool_use', id: 'checkpoint-original', name: 'Checkpoint', input: { goal: 'preserve the original boundary' } }
    const taken = await CheckpointTool.call(checkpoint.input as never, { messages: history } as never)
    history.push(assistant(model, [checkpoint]) as never, createUserMessage({ content: [{ type: 'tool_result', tool_use_id: checkpoint.id, content: JSON.stringify(taken) }] }))
    history.push(createUserMessage({ content: 'ABANDON-THIS-EXPLORATION' }))
    const rejected = { type: 'tool_use', id: 'checkpoint-refused', name: 'Checkpoint', input: { goal: 'nested attempt' } }
    const refusal = await CheckpointTool.call(rejected.input as never, { messages: history } as never).then(() => null, error => String(error))
    check('the second checkpoint is refused', refusal?.includes('already active'))
    history.push(assistant(model, [rejected]) as never, createUserMessage({ content: [{ type: 'tool_result', tool_use_id: rejected.id, content: refusal ?? 'unexpected success', is_error: true }] }))
    const reparsed = JSON.parse(JSON.stringify(history))
    check('a refused nested call cannot hide the original checkpoint after replay', cr.findActiveCheckpoint(reparsed)?.id === checkpoint.id)
    const unsettled = assistant(model, [{ type: 'tool_use', id: 'checkpoint-unsettled', name: 'Checkpoint', input: { goal: 'interrupted call' } }])
    check('an unsettled later call cannot hide the original checkpoint', cr.findActiveCheckpoint([...reparsed, unsettled])?.id === checkpoint.id)
    const stillRefused = await CheckpointTool.call(rejected.input as never, { messages: reparsed } as never).then(() => false, () => true)
    check('a third checkpoint remains refused rather than replacing the original', stillRefused)
    const rewind = { type: 'tool_use', id: 'rewind-original', name: 'Rewind', input: { report: 'KEEP-REPORT-ONLY' } }
    const rewound = await RewindTool.call(rewind.input as never, { messages: reparsed } as never).then(value => value, () => null)
    check('Rewind still returns to the original goal', (rewound as any)?.data?.goal === checkpoint.input.goal)
    const result = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: rewind.id, content: JSON.stringify(rewound), ...(rewound === null ? { is_error: true } : {}) }] })
    const record = cr.buildRewindRecordIfSettled(reparsed, [rewind], [result])
    check('the successful rewind mints its retained report', record !== null)
    if (record !== null) {
      const full = [...reparsed, assistant(model, [rewind]), result, record, createUserMessage({ content: 'CONTINUE-AFTER-REWIND' })]
      const projected = cr.projectRewoundWindows(full)
      check('the closed checkpoint cannot be resurrected by a later refused call', cr.findActiveCheckpoint([...full, assistant(model, [rejected]), history.at(-1)!]) === null)
      const before = f.captures.length
      const answer = await f.run(model, projected)
      check('the rewound conversation receives a completed answer', answer.some(row => row.message.content.some((block: any) => block.type === 'text' && block.text === 'LLMHOST-READY')) && answer.every(row => !row.isApiErrorMessage))
      const sent = JSON.stringify(f.captures[before]?.body.messages)
      check('the next engine request retains the checkpoint pair and report, not the exploration', sent.includes('checkpoint-original') && sent.includes('KEEP-BEFORE-CHECKPOINT') && sent.includes('KEEP-REPORT-ONLY') && sent.includes('CONTINUE-AFTER-REWIND') && !sent.includes('ABANDON-THIS-EXPLORATION') && !sent.includes('checkpoint-refused'))
    }

    const statuses: any[] = []
    const state = { toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map(), tasks: {}, mcp: { clients: [], tools: [], commands: [], resources: {} }, effortValue: 'max' }
    const context: any = { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, messages: [], readFileState: createFileStateCacheWithSizeLimit(100), setSDKStatus: (status: any) => statuses.push(status), options: { tools: [], commands: [], mcpClients: [], engineModel: model, thinkingConfig: { type: 'enabled', budgetTokens: 4096 }, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } } }
    const turns = Array.from({ length: 15 }, (_, index) => [createUserMessage({ content: `operator-${index}: keep the completed work` }), assistant(model, `answer-${index}: ` + 'completed parser verification '.repeat(30))]).flat()
    const cache = { systemPrompt: asSystemPrompt(['Fixture session posture']), userContext: {}, systemContext: {}, toolUseContext: context, forkContextMessages: turns }
    const before = f.captures.length
    const folded = await withFoldStatus(context, scoped => compactConversation(turns, scoped, cache as never, true), { trigger: 'manual', sessionMemory: false, microcompaction: false })
    const requests = f.captures.slice(before)
    check('the summariser answers on the selected engine with the original effort', requests.length > 0 && requests.every(row => row.body.model === f.model && (name === 'lmstudio' || (row.body.reasoning_effort ?? row.body.chat_template_kwargs?.reasoning_effort) === 'max')))
    check('fold progress and successful completion reach the session status door', statuses.some(row => row?.compacting?.summaryTokens > 0) && statuses.some(row => row?.compacting?.exit === 'landed'))
    const post = buildPostCompactMessages(folded)
    check('the verbatim tail and summary survive with a fresh context estimate', (folded.messagesToKeep?.length ?? 0) > 0 && JSON.stringify(post).includes('answer-14') && JSON.stringify(post).includes('LLMHOST-READY') && contextFill(post).source === 'estimate')
    const answer = await f.run(model, [...post, createUserMessage({ content: 'CONTINUE-AFTER-COMPACT' })])
    check('the first post-compact request reaches the same engine and answers', f.captures.at(-1)?.body.model === f.model && JSON.stringify(f.captures.at(-1)?.body.messages).includes('CONTINUE-AFTER-COMPACT') && answer.some(row => row.message.content.some((block: any) => block.type === 'text' && block.text === 'LLMHOST-READY')) && answer.every(row => !row.isApiErrorMessage))
  }
  check('every request passes its engine rule fixture', ruleFaults.length === 0, ruleFaults)
} finally {
  globalThis.fetch = originalFetch
  process.chdir(previousCwd)
  f.close()
}
console.log(`COMPAT SESSION ROADS ${failures ? 'RED' : 'GREEN'} — ${checks - failures}/${checks}; five loopback dialects, no live engine`)
process.exit(failures ? 1 : 0)
