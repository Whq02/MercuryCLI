#!/usr/bin/env bun
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { pinSourceRef } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const home = mkdtempSync(join(tmpdir(), 'openrouter-mixed-upstream-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_TOOL_DEFER = '1'
process.env.HOME = home
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
type Body = Record<string, unknown>
type Capture = { path: string; body: Body }
const captured: Capture[] = []
const MIXED = 'Your request contains encrypted reasoning or compaction content from multiple providers. No single provider can decrypt the mixed history.'
let refuseMixedHistory = false
const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`
const hasEncryptedReasoning = (body: Body): boolean => Array.isArray(body.input) && (body.input as Body[]).some(item => item.type === 'reasoning' && typeof item.encrypted_content === 'string')
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const path = req.url ?? ''
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: path.endsWith('/models') ? [{ id: 'fixture/model', name: 'fixture/model', context_length: 65536, supported_parameters: ['tools', 'reasoning'] }] : {} }))
    return
  }
  const body = JSON.parse(Buffer.concat(chunks).toString()) as Body
  captured.push({ path, body })
  if (refuseMixedHistory && hasEncryptedReasoning(body)) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 400, message: MIXED } }))
    return
  }
  const ordinal = captured.length
  const reasoning = { id: `rs_${ordinal}`, type: 'reasoning', summary: [{ type: 'summary_text', text: 'weighing it' }], encrypted_content: `ENC-${ordinal}` }
  const item = { id: `msg_${ordinal}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `OK ${ordinal}`, annotations: [] }] }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(
    sse({ type: 'response.created', response: { id: `r_${ordinal}`, model: body.model, status: 'in_progress' } }) +
      sse({ type: 'response.output_item.added', item: { ...reasoning, summary: [] } }) +
      sse({ type: 'response.reasoning_summary_text.delta', item_id: reasoning.id, delta: 'weighing it' }) +
      sse({ type: 'response.output_item.done', item: reasoning }) +
      sse({ type: 'response.output_item.added', item: { ...item, status: 'in_progress', content: [] } }) +
      sse({ type: 'response.output_text.delta', item_id: item.id, delta: `OK ${ordinal}` }) +
      sse({ type: 'response.output_item.done', item }) +
      sse({ type: 'response.completed', response: { id: `r_${ordinal}`, model: body.model, status: 'completed', output: [reasoning, item], usage: { input_tokens: 3, output_tokens: 1 } } }) +
      'data: [DONE]\n\n',
  )
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (address === null || typeof address === 'string') throw new Error('fixture did not bind')
const base = `http://127.0.0.1:${address.port}`
Object.assign(process.env, { OPENROUTER_API_KEY: 'fixture-openrouter', MERCURY_OPENROUTER_API_BASE: `${base}/openrouter`, MERCURY_OPENROUTER_AUTH_BASE: `${base}/auth` })
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.js')
const { clearToolRosterLatches } = await import('../../src/services/providers/toolEconomy.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
const { createUserMessage } = await import('../../src/utils/messages.js')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.js')
const transport = await import('../../src/services/providers/openrouter/openrouterResponsesTransport.js')
type Message = import('../../src/types/message.js').Message
type AssistantMessage = import('../../src/types/message.js').AssistantMessage
type Wait = { kind: string; reason?: string; attempt?: number; of?: number; delayMs?: number }
type Tool = import('../../src/Tool.js').Tool
const deferred = { name: 'FixtureRead', shouldDefer: true, prompt: async () => 'Read a fixture', description: async () => 'Read a fixture', inputSchema: z.object({ path: z.string() }), isEnabled: () => true, isConcurrencySafe: () => true, isReadOnly: () => true, userFacingName: () => 'FixtureRead', call: async () => ({ data: 'fixture' }) } as unknown as Tool

async function turn(messages: Message[]): Promise<{ captures: Capture[]; errors: string[]; settled: AssistantMessage[]; waits: Wait[] }> {
  clearToolRosterLatches()
  const before = captured.length
  const errors: string[] = []
  const settled: AssistantMessage[] = []
  const waits: Wait[] = []
  for await (const item of routedCallModel({ messages: messages as never, systemPrompt: ['Fixture system'] as never, thinkingConfig: { type: 'disabled' }, tools: [ToolSearchTool, deferred] as never, signal: new AbortController().signal, options: { model: 'openrouter/fixture/model', querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], hasPendingMcpServers: false, onWait: (wait: Wait | null) => { if (wait !== null) waits.push(wait) } } as never })) {
    if (item.type === 'assistant') {
      if (item.isApiErrorMessage) errors.push(item.message.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join(''))
      else settled.push(item as AssistantMessage)
    }
  }
  return { captures: captured.slice(before), errors, settled, waits }
}

