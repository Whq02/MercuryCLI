import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pdfFixture, textPage } from './fixtures.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'mistral-pdf-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_BARE = '1'
process.env.MISTRAL_API_KEY = 'fixture-key-ci-gate-not-a-real-key'
const captured: any[] = []
const model = 'mistral-small-latest'
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  if (new URL(request.url).pathname === '/v1/models') return Response.json({ data: [{ id: model, capabilities: { completion_chat: true, function_calling: true, vision: true }, max_context_length: 262144 }] })
  assert.equal(new URL(request.url).pathname, '/v1/chat/completions')
  const body = await request.json()
  captured.push(body)
  return new Response(`data: ${JSON.stringify({ id: 'mistral-pdf-answer', model, choices: [{ index: 0, delta: { role: 'assistant', content: 'Paper read.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 29, completion_tokens: 4, total_tokens: 33 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
} })
process.env.MERCURY_MISTRAL_API_BASE = `${server.url}v1`
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { modelSupportsPDF } = await import('../../src/utils/model/capabilities.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const data = pdfFixture([textPage('Mistral PDF fixture')]).toString('base64')
const user = { type: 'user', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'Read this paper.' }, { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }] } }
try {
  assert.equal(modelSupportsPDF(model), true)
  assert.equal(modelSupportsPDF('compat/mistral-small-latest'), false)
  const replies: any[] = []
  for await (const item of routedCallModel({ messages: [user], systemPrompt: asSystemPrompt(['Read the supplied document.']), thinkingConfig: { type: 'adaptive' }, tools: [], signal: new AbortController().signal, options: { model, effortValue: 'high', querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], maxOutputTokensOverride: 8192 } } as never)) if (item.type === 'assistant') replies.push(item)
  assert.equal(captured.length, 1)
  const body = captured[0]
  assert.equal(body.model, model)
  const parts = body.messages.filter((m: any) => m.role === 'user').flatMap((m: any) => m.content)
  assert.ok(parts.some((p: any) => p.type === 'document_url' && p.document_url === `data:application/pdf;base64,${data}`))
  assert.ok(!parts.some((p: any) => p.type === 'file'))
  assert.equal(body.reasoning_effort, 'high')
  assert.equal(body.max_tokens, 8192)
  assert.ok(replies.some(r => r.message.content.some((b: any) => b.type === 'text' && b.text === 'Paper read.')))
  assert.equal(replies.at(-1).message.usage.output_tokens, 4)
  console.log('PASS routed Mistral native PDF: account catalogue, chat endpoint, document_url bytes, effort/output budget, completion and usage')
} finally { server.stop(true); rmSync(home, { recursive: true, force: true }) }
