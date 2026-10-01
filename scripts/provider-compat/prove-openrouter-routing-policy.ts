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
type Routing = import('../../src/utils/settings/types.js').SettingsJson['openrouterRouting']
const deferred = { name: 'FixtureRead', shouldDefer: true, prompt: async () => 'Read a fixture', description: async () => 'Read a fixture', inputSchema: z.object({ path: z.string() }), isEnabled: () => true, isConcurrencySafe: () => true, isReadOnly: () => true, userFacingName: () => 'FixtureRead', call: async () => ({ data: 'fixture' }) } as unknown as Tool
const messages = [createUserMessage({ content: 'Say OK' })]
async function drive(model: string, responses = false): Promise<Capture | undefined> {
  clearToolRosterLatches()
  process.env.MERCURY_TOOL_DEFER = responses ? '1' : '0'
  const before = captured.length
  let settled = false
  const errors: string[] = []
  for await (const item of routedCallModel({ messages: messages as never, systemPrompt: ['Fixture system'] as never, thinkingConfig: { type: 'disabled' }, tools: [ToolSearchTool, deferred] as never, signal: new AbortController().signal, options: { model, querySource: 'repl_main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], hasPendingMcpServers: false } as never })) {
    if (item.type === 'assistant') {
      if (item.isApiErrorMessage) errors.push(JSON.stringify(item.message.content))
      else settled ||= item.message.stop_reason === 'end_turn'
    }
  }
  const result = captured[before]
  check(`${model}: ${responses ? 'responses' : 'chat'} turn settles once`, settled && captured.length === before + 1 && !!result?.path.endsWith(responses ? '/responses' : '/chat/completions'), errors.join(' | '))
  return result
}
function setting(value: Routing): void {
  updateSettingsForSource('userSettings', { openrouterRouting: undefined })
  if (value !== undefined) updateSettingsForSource('userSettings', { openrouterRouting: value })
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const receipts: Record<string, unknown> = {}
try {
  setting(undefined)
  const absentChat = await drive('openrouter/fixture/model')
  const absentResponses = await drive('openrouter/fixture/model', true)
  check('untouched chat sends no provider object', absentChat !== undefined && !('provider' in absentChat.body))
  check('untouched responses sends no provider object', absentResponses !== undefined && !('provider' in absentResponses.body))
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
    check(`${responses ? 'responses' : 'chat'}: present empty setting sends deny and require`, same(defaults?.body.provider, { data_collection: 'deny', require_parameters: true }), JSON.stringify(defaults?.body))
    setting({ dataCollection: 'allow', requireParameters: false, allowFallbacks: true, zeroDataRetention: false })
    const off = await drive('openrouter/fixture/model', responses)
    const absent = responses ? absentResponses : absentChat
    check(`${responses ? 'responses' : 'chat'}: all-off keeps untouched bytes`, off !== undefined && off.raw === absent?.raw, JSON.stringify([off?.body, absent?.body]))
    for (const dataCollection of ['allow', 'deny'] as const) for (const requireParameters of [false, true]) for (const allowFallbacks of [false, true]) for (const zeroDataRetention of [false, true]) {
      setting({ dataCollection, requireParameters, allowFallbacks, zeroDataRetention })
      const expected = { ...(dataCollection === 'deny' ? { data_collection: 'deny' } : {}), ...(requireParameters ? { require_parameters: true } : {}), ...(!allowFallbacks ? { allow_fallbacks: false } : {}), ...(zeroDataRetention ? { zdr: true } : {}) }
      const result = await drive('openrouter/fixture/model', responses)
      check(`${responses ? 'responses' : 'chat'}: exact policy ${JSON.stringify(expected)}`, same(result?.body.provider, Object.keys(expected).length > 0 ? expected : undefined), JSON.stringify(result?.body.provider))
      check('ZDR off is absent, never false', zeroDataRetention || !('zdr' in ((result?.body.provider ?? {}) as Body)))
    }
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
