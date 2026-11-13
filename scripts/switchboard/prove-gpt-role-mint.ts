#!/usr/bin/env bun
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures = 1
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const scratch = mkdtempSync(join(tmpdir(), 'gpt-role-mint-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  process.env[spelling] = home
}
for (const key of ['ANTHROPIC_API_KEY', 'MERCURY_OAUTH_TOKEN', 'ZAI_API_KEY']) {
  delete process.env[key]
}
delete process.env.NODE_ENV
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CREW_DIR = join(scratch, 'crew')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.ANTHROPIC_AUTH_TOKEN = 'fixture-token'
process.env.MERCURY_OPENAI_CHATGPT_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_OPENAI_AUTH_BASE = 'http://127.0.0.1:1'
process.env.OPENAI_API_KEY = 'sk-fixture-coordinator-mint'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

type Captured = { url: string; body?: Record<string, unknown> }
const captured: Captured[] = []
const MODELS_BODY = {
  models: [
    {
      slug: 'gpt-5.6-sol',
      display_name: 'GPT-5.6-Sol',
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast responses with lighter reasoning' },
        { effort: 'medium', description: 'Balances speed and reasoning depth' },
        { effort: 'high', description: 'Greater reasoning depth' },
      ],
      default_reasoning_level: 'low',
      visibility: 'list',
      priority: 1,
      context_window: 272_000,
      input_modalities: ['text', 'image'],
      supported_in_api: true,
    },
  ],
}
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const responsesSse = (): string =>
  [
    sse({ type: 'response.created', response: { id: 'resp_mint_1' } }),
    sse({ type: 'response.output_text.delta', delta: 'ok' }),
    sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } }),
    sse({ type: 'response.completed', response: { id: 'resp_mint_1', usage: { input_tokens: 12, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } } }),
  ].join('')

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const url = req.url ?? ''
    let body: Record<string, unknown> | undefined
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    } catch {
      body = undefined
    }
    if (req.method === 'GET' && url.startsWith('/models')) {
      captured.push({ url })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(MODELS_BODY))
      return
    }
    if (req.method === 'POST' && url === '/responses') {
      captured.push({ url, body })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(responsesSse())
      return
    }
    captured.push({ url })
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address ? address.port : 0
process.env.MERCURY_OPENAI_API_BASE = `http://127.0.0.1:${port}`

console.log('============================================================')
console.log(' the role mint — a settled GPT turn qualifies the row of the role it ran in')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const q = await import('../../src/services/providers/openai/qualificationStore.ts')
const { MERCURY_CONSTITUTION } = await import('../../src/prompt/mercuryContract.ts')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

const MODEL = 'gpt-5.6-sol'
const receiptsOf = () => q.readQualificationReceipts().filter(r => r.receipt.modelId === MODEL)
const sideQuestion = async (): Promise<void> => {
  const stream = routedCallModel({
    messages: [createUserMessage({ content: 'say ok' })],
    systemPrompt: asSystemPrompt([MERCURY_CONSTITUTION]),
    thinkingConfig: { type: 'disabled' },
    tools: [] as never,
    signal: AbortSignal.timeout(30_000),
    options: {
      model: MODEL,
      querySource: 'side_question',
      agents: [],
      isNonInteractiveSession: true,
      hasAppendSystemPrompt: false,
      mcpTools: [],
      maxOutputTokensOverride: 64,
      enablePromptCaching: false,
      async getToolPermissionContext() {
        return getEmptyToolPermissionContext()
      },
    } as never,
  })
  for await (const _event of stream) {
  }
}

section('§1 — before any turn the store holds no receipt for the model')
{
  check('no receipt yet', receiptsOf().length === 0, JSON.stringify(receiptsOf().map(r => r.receipt.role)))
}

section("§2 — a side question settles against the fixture and mints 'primary'")
{
  const before = captured.length
  await sideQuestion()
  const responses = captured.slice(before).filter(c => c.url === '/responses')
  check('exactly ONE Responses call settled the turn', responses.length === 1, String(responses.length))
  check('the wire carries the exact model id', responses[0]?.body?.model === MODEL, String(responses[0]?.body?.model))
  const minted = receiptsOf()
  check("ONE receipt for the model, in the role 'primary'", minted.length === 1 && minted[0]?.receipt.role === 'primary', JSON.stringify(minted.map(r => r.receipt.role)))
  check('…CURRENT under the live digests', minted[0]?.current === true, JSON.stringify(minted[0]))
}

section('§3 — a second settled turn in the same role replaces its row, never doubles it')
{
  await sideQuestion()
  const minted = receiptsOf()
  check("still ONE receipt, still 'primary'", minted.length === 1 && minted[0]?.receipt.role === 'primary', JSON.stringify(minted.map(r => r.receipt.role)))
}

server.close()
removeScratch(scratch)
console.log(failures === 0 ? '\n✅ prove-gpt-role-mint — all checks pass' : '\n❌ prove-gpt-role-mint — FAILED')
process.exit(failures)
