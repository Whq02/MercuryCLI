#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const key of [
  'https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY',
  'MERCURY_API_UNIX_SOCKET', 'MERCURY_CLIENT_CERT', 'MERCURY_CLIENT_KEY',
  'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'MERCURY_OAUTH_TOKEN',
  'MERCURY_API_KEY_FILE_DESCRIPTOR', 'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'MERCURY_PROVIDER_HEADERS', 'MERCURY_WIRE_DUMP', 'MERCURY_BARE',
  'MERCURY_MODEL', 'MERCURY_SMALL_FAST_MODEL',
  'MERCURY_DEFAULT_OPUS_MODEL', 'MERCURY_DEFAULT_SONNET_MODEL',
  'MERCURY_DEFAULT_FABLE_MODEL', 'MERCURY_DEFAULT_HAIKU_MODEL',
  'MERCURY_CUSTOM_MODEL_OPTION', 'MERCURY_DISABLE_1M_CONTEXT',
  'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY',
  'GEMINI_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN',
]) delete process.env[key]
delete process.env.NODE_ENV
const home = mkdtempSync(join(tmpdir(), 'token-count-thinking-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_HOME = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-not-a-real-key'

let failures = 0
function check(label: string, condition: boolean, detail?: unknown): void {
  if (!condition) failures++
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${label}${!condition && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`)
}
const show = (value: unknown): string => JSON.stringify(value)
type Body = { model: string; messages: Array<{ role: string; content: unknown }>; thinking?: unknown; tools?: unknown }
const seen: Array<{ method: string; path: string; body: Body }> = []
const origin = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', chunk => chunks.push(chunk as Buffer))
  req.on('end', () => {
    seen.push({ method: req.method ?? '', path: (req.url ?? '').split('?')[0]!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ input_tokens: 37, id: 'msg_fixture', type: 'message', role: 'assistant', content: [], model: 'claude-haiku-4-5-20251001', stop_reason: 'end_turn', usage: { input_tokens: 37, output_tokens: 1 } }))
  })
})

try {
  const port = await new Promise<number>(resolve => {
    origin.listen(0, '127.0.0.1', () => {
      const address = origin.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`
  ;(await import('../../src/utils/config.js')).enableConfigs()
  const { setMainLoopModelOverride } = await import('../../src/bootstrap/state.js')
  const { countMessagesTokensWithAPI, countTokensViaHaikuFallback } = await import('../../src/services/tokenEstimation.js')
  const { getMainLoopModel, normalizeModelStringForAPI } = await import('../../src/utils/model/model.js')
  const { modelSupportsAdaptiveThinking } = await import('../../src/utils/thinking.js')

  const tools = [{ name: 'proof_tool', description: 'A count-only fixture tool.', input_schema: { type: 'object', properties: {} } }]
  const history = (block?: Record<string, unknown>) => [
    { role: 'user', content: 'Say OK.' },
    { role: 'assistant', content: [...(block ? [block] : []), { type: 'text', text: 'OK' }] },
    { role: 'user', content: 'Continue.' },
  ]
  const budget = { type: 'enabled', budget_tokens: 1024 }
  const adaptive = { type: 'adaptive' }
  const models: Array<[string, typeof adaptive | typeof budget]> = [
    ['claude-sonnet-5-5', adaptive],
    ['claude-opus-5-5', adaptive],
    ['claude-opus-5', adaptive],
    ['claude-sonnet-5', adaptive],
    ['claude-fable-5', adaptive],
    ['claude-fable-5-1', adaptive],
    ['claude-haiku-4-5-20251001', budget],
    ['claude-sonnet-5-5[1m]', adaptive],
    ['claude-haiku-4-5-20251001[1m]', budget],
    ['sonnet', adaptive],
  ]
  for (const [setting, expected] of models) {
    setMainLoopModelOverride(setting)
    const raw = getMainLoopModel()
    const wire = normalizeModelStringForAPI(raw)
    check(`${setting}: raw and wire ids agree at the thinking gate`, modelSupportsAdaptiveThinking(raw) === modelSupportsAdaptiveThinking(wire))
    for (const block of [
      { type: 'thinking', thinking: 'A short plan.', signature: 'fixture-signature' },
      { type: 'redacted_thinking', data: 'fixture-redacted-thinking' },
      undefined,
    ]) {
      const label = `${setting} / ${block?.type ?? 'no thinking'}`
      const before = seen.length
      const count = await countMessagesTokensWithAPI(history(block), tools)
      const hit = seen.at(-1)
      check(`${label}: one count request returns the exact count`, seen.length === before + 1 && hit?.method === 'POST' && hit.path === '/v1/messages/count_tokens' && count === 37, { hits: seen.length - before, path: hit?.path, count })
      check(`${label}: the wire carries the normalized model`, hit?.body.model === wire && !wire.includes('['), hit?.body.model)
      check(`${label}: thinking is ${show(block ? expected : 'absent')}`, block ? show(hit?.body.thinking) === show(expected) : hit !== undefined && !Object.hasOwn(hit.body, 'thinking'), hit?.body)
      check(`${label}: history and tools survive the counter`, show(hit?.body.messages) === show(history(block)) && show(hit?.body.tools) === show(tools), hit?.body)
    }
  }

  setMainLoopModelOverride('claude-sonnet-5-5')
  const before = seen.length
  const fallback = await countTokensViaHaikuFallback(history({ type: 'thinking', thinking: 'A short plan.', signature: 'fixture-signature' }), [])
  const hit = seen.at(-1)
  check('the Haiku fallback stays on the create endpoint with its 1024-token budget', seen.length === before + 1 && hit?.path === '/v1/messages' && hit.body.model === 'claude-haiku-4-5-20251001' && show(hit.body.thinking) === show(budget) && fallback === 37, hit)
} finally {
  if (origin.listening) await new Promise<void>(resolve => origin.close(() => resolve()))
  rmSync(home, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL TOKEN-COUNT THINKING PROOFS PASS' : `\nFAIL — ${failures} token-count thinking check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
