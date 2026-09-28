#!/usr/bin/env bun
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod/v4'
import type { Tool } from '../../src/Tool.ts'
import type { Message } from '../../src/types/message.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(resolve(import.meta.dir, '..', '..'))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR ?? tmpdir(), 'kimi-dynamic-tools-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const key of ['NODE_ENV', 'ANTHROPIC_BASE_URL', 'MERCURY_TOOL_SEARCH', 'MERCURY_TOOL_DEFER', 'MERCURY_TOOL_DEFER_PROBE', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC']) delete process.env[key]

let failed = 0
let checked = 0
const check = (name: string, ok: boolean, detail = '') => {
  checked++
  if (!ok) failed++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${!ok && detail ? ` — ${detail}` : ''}`)
}
const KIMI = 'kimi-for-coding'
let dynamic = true
const bodies: any[] = []
const server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [
        { id: KIMI, display_name: 'K2.8 Preview', supports_dynamic_tools: dynamic },
        { id: 'kimi-for-coding-highspeed', display_name: 'K2.7 Code Highspeed', supports_dynamic_tools: false },
        { id: 'kimi-k2.6', supports_dynamic_tools: false },
        { id: 'k3', supports_dynamic_tools: true },
      ] }))
      return
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString()))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end([
        { id: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }] },
        { id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 1 } },
      ].map(row => `data: ${JSON.stringify(row)}\n\n`).join('') + 'data: [DONE]\n\n')
      return
    }
    res.writeHead(404)
    res.end('{}')
  })
})
await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
const port = (server.address() as { port: number }).port
process.env.MERCURY_MOONSHOT_API_BASE = `http://127.0.0.1:${port}/v1`
process.env.MOONSHOT_API_KEY = 'fixture-kimi-key'
process.env.MERCURY_MODEL = KIMI

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
;(await import('../../src/bootstrap/state.ts')).setIsInteractive(false)
const catalogue = await import('../../src/services/providers/moonshot/moonshotCatalogue.ts')
const pins = await import('../../src/services/providers/moonshot/kimiPins.ts')
const wire = await import('../../src/services/providers/deferralWire.ts')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
const { getDeferredToolsDeltaAttachment } = await import('../../src/utils/attachments/deltas.ts')
const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.ts')
const { clearToolRosterLatches } = await import('../../src/services/providers/toolEconomy.ts')
const permission = getEmptyToolPermissionContext()
const tool = (name: string, shouldDefer: boolean): Tool => ({
  name, shouldDefer, alwaysLoad: !shouldDefer, inputSchema: z.object({ value: z.string() }),
  description: async () => 'Fixture tool', prompt: async () => 'Fixture tool',
  userFacingName: () => name, isEnabled: () => true, isReadOnly: () => true,
  isConcurrencySafe: () => true, needsPermissions: () => false,
  call: async () => ({ data: 'ok' }),
  mapToolResultToToolResultBlockParam: (_data: unknown, id: string) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' }),
} as unknown as Tool)
const pool = [tool('CoreProbe', false), ToolSearchTool, tool('DeferredProbe', true)]
const errors: string[] = []
async function drive(messages: Message[]): Promise<any> {
  const before = bodies.length
  for await (const row of routedCallModel({
    messages, tools: pool, systemPrompt: ['Fixture assistant'], thinkingConfig: { type: 'disabled' }, signal: new AbortController().signal,
    options: { model: KIMI, getToolPermissionContext: async () => permission, isNonInteractiveSession: true, querySource: 'repl_main_thread', agents: [], mcpTools: [], hasAppendSystemPrompt: false, hasPendingMcpServers: false },
  } as never)) {
    if (row.type === 'assistant' && row.isApiErrorMessage) errors.push(JSON.stringify(row.message.content))
  }
  check('one successful chat request reaches the fixture', bodies.length === before + 1 && errors.length === 0, errors.join(' | '))
  return bodies.at(-1)
}

try {
  await catalogue.refreshMoonshotCatalogue({ force: true })
  const decoded = catalogue.decodeMoonshotModel({ id: KIMI, supports_dynamic_tools: true }) as any
  check('the live catalogue preserves its dynamic-tools capability', decoded?.supportsDynamicTools === true)
  check('the K2 coding alias reads text-append and defers', wire.deferralWireFormFor(KIMI).form === 'text-append' && wire.supportsToolDeferral(KIMI))
  check('the provider-declared unsupported highspeed alias stays nondeferring', wire.deferralWireFormFor('kimi-for-coding-highspeed').form === 'text' && !wire.supportsToolDeferral('kimi-for-coding-highspeed'))
  check('an unsupported platform K2 model stays nondeferring', !wire.supportsToolDeferral('kimi-k2.6'))
  check('the live bare K3 id is still supported through its carrier prefix', wire.supportsToolDeferral('kimi-k3'))
  check('dynamic tools do not widen K3 effort or preserved-thinking membership', !pins.kimiAcceptsEffort(KIMI, 'max') && !pins.KIMI_K3_MODELS.has(KIMI) && !pins.KIMI_PRESERVED_THINKING_MODELS.has(KIMI))
  const words = await ToolSearchTool.prompt({ model: KIMI } as never)
  check('the K2 search description says definitions append after the result', words.includes('appended to the conversation') && !words.includes('in your tool list'))
  const first = createUserMessage({ content: 'Use DeferredProbe.' }) as Message
  const names = getDeferredToolsDeltaAttachment(pool, KIMI, [first])[0]
  check('the fresh K2 transcript announces its deferred tool', names?.type === 'deferred_tools_delta' && names.addedNames.includes('DeferredProbe'))
  const opening = [first, ...(names ? normalizeAttachmentForAPI(names) : [])] as Message[]
  clearToolRosterLatches()
  const fresh = await drive(opening)
  check('the fresh tools term is the core and discovery, never the deferred schema', JSON.stringify(fresh.tools.map((row: any) => row.function.name)) === JSON.stringify(['CoreProbe', 'ToolSearch']))
  const admission = ToolSearchTool.mapToolResultToToolResultBlockParam({ matches: ['DeferredProbe'], query: 'select:DeferredProbe', total_deferred_tools: 1 } as never, 'admit')
  const transcript = [...opening,
    createAssistantMessage({ content: [{ type: 'tool_use', id: 'admit', name: 'ToolSearch', input: { query: 'select:DeferredProbe' } }] as never }),
    createUserMessage({ content: [admission] as never }),
  ] as Message[]
  const admitted = await drive(transcript)
  check('the top-level tools are byte-identical across admission', JSON.stringify(admitted.tools) === JSON.stringify(fresh.tools))
  const declarations = admitted.messages.filter((row: any) => Array.isArray(row.tools))
  const last = admitted.messages.at(-1)
  check('one complete schema row appends at the end without content', declarations.length === 1 && last === declarations[0] && last.role === 'system' && !('content' in last) && last.tools[0]?.function?.name === 'DeferredProbe' && typeof last.tools[0]?.function?.parameters === 'object')
  check('the admission record sits immediately before the schema', admitted.messages.at(-2)?.role === 'tool' && admitted.messages.at(-2)?.tool_call_id === 'admit' && admitted.messages.at(-2)?.content.includes('DeferredProbe'))
  check('the fresh message prefix is unchanged after admission', JSON.stringify(admitted.messages.slice(0, fresh.messages.length)) === JSON.stringify(fresh.messages))
  const later = await drive([...transcript, createAssistantMessage({ content: 'ok' }), createUserMessage({ content: 'continue' })] as Message[])
  check('later requests preserve both the tools term and admitted prefix', JSON.stringify(later.tools) === JSON.stringify(fresh.tools) && JSON.stringify(later.messages.slice(0, admitted.messages.length)) === JSON.stringify(admitted.messages))
  dynamic = false
  await catalogue.refreshMoonshotCatalogue({ force: true })
  check('an explicit live false overrides the alias pin', !wire.supportsToolDeferral(KIMI) && wire.deferralWireFormFor(KIMI).why === 'model-without-dynamic-tools')
  process.env.MOONSHOT_API_KEY = 'another-fixture-account'
  check('capability observations never leak to a different account', wire.supportsToolDeferral(KIMI))
} finally {
  server.closeAllConnections()
  await new Promise<void>(done => server.close(() => done()))
}
console.log(`kimi-k2-deferral: ${checked} checks, ${failed} failures`)
process.exit(failed > 0 ? 1 : 0)
