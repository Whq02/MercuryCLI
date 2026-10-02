#!/usr/bin/env bun
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { pinSourceRef } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const home = mkdtempSync(join(tmpdir(), 'openrouter-routing-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.HOME = home
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
type Body = Record<string, unknown>
type Capture = { path: string; raw: string; body: Body }
const captured: Capture[] = []
let faultReply: { status: number; message: string } | undefined
let onPosted: (() => void) | undefined
let rejectUnsupportedTools = false
const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const path = req.url ?? ''
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: path.endsWith('/models') ? ['fixture/model', 'kimi-k3', 'deepseek-v4-pro', 'fixture-model'].map(id => ({ id, name: id, context_length: 65536, supported_parameters: ['tools', 'reasoning'] })) : {} }))
    return
  }
  const raw = Buffer.concat(chunks).toString()
  const body = JSON.parse(raw) as Body
  captured.push({ path, raw, body })
  const posted = onPosted
  onPosted = undefined
  posted?.()
  const reply = faultReply ?? (rejectUnsupportedTools && Array.isArray(body.tools) && body.tools.length > 0 && (body.provider as Body)?.require_parameters === true ? { status: 503, message: 'There is no available model provider that meets your routing requirements.' } : undefined)
  if (reply !== undefined) {
    res.writeHead(reply.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: reply.status, message: reply.message } }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  if (path.endsWith('/responses')) {
    const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] }
    res.end(sse({ type: 'response.created', response: { id: 'r_fixture', model: body.model, status: 'in_progress' } }) + sse({ type: 'response.output_item.added', item: { ...item, status: 'in_progress', content: [] } }) + sse({ type: 'response.output_text.delta', item_id: item.id, delta: 'OK' }) + sse({ type: 'response.output_item.done', item }) + sse({ type: 'response.completed', response: { id: 'r_fixture', model: body.model, status: 'completed', output: [item], usage: { input_tokens: 3, output_tokens: 1 } } }) + 'data: [DONE]\n\n')
  } else {
    res.end(sse({ id: 'chat_fixture', model: body.model, choices: [{ index: 0, delta: { content: 'OK' } }] }) + sse({ id: 'chat_fixture', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }) + 'data: [DONE]\n\n')
  }
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (address === null || typeof address === 'string') throw new Error('fixture did not bind')
const base = `http://127.0.0.1:${address.port}`
Object.assign(process.env, {
  OPENROUTER_API_KEY: 'fixture-openrouter',
  DEEPSEEK_API_KEY: 'fixture-deepseek',
  MOONSHOT_API_KEY: 'fixture-moonshot',
  MERCURY_COMPAT_API_KEY: 'fixture-compat',
  MERCURY_OPENROUTER_API_BASE: `${base}/openrouter`,
  MERCURY_OPENROUTER_AUTH_BASE: `${base}/auth`,
  MERCURY_DEEPSEEK_API_BASE: `${base}/deepseek`,
  MERCURY_MOONSHOT_API_BASE: `${base}/moonshot`,
  MERCURY_MOONSHOT_OAUTH_BASE: `${base}/moonshot/oauth`,
  MERCURY_COMPAT_BASE_URL: `${base}/compat`,
})
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { updateSettingsForSource } = await import('../../src/utils/settings/settings.js')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.js')
const { clearToolRosterLatches } = await import('../../src/services/providers/toolEconomy.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
const { createUserMessage } = await import('../../src/utils/messages.js')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.js')
type Tool = import('../../src/Tool.js').Tool
type Routing = NonNullable<import('../../src/utils/settings/types.js').SettingsJson['routing']>['openrouter']
const deferred = { name: 'FixtureRead', shouldDefer: true, prompt: async () => 'Read a fixture', description: async () => 'Read a fixture', inputSchema: z.object({ path: z.string() }), isEnabled: () => true, isConcurrencySafe: () => true, isReadOnly: () => true, userFacingName: () => 'FixtureRead', call: async () => ({ data: 'fixture' }) } as unknown as Tool
const messages = [createUserMessage({ content: 'Say OK' })]
async function turn(model: string, responses = false, singleShot = false): Promise<{ captures: Capture[]; errors: string[]; settled: boolean }> {
  clearToolRosterLatches()
  process.env.MERCURY_TOOL_DEFER = responses ? '1' : '0'
  const before = captured.length
  let settled = false
  const errors: string[] = []
  for await (const item of routedCallModel({ messages: messages as never, systemPrompt: ['Fixture system'] as never, thinkingConfig: { type: 'disabled' }, tools: [ToolSearchTool, deferred] as never, signal: new AbortController().signal, options: { model, querySource: singleShot ? 'overload_probe' : 'repl_main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], hasPendingMcpServers: false } as never })) {
    if (item.type === 'assistant') {
      if (item.isApiErrorMessage) errors.push(item.message.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join(''))
      else settled ||= item.message.stop_reason === 'end_turn'
    }
  }
  return { captures: captured.slice(before), errors, settled }
}
async function drive(model: string, responses = false): Promise<Capture | undefined> {
  const result = await turn(model, responses)
  check(`${model}: ${responses ? 'responses' : 'chat'} turn settles once`, result.settled && result.captures.length === 1 && !!result.captures[0]?.path.endsWith(responses ? '/responses' : '/chat/completions'), result.errors.join(' | '))
  return result.captures[0]
}
function setting(value: Routing): void {
  updateSettingsForSource('userSettings', { routing: { openrouter: undefined } })
  if (value !== undefined) updateSettingsForSource('userSettings', { routing: { openrouter: value } })
}
const allOff: Routing = { dataCollection: 'allow', requireParameters: false, allowFallbacks: true, zeroDataRetention: false }
const policyBytes = '{"data_collection":"deny","require_parameters":true}'
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const withoutPolicy = (body: Body | undefined): string => {
  const { provider: _provider, ...rest } = body ?? {}
  return JSON.stringify(rest)
}
const receipts: Record<string, unknown> = {}
try {
  if (!process.argv.includes('--faults-only')) {
  setting(undefined)
  const absentChat = await drive('openrouter/fixture/model')
  const absentResponses = await drive('openrouter/fixture/model', true)
  check('untouched chat sends exactly the deny and require policy bytes', JSON.stringify(absentChat?.body.provider) === policyBytes && absentChat?.raw.includes(`"provider":${policyBytes}`) === true, JSON.stringify(absentChat?.body.provider))
  check('untouched responses sends exactly the deny and require policy bytes', JSON.stringify(absentResponses?.body.provider) === policyBytes && absentResponses?.raw.includes(`"provider":${policyBytes}`) === true, JSON.stringify(absentResponses?.body.provider))
  receipts.chat = absentChat?.raw
  receipts.responses = absentResponses?.raw
  for (const model of ['deepseek-v4-pro', 'kimi-k3', 'compat/fixture-model']) {
    setting(undefined)
    const before = await drive(model)
    setting({ zeroDataRetention: true, allowFallbacks: false })
    const after = await drive(model)
    check(`${model}: policy changes not one body byte`, before !== undefined && after?.raw === before.raw && !('provider' in after.body))
    receipts[model] = before?.raw
  }
  for (const responses of [false, true]) {
    setting({})
    const defaults = await drive('openrouter/fixture/model', responses)
    check(`${responses ? 'responses' : 'chat'}: present empty setting sends deny and require`, JSON.stringify(defaults?.body.provider) === policyBytes, JSON.stringify(defaults?.body))
    const absent = responses ? absentResponses : absentChat
    check(`${responses ? 'responses' : 'chat'}: absent and empty settings produce byte-identical bodies`, defaults !== undefined && defaults.raw === absent?.raw)
    setting(allOff)
    const off = await drive('openrouter/fixture/model', responses)
    check(`${responses ? 'responses' : 'chat'}: explicit all-off removes only the policy bytes`, off !== undefined && !('provider' in off.body) && off.raw === withoutPolicy(absent?.body), JSON.stringify([off?.body, absent?.body]))
    receipts[responses ? 'responsesAllOff' : 'chatAllOff'] = off?.raw
    for (const dataCollection of ['allow', 'deny'] as const) for (const requireParameters of [false, true]) for (const allowFallbacks of [false, true]) for (const zeroDataRetention of [false, true]) {
      setting({ dataCollection, requireParameters, allowFallbacks, zeroDataRetention })
      const expected = { ...(dataCollection === 'deny' ? { data_collection: 'deny' } : {}), ...(requireParameters ? { require_parameters: true } : {}), ...(!allowFallbacks ? { allow_fallbacks: false } : {}), ...(zeroDataRetention ? { zdr: true } : {}) }
      const result = await drive('openrouter/fixture/model', responses)
      check(`${responses ? 'responses' : 'chat'}: exact policy ${JSON.stringify(expected)}`, same(result?.body.provider, Object.keys(expected).length > 0 ? expected : undefined), JSON.stringify(result?.body.provider))
      check('ZDR off is absent, never false', zeroDataRetention || !('zdr' in ((result?.body.provider ?? {}) as Body)))
    }
  }
  }
  const remedy = ' — no OpenRouter endpoint met your routing policy; /config → OpenRouter routing policy widens it'
  const noProvider = ['There is no available model provider that meets your routing requirements.', 'No available provider meets your routing requirements']
  const overloaded = 'The upstream provider is temporarily overloaded. Retry after a short delay.'
  for (const responses of [false, true]) {
    for (const message of noProvider) {
      faultReply = { status: 503, message }
      setting(allOff)
      const off = await turn('openrouter/fixture/model', responses, true)
      setting(undefined)
      const on = await turn('openrouter/fixture/model', responses, true)
      check(`${responses ? 'responses' : 'chat'}: policy 503 adds only the remedy to the existing error`, off.errors.length === 1 && on.errors.length === 1 && on.errors[0] === off.errors[0] + remedy, JSON.stringify({ off: off.errors, on: on.errors }))
      check('policy-off 503 never names the config row', !off.errors.join('').includes('OpenRouter routing policy'))
      if (!responses) check('policy-off chat keeps exact terminal words', off.errors[0] === `API Error: OpenRouter stream failed (http-503) — ${message}`, off.errors[0])
    }
    setting({})
    faultReply = { status: 503, message: overloaded }
    const busy = await turn('openrouter/fixture/model', responses, true)
    check('the documented overloaded sentence never gets a policy label', busy.errors.length === 1 && busy.errors[0]!.includes(overloaded) && !busy.errors[0]!.includes('OpenRouter routing policy'), busy.errors.join(''))
    for (const status of [400, 404, 500]) {
      faultReply = { status, message: noProvider[0]! }
      const other = await turn('openrouter/fixture/model', responses, true)
      check(`${status} is not relabelled as the policy 503`, other.errors.length === 1 && !other.errors[0]!.includes('OpenRouter routing policy'), other.errors.join(''))
    }
    process.env.MERCURY_BUSY_RETRY_SCALE = '0.001'
    for (const message of [overloaded, noProvider[0]!]) {
      setting(undefined)
      faultReply = { status: 503, message }
      onPosted = () => setting(allOff)
      const retried = await turn('openrouter/fixture/model', responses)
      const wantsNote = message !== overloaded
      check(`${responses ? 'responses' : 'chat'}: ${wantsNote ? 'policy miss' : 'overload'} keeps all six busy retries`, retried.captures.length === 7 && retried.errors.length === 1 && retried.errors[0]!.includes('stayed busy through 6 retries'), `${retried.captures.length} ${retried.errors.join('')}`)
      check('terminal note describes the request snapshot, not a later settings edit', retried.errors[0]?.endsWith(remedy) === wantsNote, retried.errors.join(''))
      check('each retry keeps the identical request policy and tools', retried.captures.every(c => c.raw === retried.captures[0]?.raw && Array.isArray(c.body.tools) && (c.body.provider as Body)?.require_parameters === true))
    }
    setting(allOff)
    faultReply = { status: 503, message: noProvider[0]! }
    onPosted = () => setting(undefined)
    const after = await turn('openrouter/fixture/model', responses, true)
    check('turning policy on after posting cannot relabel an unfiltered request', after.errors.length === 1 && !after.errors[0]!.includes('OpenRouter routing policy'))
  }
  faultReply = { status: 503, message: noProvider[0]! }
  setting({})
  const otherLane = await turn('deepseek-v4-pro', false, true)
  check('the same 503 on DeepSeek has no OpenRouter remedy', otherLane.errors.length === 1 && !otherLane.errors[0]!.includes('OpenRouter routing policy'))
  faultReply = undefined
  rejectUnsupportedTools = true
  for (const responses of [false, true]) {
    setting({})
    const required = await turn('openrouter/fixture/model', responses, true)
    check('tools with no supporting endpoint fail with the policy remedy when parameters are required', required.errors.length === 1 && required.errors[0]!.endsWith(remedy) && !required.settled)
    setting({ requireParameters: false })
    const relaxed = await turn('openrouter/fixture/model', responses, true)
    check('relaxing parameters widens the fixture pool without relaxing collection', relaxed.settled && relaxed.errors.length === 0 && (relaxed.captures[0]?.body.provider as Body)?.data_collection === 'deny' && !('require_parameters' in (relaxed.captures[0]?.body.provider as Body)))
  }
  const at = process.argv.indexOf('--wire-receipt')
  if (at >= 0 && process.argv[at + 1]) writeFileSync(process.argv[at + 1]!, JSON.stringify(receipts, null, 2) + '\n')
} finally {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(home, { recursive: true, force: true })
}
console.log(`prove-openrouter-routing-policy: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
