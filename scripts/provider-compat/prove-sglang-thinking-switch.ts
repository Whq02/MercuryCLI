import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { startEngineRules, validateEngineRequest, deepseekV4ThinkingMode, ENGINE_RULE_SOURCES } from './fixtures/engineRules.mjs'
import { pinSourceRef } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
const home = mkdtempSync(resolve(process.env.MERCURY_CONFIG_DIR, 'sglang-thinking-switch-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_TOOL_DEFER = '0'
for (const key of ['MERCURY_HOME', 'MERCURY_EFFORT_LEVEL', 'MERCURY_COMPAT_BASE_URL', 'MERCURY_COMPAT_API_KEY', 'MERCURY_COMPAT_MODELS', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete process.env[key]
const realFetch = globalThis.fetch
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (url.hostname !== '127.0.0.1') throw new Error(`Thinking-switch proof refused non-loopback fetch: ${url.origin}`)
  return realFetch(input, init)
}) as typeof fetch

const model = 'deepseek-ai/DeepSeek-V4.1-Flash-1017'
const fixture = await startEngineRules('sglang', { model, reasoningParser: 'deepseek-v41', toolParser: 'deepseekv41', modelType: 'deepseek_v41', architecture: 'DeepseekV4ForCausalLM' })
writeFileSync(resolve(home, 'settings.json'), JSON.stringify({ compatProvider: { pod: { baseUrl: fixture.baseUrl, dialect: 'sglang', models: [model] } } }))
let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail: unknown = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${JSON.stringify(detail)}`}`)
}
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { buildHostedExtras, buildLocalExtras } = await import('../../src/services/providers/openaicompat/compatWire.ts')
const { compatModelEfforts } = await import('../../src/services/providers/openaicompat/compatEffort.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
setIsInteractive(false)

type Extras = { reasoning_effort?: string; chat_template_kwargs?: { clear_thinking?: boolean; thinking?: boolean; reasoning_effort?: string } }
const vocabulary = ['low', 'high', 'max']
const hosted = (thinkingEnabled: boolean, effortValue: string | undefined, dialect: 'sglang' | 'vllm' | 'llamacpp' = 'sglang'): Extras =>
  buildHostedExtras({ wireModel: model, dialect, vocabulary, effortValue, thinkingEnabled, maxOutputTokensOverride: undefined }) as Extras
const legal = (extras: Extras): boolean => validateEngineRequest('sglang', { model, messages: [{ role: 'user', content: 'hello' }], ...extras }) === undefined

try {
  console.log(`engine law: ${ENGINE_RULE_SOURCES.sglang.thinking} (thinking_mode chat vs thinking; the effort prefix renders only in thinking mode) · measured live 2026-10-23 on SGLang dev-dsv41: chat_template_kwargs.thinking is the switch, an effort word implies thinking unless thinking is false, enable_thinking and thinking_mode are ignored`)
  const quiet = hosted(true, undefined)
  check('thinking on with no effort chosen sends chat_template_kwargs.thinking true and no effort word', quiet.chat_template_kwargs?.thinking === true && quiet.chat_template_kwargs?.clear_thinking === false && quiet.reasoning_effort === undefined, quiet)
  check('the engine fixture reads that request as thinking mode', deepseekV4ThinkingMode({ ...quiet }) === 'thinking' && legal(quiet), quiet)
  const loud = hosted(true, 'max')
  check('thinking on with max keeps reasoning_effort max beside thinking true', loud.reasoning_effort === 'max' && loud.chat_template_kwargs?.thinking === true && deepseekV4ThinkingMode({ ...loud }) === 'thinking' && legal(loud), loud)
  const off = hosted(false, undefined)
  check('thinking off sends thinking false', off.chat_template_kwargs?.thinking === false && off.chat_template_kwargs?.clear_thinking === false && deepseekV4ThinkingMode({ ...off }) === 'chat' && legal(off), off)
  const offWithWord = hosted(false, 'high')
  check('thinking off beside an effort word still resolves to chat mode on the engine', offWithWord.chat_template_kwargs?.thinking === false && deepseekV4ThinkingMode({ ...offWithWord }) === 'chat' && legal(offWithWord), offWithWord)
  const local = buildLocalExtras({ wireModel: model, effortValue: undefined, thinkingEnabled: true, maxOutputTokensOverride: undefined, server: 'sglang', acceptsEffort: true }) as Extras
  check('the local SGLang builder carries the same switch', local.chat_template_kwargs?.thinking === true && local.chat_template_kwargs?.clear_thinking === false, local)
  check('vLLM and llama.cpp builders carry no thinking key', hosted(true, undefined, 'vllm').chat_template_kwargs === undefined && hosted(true, 'max', 'llamacpp').chat_template_kwargs?.thinking === undefined && hosted(true, 'max', 'llamacpp').chat_template_kwargs?.reasoning_effort === 'max', { vllm: hosted(true, undefined, 'vllm'), llamacpp: hosted(true, 'max', 'llamacpp') })
  check('the fixture law itself: no switch and no word is chat, a word alone is thinking, none alone is chat, thinking false outranks a word', deepseekV4ThinkingMode({}) === 'chat' && deepseekV4ThinkingMode({ reasoning_effort: 'low' }) === 'thinking' && deepseekV4ThinkingMode({ reasoning_effort: 'none' }) === 'chat' && deepseekV4ThinkingMode({ reasoning_effort: 'high', chat_template_kwargs: { thinking: false } }) === 'chat' && deepseekV4ThinkingMode({ chat_template_kwargs: { thinking: true } }) === 'thinking')

  const id = `compat/pod/${model}`
  check('the pod model keeps the recipe vocabulary low, high, max', JSON.stringify(compatModelEfforts(id)) === JSON.stringify(vocabulary), compatModelEfforts(id))
  const route = async (thinking: boolean, effortValue: string | undefined, owner: string) => {
    const events: any[] = []
    for await (const event of routedCallModel({ messages: [createUserMessage({ content: 'hello' })], systemPrompt: asSystemPrompt(['thinking switch fixture']), thinkingConfig: thinking ? { type: 'enabled', budgetTokens: 8192 } : { type: 'disabled' }, tools: [], signal: AbortSignal.timeout(30000), options: { agents: [], getToolPermissionContext: async () => getEmptyToolPermissionContext(), model: id, ...(effortValue !== undefined ? { effortValue } : {}), ownerKey: owner, querySource: 'sdk', isNonInteractiveSession: true, hasAppendSystemPrompt: false, mcpTools: [], enablePromptCaching: false } as never })) events.push(event)
    const settled = events.some(event => event.type === 'assistant' && !event.isApiErrorMessage && event.message.stop_reason === 'end_turn')
    const sent = fixture.requests.at(-1)!
    return { settled, sent, body: sent.body as Extras, mode: sent.deepseekV4Thinking as string }
  }
  const fresh = await route(true, undefined, 'fresh-session')
  check('a fresh session (thinking on, no /effort chosen) reaches the engine in thinking mode', fresh.settled && fresh.mode === 'thinking' && fresh.body.chat_template_kwargs?.thinking === true && fresh.body.reasoning_effort === undefined && fresh.sent.fault === undefined, { mode: fresh.mode, extras: { reasoning_effort: fresh.body.reasoning_effort, chat_template_kwargs: fresh.body.chat_template_kwargs } })
  const max = await route(true, 'max', 'max-session')
  check('max stays max on the wire and the engine is in thinking mode', max.settled && max.mode === 'thinking' && max.body.reasoning_effort === 'max' && max.body.chat_template_kwargs?.thinking === true, { mode: max.mode, extras: { reasoning_effort: max.body.reasoning_effort, chat_template_kwargs: max.body.chat_template_kwargs } })
  const silent = await route(false, 'high', 'thinking-off-session')
  check('thinking off reaches the engine in chat mode even with an effort word on the session', silent.settled && silent.mode === 'chat' && silent.body.chat_template_kwargs?.thinking === false, { mode: silent.mode, extras: { reasoning_effort: silent.body.reasoning_effort, chat_template_kwargs: silent.body.chat_template_kwargs } })
} finally {
  await fixture.close()
  globalThis.fetch = realFetch
  rmSync(home, { recursive: true, force: true })
}
console.log(`prove-sglang-thinking-switch: ${checks} checks, ${failures} failed`)
process.exitCode = failures ? 1 : 0
