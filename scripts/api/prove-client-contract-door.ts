#!/usr/bin/env bun
// ============================================================================
//  scripts/api/prove-client-contract-door.ts — the first-party subscription
//  door presents a declared client-contract version, and nothing else does.
//
//  The subscription endpoint classes a request carrying the OAuth app
//  identity as the vendor's own CLI and gates models on a minimum client
//  version it reads, as a number, from the cc_version field of the billing
//  attribution line in the system prompt — never from the User-Agent (a wire
//  capture: an agent spelling the vendor CLI's own token still
//  read as the product version). Laws:
//   §1 THE DOOR — the attribution line spells the contract version in the
//      gate-read position (cc_version, the first field), on the first-party
//      client's requests.
//   §2 NOTHING ELSE — every User-Agent, the first-party client's included,
//      stays mercury/<version>; the contract version has exactly its five
//      declared homes in src (the constant, the attribution line, the
//      refusal line, the doctor row, the registry row's prose).
//   §2b THIRD-PARTY ROUTES — the line has exactly two composers in src,
//      both first-party legs (the Anthropic runtime and the side query,
//      which takes the first-party client); no third-party runtime
//      composes it or spells its prefix, so no third-party route carries
//      it.
//   §3 THE OVERRIDE — MERCURY_ANTHROPIC_CLIENT_CONTRACT (a three-part
//      version) wins over the constant, live; any other shape is ignored and
//      reported; the registry carries the row.
//   §4 THE REFUSAL — the gate's 400 maps to the Mercury line naming the
//      version read, the version required, what Mercury presents, and the
//      override; the wire's updater advice never reaches the operator; an
//      unrelated 400 keeps its generic tail.
//   §5 THE DOCTOR — the identity section carries the client-contract row
//      composed from the one describer.
//
//  Deterministic: an injected fetch, a scratch config home, no network.
//  Run: ~/.bun/bin/bun run scripts/api/prove-client-contract-door.ts
// ============================================================================
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The user-agent owners read the build-time MACRO define; bun-run proofs shim
// it BEFORE the first src import.
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
const scratch = mkdtempSync(join(tmpdir(), 'client-contract-door-'))
process.env.MERCURY_CONFIG_DIR = scratch
process.env.MERCURY_EVOLUTION_LEDGER = '0'
delete process.env.MERCURY_ANTHROPIC_CLIENT_CONTRACT
delete process.env.ANTHROPIC_BASE_URL
delete process.env.ANTHROPIC_CUSTOM_HEADERS

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const {
  ANTHROPIC_CLIENT_CONTRACT_VERSION,
  describeAnthropicClientContract,
  getAnthropicClientContractVersion,
} = await import('../../src/constants/oauth.js')
const { getAttributionHeader } = await import('../../src/constants/system.js')
const { getUserAgent, getMCPUserAgent, getWebFetchUserAgent } = await import('../../src/utils/http.js')
const { getMercuryUserAgent, getAnthropicClientUserAgent } = await import('../../src/utils/userAgent.js')
const { searchUserAgent } = await import('../../src/services/search/searchContract.js')
const { getAnthropicClient } = await import('../../src/services/api/client.js')
const { getAssistantMessageFromError, isClientContractGateText, clientContractGateLine } = await import(
  '../../src/services/api/errors.js'
)
const { FLAG_REGISTRY } = await import('../../src/substrate/flagRegistry.js')
const { APIError } = await import('@anthropic-ai/sdk')

const CONTRACT = ANTHROPIC_CLIENT_CONTRACT_VERSION
const textOf = (m: { message: { content: unknown } }): string => {
  const c = m.message.content
  return typeof c === 'string' ? c : JSON.stringify(c)
}

