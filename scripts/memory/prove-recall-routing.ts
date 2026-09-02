#!/usr/bin/env bun
// ============================================================================
//  scripts/memory/prove-recall-routing.ts
//  PROOF (lane CP-B, the re-plumb): model-judged recall rides the SESSION
//  FAMILY through the routing law — never the old Anthropic-only sideQuery
//  wire. Driven end-to-end against a scripted loopback (every provider base
//  pinned; nothing reaches a live host): seeded store → recall fires → the
//  right file surfaces, with the wire request captured per family.
//
//    §1 anthropic session: the selector call lands on the ANTHROPIC dialect
//       (/v1/messages) carrying the sonnet-class LIGHT owner — the same id
//       the old direct call named (unchanged by construction) — and the
//       relevant file surfaces, distractors stay down.
//    §2 openai session: the call lands on the family's OWN wire
//       (/responses), model = the openai LIGHT fact (grammar-derived pin,
//       never an Anthropic id), and a fenced/prose-wrapped selection still
//       decodes (the tolerant ladder) — the relevant file surfaces.
//    §3 a signed-out family degrades HONESTLY: recall answers empty, and no
//       request crosses to another family's wire (no silent fallback).
//    §4 source pins: the caller carries sessionLightModel + the routed
//       settle; the sideQuery/getDefaultSonnetModel residue is gone.
//
//  Run:  ~/.bun/bin/bun run scripts/memory/prove-recall-routing.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const watchdog = setTimeout(() => {
  console.log('FATAL: prover watchdog (150s) — treat as failure')
  process.exit(1)
}, 150_000)
watchdog.unref?.()
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const scratch = mkdtempSync(join(tmpdir(), 'mercury-recall-route-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
delete process.env.ANTHROPIC_MODEL
delete process.env.ANTHROPIC_SMALL_FAST_MODEL

// ── the seeded store (scratch — never a real memory home) ──────────────────
const memoryDir = join(scratch, 'memdir')
mkdirSync(memoryDir, { recursive: true })
const seedCard = (name: string, description: string, body: string): void => {
  writeFileSync(
    join(memoryDir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${description}\ntype: project\n---\n\n${body}\n`,
  )
}
seedCard('undici-pairing', 'undici dispatcher pairing causes fetch failed on node', 'Pair via getApiFetch().')
seedCard('release-cadence', 'the release train departs fridays', 'Tags signed by ops.')
seedCard('grafana-boards', 'latency dashboards live on the api-latency board', 'External reference.')
writeFileSync(join(memoryDir, 'MEMORY.md'), '- [undici pairing](undici-pairing.md) — wire gotcha\n')

// ── the scripted two-dialect fixture ───────────────────────────────────────
type Body = Record<string, unknown>
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const anthropicSse = (text: string): string =>
  [
    `event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  ].join('')
const responsesSse = (text: string): string =>
  [
    sse({ type: 'response.created', response: { id: 'resp_fx' } }),
    sse({ type: 'response.output_text.delta', delta: text }),
    sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }),
    sse({ type: 'response.completed', response: { id: 'resp_fx', usage: { input_tokens: 6, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } } } }),
  ].join('')

// The fixture SELECTS like the mechanism under proof expects: any manifest
// filename whose row mentions the query key surfaces. The anthropic leg
// answers bare JSON; the openai leg wraps it in prose + fences so the
// tolerant decode ladder is the thing that passes. Request bodies differ
// per dialect, so the walker collects every string leaf and the row regex
// runs over the joined text (the manifest is one leaf with real newlines).
const collectStrings = (value: unknown, out: string[] = []): string[] => {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collectStrings(v, out)
  return out
}
const pickFromManifest = (body: Body): string[] => {
  const text = collectStrings(body).join('\n')
  const picked: string[] = []
  for (const line of text.split('\n')) {
    const row = /^- (?:\[[a-z]+\] )?(\S+\.md) \(/.exec(line)
    if (row?.[1] && line.includes('undici')) picked.push(row[1])
  }
  return picked
}
const captured: Array<{ path: string; body: Body }> = []
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    let body: Body = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body
    } catch {
      body = {}
    }
    if (req.method === 'POST' && path.endsWith('/v1/messages')) {
      captured.push({ path, body })
      const picked = pickFromManifest(body)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(anthropicSse(JSON.stringify({ selected_memories: picked })))
      return
    }
    if (req.method === 'POST' && path.endsWith('/responses')) {
      captured.push({ path, body })
      const picked = pickFromManifest(body)
      const wrapped = `Here is my selection:\n\`\`\`json\n${JSON.stringify({ selected_memories: picked })}\n\`\`\`\nHope that helps.`
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(responsesSse(wrapped))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address ? address.port : 0
const base = `http://127.0.0.1:${port}`
Object.assign(process.env, {
  ANTHROPIC_BASE_URL: base,
  ANTHROPIC_AUTH_TOKEN: 'fixture-token',
  MERCURY_LOCAL_BASE_URL: base,
  MERCURY_MOONSHOT_API_BASE: `${base}/moonshot/v1`,
  MERCURY_MOONSHOT_OAUTH_BASE: `${base}/moonshot/oauth`,
  MERCURY_DEEPSEEK_API_BASE: `${base}/deepseek`,
  MERCURY_ZAI_API_BASE: `${base}/zai/v4`,
  MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
  MERCURY_OPENAI_CHATGPT_BASE: `${base}/openai/chatgpt`,
  MERCURY_OPENAI_AUTH_BASE: `${base}/openai/auth`,
  OPENAI_API_KEY: 'fixture-openai-key',
  MERCURY_COMPAT_BASE_URL: `${base}/v1`,
  MERCURY_OPENROUTER_API_BASE: `${base}/openrouter/api/v1`,
  MERCURY_OPENROUTER_AUTH_BASE: `${base}/openrouter/auth`,
  MERCURY_GEMINI_API_BASE: `${base}/gemini/v1beta`,
  MERCURY_GEMINI_OAUTH_AUTH_BASE: `${base}/gemini/oauth/auth`,
  MERCURY_GEMINI_OAUTH_TOKEN_BASE: `${base}/gemini/oauth/token`,
  MERCURY_HUGGINGFACE_API_BASE: `${base}/hf/v1`,
  MERCURY_HUGGINGFACE_HUB_BASE: `${base}/hf/hub`,
})

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { findRelevantMemories } = await import('../../src/memdir/findRelevantMemories.js')
const { getDefaultSonnetModel, normalizeModelStringForAPI } = await import('../../src/utils/model/model.js')
const { providerLightFact } = await import('../../src/utils/model/providerFrontier.js')

console.log('============================================================')
console.log(' recall rides the session family — driven routing proof')
console.log('============================================================')

const QUERY = 'why does fetch fail with the undici dispatcher on node'

section('§1 anthropic session → the anthropic dialect, sonnet-class light owner')
{
  process.env.ANTHROPIC_MODEL = 'claude-opus-5'
  const before = captured.length
  const got = await findRelevantMemories(QUERY, memoryDir, new AbortController().signal)
  const hit = captured[before]
  check('exactly one wire call fired', captured.length === before + 1, String(captured.length - before))
  check('it landed on /v1/messages (the anthropic dialect)', hit?.path.endsWith('/v1/messages') === true, hit?.path)
  const wireModel = String(hit?.body.model ?? '')
  const expected = normalizeModelStringForAPI(getDefaultSonnetModel())
  check('the wire model is the sonnet-class light owner (unchanged by construction)', wireModel === expected, `${wireModel} vs ${expected}`)
  check('the relevant file surfaced', got.length === 1 && got[0]!.path.endsWith('undici-pairing.md'), JSON.stringify(got.map(g => g.path)))
}

section('§2 openai session → the family\'s OWN wire, light fact, tolerant decode')
{
  process.env.ANTHROPIC_MODEL = 'gpt-5.6-sol'
  const before = captured.length
  const got = await findRelevantMemories(QUERY, memoryDir, new AbortController().signal)
  const hit = captured[before]
  check('exactly one wire call fired', captured.length === before + 1, String(captured.length - before))
  check('it landed on /responses (the openai dialect — no cross-family hop)', hit?.path.endsWith('/responses') === true, hit?.path)
  const wireModel = String(hit?.body.model ?? '')
  const light = providerLightFact('openai')?.modelId ?? '(none)'
  check('the wire model is the openai LIGHT fact (grammar-derived, never an Anthropic id)', wireModel === light && !wireModel.startsWith('claude'), `${wireModel} vs ${light}`)
  check('the fenced/prose-wrapped selection still decoded (tolerant ladder)', got.length === 1 && got[0]!.path.endsWith('undici-pairing.md'), JSON.stringify(got.map(g => g.path)))
}

section('§3 a signed-out family degrades honestly — empty, no cross-family fallback')
{
  process.env.ANTHROPIC_MODEL = 'glm-4.7'
  delete process.env.ZAI_API_KEY
  const before = captured.length
  const got = await findRelevantMemories(QUERY, memoryDir, new AbortController().signal)
  check('recall answered empty (honest degradation)', got.length === 0, JSON.stringify(got))
  const crossed = captured.slice(before).filter(c => c.path.endsWith('/v1/messages') || c.path.endsWith('/responses'))
  check('no request crossed to another family\'s wire', crossed.length === 0, JSON.stringify(crossed.map(c => c.path)))
}

section('§4 source pins — the re-plumb is structural')
{
  const src = readFileSync(join(import.meta.dir, '..', '..', 'src', 'memdir', 'findRelevantMemories.ts'), 'utf8')
  check('rides sessionLightModel', src.includes('sessionLightModel()'))
  check('rides the routed settle', src.includes('routedCallModelSettled'))
  check('no sideQuery residue', !src.includes("from '../utils/sideQuery") && !src.includes('sideQuery('))
  check('no getDefaultSonnetModel residue', !src.includes('getDefaultSonnetModel'))
  check('the decode is the shared tolerant ladder', src.includes('decodeModelJson'))
}

server.close()
delete process.env.ANTHROPIC_MODEL
console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ ALL RECALL-ROUTING PROOFS PASS' : `❌ ${failures} RECALL-ROUTING CHECK(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
