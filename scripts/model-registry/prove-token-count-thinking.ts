#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const key of [
  'https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY',
  'MERCURY_API_UNIX_SOCKET', 'MERCURY_CLIENT_CERT', 'MERCURY_CLIENT_KEY',
  'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN',
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
  const { setEngineModelOverride } = await import('../../src/bootstrap/state.js')
  const { countMessagesTokensWithAPI, countTokensViaHaikuFallback } = await import('../../src/services/tokenEstimation.js')
  const { getEngineModel, normalizeModelStringForAPI } = await import('../../src/utils/model/model.js')
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
    setEngineModelOverride(setting)
    const raw = getEngineModel()
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

  setEngineModelOverride('claude-sonnet-5-5')
  const before = seen.length
  const fallback = await countTokensViaHaikuFallback(history({ type: 'thinking', thinking: 'A short plan.', signature: 'fixture-signature' }), [])
  const hit = seen.at(-1)
  check('the Haiku fallback stays on the create endpoint with its 1024-token budget', seen.length === before + 1 && hit?.path === '/v1/messages' && hit.body.model === 'claude-haiku-4-5-20251001' && show(hit.body.thinking) === show(budget) && fallback === 37, hit)

  const { assembleTurnSystemPrompt, buildSystemPromptBlocks, buildTurnSystemBlocks } = await import('../../src/services/providers/anthropic/cacheAndUsage.js')
  const { getAttributionHeader, getCLISyspromptPrefix } = await import('../../src/constants/system.js')
  const { asSystemPrompt } = await import('../../src/utils/systemPromptType.js')
  const { computeFingerprintFromMessages } = await import('../../src/utils/fingerprint.js')
  const { createUserMessage } = await import('../../src/utils/messages.js')
  const { countTokensWithAPI } = await import('../../src/services/tokenEstimation.js')
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const attribution = getAttributionHeader(computeFingerprintFromMessages([createUserMessage({ content: 'Say OK.' })]))
  const posture = { isNonInteractive: false, hasAppendSystemPrompt: false }
  const session = asSystemPrompt(['# Session\nA session prompt for the count proof.', 'A second part.'])
  const turnBlocks = buildTurnSystemBlocks(attribution, session, posture, true)
  check('the shared builder assembles the attribution line, the CLI prefix for the posture, then the session prompt, and marks the cached blocks as the stream always did', show(turnBlocks) === show(buildSystemPromptBlocks(asSystemPrompt([attribution, getCLISyspromptPrefix(posture), ...session]), true)) && turnBlocks.length === 3 && turnBlocks[0]!.text === attribution && turnBlocks[1]!.text === getCLISyspromptPrefix(posture) && !('cache_control' in turnBlocks[0]!) && 'cache_control' in turnBlocks[1]! && 'cache_control' in turnBlocks[2]!, turnBlocks.map(block => Object.keys(block)))
  check('an empty attribution line drops out of the join, as the stream\'s own filter did', show(assembleTurnSystemPrompt('', session, posture)) === show([getCLISyspromptPrefix(posture), ...session]))
  const streamCore = readFileSync(join(import.meta.dir, '..', '..', 'src', 'services', 'providers', 'anthropic', 'streamCore.ts'), 'utf8')
  check('the main stream assembles its system prompt through the shared owner and nowhere else (one spelling)', streamCore.includes('assembleTurnSystemPrompt(attribution, sessionSystemPrompt, posture)') && !streamCore.includes('systemPromptBody') && !streamCore.includes('getCLISyspromptPrefix('))
  const withSystemBefore = seen.length
  const counted = await countMessagesTokensWithAPI(history({ type: 'thinking', thinking: 'A short plan.', signature: 'fixture-signature' }), tools, turnBlocks)
  const carried = seen.at(-1)
  check('the count body carries the shared builder\'s system blocks byte-for-byte, beside the history and tools (base: no system field at all)', seen.length === withSystemBefore + 1 && carried?.path === '/v1/messages/count_tokens' && show((carried.body as { system?: unknown }).system) === show(turnBlocks) && show(carried.body.tools) === show(tools) && counted === 37, carried?.body)
  const bareBefore = seen.length
  await countMessagesTokensWithAPI(history(), tools)
  check('a count given no system blocks sends no system field', seen.length === bareBefore + 1 && !Object.hasOwn(seen.at(-1)!.body, 'system'), seen.at(-1)?.body)
  const emptyBefore = seen.length
  await countMessagesTokensWithAPI(history(), tools, [])
  check('an empty block list sends no system field either', seen.length === emptyBefore + 1 && !Object.hasOwn(seen.at(-1)!.body, 'system'), seen.at(-1)?.body)
  const stringBefore = seen.length
  const stringCount = await countTokensWithAPI('a file body '.repeat(50))
  check('the no-session string counter (the file-read cap\'s road) counts one user message with no system field and no tools', seen.length === stringBefore + 1 && stringCount === 37 && !Object.hasOwn(seen.at(-1)!.body, 'system') && seen.at(-1)!.body.messages.length === 1 && show(seen.at(-1)!.body.tools) === show([]), seen.at(-1)?.body)
} finally {
  if (origin.listening) await new Promise<void>(resolve => origin.close(() => resolve()))
  rmSync(home, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL TOKEN-COUNT THINKING PROOFS PASS' : `\nFAIL — ${failures} token-count thinking check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