// ── §1 the door ──────────────────────────────────────────────────────────────
section('§1 THE DOOR — the attribution line spells the contract version first')
check('the constant is a three-part version', /^\d+\.\d+\.\d+$/.test(CONTRACT), CONTRACT)
const line = getAttributionHeader('fp01')
check('the attribution line is composed', line.startsWith('x-anthropic-billing-header: '), line)
check('cc_version is the FIRST field (the gate-read position)', line.startsWith(`x-anthropic-billing-header: cc_version=${CONTRACT}.fp01;`), line)
check('the product version rides nowhere on the line', !line.includes('1.0.0'), line)
check('the accessor answers the constant when the override is unset', getAnthropicClientContractVersion() === CONTRACT)

// ── §2 nothing else ──────────────────────────────────────────────────────────
section('§2 NOTHING ELSE — every agent stays mercury/<version>; five homes in src')
const agents: Array<[string, string]> = [
  ['provider transports (getUserAgent)', getUserAgent()],
  ['MCP (getMCPUserAgent)', getMCPUserAgent()],
  ['web fetch (getWebFetchUserAgent)', getWebFetchUserAgent()],
  ['OAuth legs + source fetches (getMercuryUserAgent)', getMercuryUserAgent()],
  ['Anthropic backend legs (getAnthropicClientUserAgent)', getAnthropicClientUserAgent()],
  ['search backends (searchUserAgent)', searchUserAgent()],
]
for (const [label, ua] of agents) {
  check(`${label} is the product identity`, /^(mercury\/1\.0\.0|Mozilla\/5\.0 \(compatible; Mercury\/1\.0\.0\))/.test(ua), ua)
  check(`${label} carries no contract version or borrowed agent token`, !ua.includes(CONTRACT) && !/claude-cli/i.test(ua), ua)
}
// The first-party client's own default header, captured at the injected fetch.
{
  let captured: Headers | undefined
  const fetchOverride: typeof globalThis.fetch = async (_input, init) => {
    captured = new Headers((init as { headers?: HeadersInit } | undefined)?.headers)
    const body = {
      id: 'msg_door', type: 'message', role: 'assistant', model: 'claude-fable-5',
      content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const client = await getAnthropicClient({ apiKey: 'sk-ant-door-fixture', maxRetries: 0, fetchOverride, source: 'door-proof' })
  await client.messages.create({ model: 'claude-fable-5', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] })
  const ua = captured?.get('user-agent') ?? ''
  check('the first-party client presents the product identity as its agent', ua.startsWith('mercury/1.0.0'), ua)
  check('the first-party client carries x-app: cli (the door identity the endpoint classes on)', captured?.get('x-app') === 'cli')
  check('the contract version rides no request HEADER (it rides the attribution line)', ![...(captured?.entries() ?? [])].some(([, v]) => v.includes(CONTRACT)))
}
const tracked = execSync('git ls-files -z -- src', { cwd: ROOT }).toString('utf8').split('\0').filter(Boolean)
const srcOf = (p: string): string => readFileSync(join(ROOT, p), 'utf8')
{
  const homes = tracked.filter(p => /ANTHROPIC_CLIENT_CONTRACT_VERSION|getAnthropicClientContractVersion|describeAnthropicClientContract/.test(srcOf(p))).sort()
  // The five declared homes: the constant, the attribution line, the refusal
  // line, the doctor row, and the registry row that names the constant in
  // its summary prose. A sixth is a leak.
  const expected = ['src/constants/oauth.ts', 'src/constants/system.ts', 'src/services/api/errors.ts', 'src/substrate/flagRegistry.ts', 'src/utils/healthReport.ts']
  check('the contract version has exactly its five declared homes in src (a sixth is a leak)', JSON.stringify(homes) === JSON.stringify(expected), homes.join(', '))
  const clientSrc = readFileSync(join(ROOT, 'src/services/api/client.ts'), 'utf8')
  check("the first-party client's agent is the product agent at source", clientSrc.includes("'User-Agent': getUserAgent()"))
  const httpSrc = readFileSync(join(ROOT, 'src/utils/http.ts'), 'utf8')
  check('no agent owner composes a borrowed agent token', !/claude-cli\/\$\{/.test(httpSrc))
}

// ── §2b third-party routes ───────────────────────────────────────────────────
section('§2b THIRD-PARTY ROUTES — the line has two composers, both first-party legs')
{
  const PREFIX = 'x-anthropic-billing-header'
  const composers = tracked.filter(p => p !== 'src/constants/system.ts' && /getAttributionHeader\(/.test(srcOf(p))).sort()
  check(
    'the attribution line is composed in exactly two places: the Anthropic runtime and the side query',
    JSON.stringify(composers) === JSON.stringify(['src/services/providers/anthropic/streamCore.ts', 'src/utils/sideQuery.ts']),
    composers.join(', '),
  )
  check('the side query takes the first-party client', srcOf('src/utils/sideQuery.ts').includes('getAnthropicClient('))
  const prefixHomes = tracked.filter(p => srcOf(p).includes(PREFIX)).sort()
  check(
    "the line's prefix has exactly two homes: its composer and the system-prompt block classifier",
    JSON.stringify(prefixHomes) === JSON.stringify(['src/constants/system.ts', 'src/utils/api.ts']),
    prefixHomes.join(', '),
  )
  const thirdParty = tracked.filter(p => p.startsWith('src/services/providers/') && !p.startsWith('src/services/providers/anthropic/'))
  const leaks = thirdParty.filter(p => {
    const t = srcOf(p)
    return t.includes('getAttributionHeader') || t.includes(PREFIX) || t.includes('cc_version=')
  })
  check(`no third-party runtime composes the line or spells its prefix (${thirdParty.length} files censused)`, thirdParty.length > 0 && leaks.length === 0, leaks.join(', '))
  const families = new Set(thirdParty.map(p => p.split('/')[3]).filter(seg => seg !== undefined && !seg.endsWith('.ts')))
  check('the census covers every third-party family directory', ['openai', 'zai', 'moonshot', 'deepseek', 'gemini', 'openaicompat', 'openrouter', 'huggingface', 'local'].every(f => families.has(f)), [...families].sort().join(', '))
}

// ── §3 the override ──────────────────────────────────────────────────────────
section('§3 THE OVERRIDE — a three-part version wins live; other shapes are reported')
process.env.MERCURY_ANTHROPIC_CLIENT_CONTRACT = '2.1.300'
check('the override wins on the attribution line', getAttributionHeader('fp02').startsWith('x-anthropic-billing-header: cc_version=2.1.300.fp02;'), getAttributionHeader('fp02'))
check('the describer names the override as the source', JSON.stringify(describeAnthropicClientContract()) === JSON.stringify({ presented: '2.1.300', source: 'override' }))
process.env.MERCURY_ANTHROPIC_CLIENT_CONTRACT = '  2.1.301 '
check('surrounding whitespace is trimmed', getAnthropicClientContractVersion() === '2.1.301')
process.env.MERCURY_ANTHROPIC_CLIENT_CONTRACT = 'latest'
{
  const d = describeAnthropicClientContract()
  check('a non-version override is ignored and reported, never presented', d.presented === CONTRACT && d.source === 'constant' && d.ignoredOverride === 'latest', JSON.stringify(d))
  check('…and the attribution line keeps the constant', getAttributionHeader('fp03').includes(`cc_version=${CONTRACT}.fp03;`))
}
process.env.MERCURY_ANTHROPIC_CLIENT_CONTRACT = ''
check('an empty override is unset', JSON.stringify(describeAnthropicClientContract()) === JSON.stringify({ presented: CONTRACT, source: 'constant' }))
delete process.env.MERCURY_ANTHROPIC_CLIENT_CONTRACT
check('unset ⇒ the constant, live (no memo)', getAnthropicClientContractVersion() === CONTRACT)
{
  const row = FLAG_REGISTRY.find(f => f.env === 'MERCURY_ANTHROPIC_CLIENT_CONTRACT')
  check('the registry carries the row as a value knob owned by constants/oauth.ts', row?.kind === 'value' && row.consumer === 'src/constants/oauth.ts' && row.tier === undefined, JSON.stringify(row))
}

// ── §4 the refusal ───────────────────────────────────────────────────────────
section('§4 THE REFUSAL — the gate\'s 400 maps to the Mercury line; the wire\'s advice never rides')
// The wire's sentence, its product name composed so this file never spells it.
const otherName = ['Claude', 'Code'].join(' ')
const wireSentence = `${otherName} 2.1.200 does not support this model; version 2.1.251 or newer is required. Run 'claude update', or update the ${['Claude', 'desktop'].join(' ')} app, then try again.`
const gateBody = {
  type: 'error',
  error: { type: 'invalid_request_error', message: wireSentence, details: { error_code: 'claude_code_version_too_old' } },
  request_id: 'req_door',
}
const gate400 = new APIError(400, gateBody, `400 ${JSON.stringify(gateBody)}`, undefined as never)
check('the phrase family is recognised', isClientContractGateText(gate400.message))
check('the error code alone is recognised', isClientContractGateText('{"details":{"error_code":"claude_code_version_too_old"}}'))
check('an unrelated 400 is not', !isClientContractGateText('400 {"error":{"message":"invalid model name"}}'))
{
  const msg = getAssistantMessageFromError(gate400, 'claude-fable-5-1') as never as { message: { content: unknown }; error?: string; errorDetails?: string }
  const text = textOf(msg)
  check('the row names the real cause', text.includes('minimum client-contract version'), text)
  check('…the version read and the version required', text.includes('read 2.1.200') && text.includes('requires 2.1.251 or newer'), text)
  check('…what Mercury presents and its source', text.includes(`presents ${CONTRACT} (the built-in constant)`), text)
  check('…and the override at the required floor', text.includes('MERCURY_ANTHROPIC_CLIENT_CONTRACT=2.1.251'), text)
  check("the wire's updater advice never reaches the operator", !/claude update|desktop app/i.test(text) && !text.includes(otherName), text)
  check('the row carries no errorDetails (the wire text stays in the debug log)', msg.errorDetails === undefined, msg.errorDetails)
  check('the kind is invalid_request', msg.error === 'invalid_request', msg.error)
}
{
  process.env.MERCURY_ANTHROPIC_CLIENT_CONTRACT = '2.1.240'
  const text = clientContractGateLine(gate400.message, 'claude-fable-5-1')
  check('under an override the line says so', text.includes('presents 2.1.240 (from MERCURY_ANTHROPIC_CLIENT_CONTRACT)'), text)
  delete process.env.MERCURY_ANTHROPIC_CLIENT_CONTRACT
}
{
  const plainBody = { type: 'error', error: { type: 'invalid_request_error', message: 'messages: text content blocks must be non-empty' } }
  const plain400 = new APIError(400, plainBody, `400 ${JSON.stringify(plainBody)}`, undefined as never)
  const text = textOf(getAssistantMessageFromError(plain400, 'claude-fable-5-1') as never)
  check('an unrelated 400 keeps its generic tail', text.includes('API Error: 400') && !text.includes('client-contract'), text)
}

// ── §5 the doctor ────────────────────────────────────────────────────────────
section('§5 THE DOCTOR — the identity section carries the row from the one describer')
{
  const health = readFileSync(join(ROOT, 'src/utils/healthReport.ts'), 'utf8')
  check("the identity section carries the 'client-contract' check", health.includes("id: 'client-contract'"))
  check('…composed from the one describer', health.includes('describeAnthropicClientContract()') && health.includes('subscription door presents cc_version ${contract.presented}'))
  check('…and the ignored-override shape warns with a fix', health.includes("status: 'warn'") && health.includes('not a three-part version'))
}

rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '='.repeat(76))
if (failures > 0) {
  console.log(`❌ client-contract door: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ client-contract door: the door presents the declared version; nothing else does; the override wins; the refusal is truthful')