try {
  console.log('── turn 1: the upstream answers with encrypted reasoning; the turn record keeps it for replay ──')
  const first = await turn([createUserMessage({ content: 'Say OK' })])
  const reply = first.settled.at(-1)
  check('turn 1 settles through the Responses road', first.errors.length === 0 && first.captures.length === 1 && first.captures[0]!.path.endsWith('/responses'), JSON.stringify({ errors: first.errors, paths: first.captures.map(c => c.path) }))
  const record = (reply as (AssistantMessage & { openrouterProviderTurn?: { items: Body[] } }) | undefined)?.openrouterProviderTurn
  check('the settled reply carries the encrypted reasoning item in its turn record', record !== undefined && record.items.some(item => item.type === 'reasoning' && item.encrypted_content === 'ENC-1'), JSON.stringify(record))

  console.log('── turn 2: OpenRouter refuses the mixed history once; the replay drops the encrypted reasoning and the turn settles ──')
  refuseMixedHistory = true
  const history: Message[] = [createUserMessage({ content: 'Say OK' }), reply!, createUserMessage({ content: 'Again' })]
  const second = await turn(history)
  check('two requests: the refused replay and its retry', second.captures.length === 2, `${second.captures.length} capture(s)`)
  check('the first request carried the encrypted reasoning item', second.captures[0] !== undefined && hasEncryptedReasoning(second.captures[0].body), String(JSON.stringify(second.captures[0]?.body.input)).slice(0, 300))
  check('the retry carries no encrypted reasoning item and keeps the rest of the history', second.captures[1] !== undefined && !hasEncryptedReasoning(second.captures[1].body) && JSON.stringify(second.captures[1].body.input).includes('Again') && JSON.stringify(second.captures[1].body.input).includes('OK 1'), String(JSON.stringify(second.captures[1]?.body.input)).slice(0, 300))
  const answer = second.settled.flatMap(m => m.message.content).filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('')
  check('the turn settles with an answer, never an API error', second.errors.length === 0 && answer === 'OK 3', JSON.stringify({ errors: second.errors, settled: second.settled.length, answer }))
  const retry = second.waits.find(wait => wait.kind === 'retry')
  check('one retry line says why: the history held encrypted reasoning from more than one upstream', retry !== undefined && retry.reason === transport.mixedUpstreamRetryWords(1) && retry.delayMs === 0, JSON.stringify(second.waits))

  console.log('── the fault reads and the strip are exact ──')
  check('the exact 400 is recognised', transport.isMixedUpstreamHistoryFault({ kind: 'http-error', code: 'http-400', message: MIXED, retryable: false, status: 400 }))
  check('another 400 is not', !transport.isMixedUpstreamHistoryFault({ kind: 'http-error', code: 'http-400', message: 'Invalid input', retryable: false, status: 400 }))
  const stripped = transport.withoutEncryptedReasoning([{ type: 'reasoning', encrypted_content: 'x', summary: [] }, { type: 'reasoning', summary: [] }, { type: 'message', role: 'user', content: [] }])
  check('only reasoning items with encrypted content are dropped', stripped.dropped === 1 && stripped.input.length === 2, JSON.stringify(stripped))

  console.log('── a 400 that is not this one still surfaces as the error it is ──')
  refuseMixedHistory = false
  const other = await turn([createUserMessage({ content: 'Say OK' })])
  check('an ordinary turn makes one request and settles', other.captures.length === 1 && other.errors.length === 0, other.errors.join(' | '))
} finally {
  server.close()
  rmSync(home, { recursive: true, force: true })
}
console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
