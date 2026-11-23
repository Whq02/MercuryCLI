#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const scratch = mkdtempSync(join(tmpdir(), 'client-contract-door-'))
process.env.MERCURY_CONFIG_DIR = scratch
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_ANTHROPIC_OAUTH_BASE = 'http://127.0.0.1:1'
delete process.env.MERCURY_ANTHROPIC_CLIENT_CONTRACT
delete process.env.ANTHROPIC_BASE_URL
delete process.env.MERCURY_PROVIDER_HEADERS
delete process.env.ANTHROPIC_API_KEY

let failures = 0
let sectionHint = ''
const HINTS: Record<string, string> = {
  '§1': 'what to change: ANTHROPIC_CLIENT_CONTRACT_VERSION, ANTHROPIC_CLIENT_CONTRACT_AS_OF or describeAnthropicClientContract in src/models/sign-in/oauth/oauth.ts, or getAttributionHeader in src/models/roads/attributionHeader.ts (the line must start with cc_version=<contract>.<fingerprint>)',
  '§2': 'what to change: the user-agent function named in the label (src/models/roads/requestHeaders.ts, src/platform/network/userAgent.ts, searchUserAgent in src/tools/engines/web-search/searchContract.js) or the client headers built in getAnthropicClient (src/models/roads/anthropic/anthropicClientFactory.ts); none may carry the contract version',
  '§3': 'what to change: getAnthropicClientContractVersion and describeAnthropicClientContract in src/models/sign-in/oauth/oauth.ts (override parsing), or the MERCURY_ANTHROPIC_CLIENT_CONTRACT row in the flag registry (FLAG_REGISTRY)',
  '§4': 'what to change: isClientContractGateText, clientContractGateLine or getAssistantMessageFromError in src/engine/requests/apiErrorRows.ts (the sign-in wall row also reads src/models/sign-in/credentials/auth.ts)',
}
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const hint = HINTS[sectionHint] ?? HINTS['§4']
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? (detail ? ` — ${detail}` : '') : ` — ${detail ? `${detail} | ` : ''}${hint}`}`)
}
function section(t: string): void {
  sectionHint = t.slice(0, 2)
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const {
  ANTHROPIC_CLIENT_CONTRACT_VERSION,
  ANTHROPIC_CLIENT_CONTRACT_AS_OF,
  describeAnthropicClientContract,
  getAnthropicClientContractVersion,
} = await import('../../src/models/sign-in/oauth/oauth.js')
const { getAttributionHeader } = await import('../../src/models/roads/attributionHeader.js')
const { getUserAgent, getMCPUserAgent, getWebFetchUserAgent } = await import('../../src/models/roads/requestHeaders.js')
const { getMercuryUserAgent, getAnthropicClientUserAgent } = await import('../../src/platform/network/userAgent.js')
const { searchUserAgent } = await import('../../src/tools/engines/web-search/searchContract.js')
const { getAnthropicClient } = await import('../../src/models/roads/anthropic/anthropicClientFactory.js')
const { getAssistantMessageFromError, isClientContractGateText, clientContractGateLine } = await import(
  '../../src/engine/requests/apiErrorRows.js'
)
const { FLAG_REGISTRY } = await import('../../src/platform/substrate/flagRegistry.js')
const { APIError } = await import('../../src/engine/request-parts/sdkErrors.js')

const CONTRACT = ANTHROPIC_CLIENT_CONTRACT_VERSION
const AS_OF = ANTHROPIC_CLIENT_CONTRACT_AS_OF
const textOf = (m: { message: { content: unknown } }): string => {
  const c = m.message.content
  return typeof c === 'string' ? c : JSON.stringify(c)
}

section('§1 THE DOOR — the attribution line spells the contract version first')
check('the constant is a three-part version', /^\d+\.\d+\.\d+$/.test(CONTRACT), CONTRACT)
check('the constant carries an ISO check date', /^\d{4}-\d{2}-\d{2}$/.test(AS_OF), String(AS_OF))
check('the describer carries the built-in check date', describeAnthropicClientContract().asOf === AS_OF, JSON.stringify(describeAnthropicClientContract()))
const line = getAttributionHeader('fp01')
check('the attribution line is composed', line.startsWith('x-anthropic-billing-header: '), line)
check('cc_version is the FIRST field (the gate-read position)', line.startsWith(`x-anthropic-billing-header: cc_version=${CONTRACT}.fp01;`), line)
check('the product version rides nowhere on the line', !line.includes('1.0.0'), line)
check('the accessor answers the constant when the override is unset', getAnthropicClientContractVersion() === CONTRACT)

section('§2 NOTHING ELSE — every agent stays mercury/<version>; six homes in src')
const agents: Array<[string, string]> = [
  ['provider transports (getUserAgent)', getUserAgent()],
  ['MCP (getMCPUserAgent)', getMCPUserAgent()],
  ['web fetch (getWebFetchUserAgent)', getWebFetchUserAgent()],
  ['OAuth legs + source fetches (getMercuryUserAgent)', getMercuryUserAgent()],
  ['Anthropic backend legs (getAnthropicClientUserAgent)', getAnthropicClientUserAgent()],
  ['search backends (searchUserAgent)', searchUserAgent()],
]
for (const [label, ua] of agents) {
  const webIdentity = ua === 'Mercury/1.0.0 (+https://mercury-cli.ai; https://github.com/Whq02/MercuryCLI/issues)'
  const sharesWebIdentity = label.startsWith('web fetch') || label === 'search backends (searchUserAgent)'
  check(`${label} is the product identity`, sharesWebIdentity ? webIdentity : /^(mercury\/1\.0\.0|Mozilla\/5\.0 \(compatible; Mercury\/1\.0\.0\))/.test(ua), ua)
  check(`${label} carries no contract version or borrowed agent token`, !ua.includes(CONTRACT) && !/claude-cli/i.test(ua), ua)
}
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


section('§3 THE OVERRIDE — a three-part version wins live; other shapes are reported')
process.env.MERCURY_ANTHROPIC_CLIENT_CONTRACT = '2.1.300'
check('the override wins on the attribution line', getAttributionHeader('fp02').startsWith('x-anthropic-billing-header: cc_version=2.1.300.fp02;'), getAttributionHeader('fp02'))
check('the describer names the override as the source', JSON.stringify(describeAnthropicClientContract()) === JSON.stringify({ presented: '2.1.300', asOf: AS_OF, source: 'override' }))
process.env.MERCURY_ANTHROPIC_CLIENT_CONTRACT = '  2.1.301 '
check('surrounding whitespace is trimmed', getAnthropicClientContractVersion() === '2.1.301')
process.env.MERCURY_ANTHROPIC_CLIENT_CONTRACT = 'latest'
{
  const d = describeAnthropicClientContract()
  check('a non-version override is ignored and reported, never presented', d.presented === CONTRACT && d.asOf === AS_OF && d.source === 'constant' && d.ignoredOverride === 'latest', JSON.stringify(d))
  check('…and the attribution line keeps the constant', getAttributionHeader('fp03').includes(`cc_version=${CONTRACT}.fp03;`))
}
process.env.MERCURY_ANTHROPIC_CLIENT_CONTRACT = ''
check('an empty override is unset', JSON.stringify(describeAnthropicClientContract()) === JSON.stringify({ presented: CONTRACT, asOf: AS_OF, source: 'constant' }))
delete process.env.MERCURY_ANTHROPIC_CLIENT_CONTRACT
check('unset ⇒ the constant, live (no memo)', getAnthropicClientContractVersion() === CONTRACT)
{
  const row = FLAG_REGISTRY.find(f => f.env === 'MERCURY_ANTHROPIC_CLIENT_CONTRACT')
  check('the registry carries the row as a value knob owned by constants/oauth.ts', row?.kind === 'value' && row.consumer === 'src/models/sign-in/oauth/oauth.ts' && row.tier === undefined, JSON.stringify(row))
}

section('§4 THE REFUSAL — the gate\'s 400 maps to the Mercury line; the wire\'s advice never rides')
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
const previousNodeEnv = process.env.NODE_ENV
process.env.NODE_ENV = 'test'
{
  process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
  const msg = getAssistantMessageFromError(gate400, 'claude-fable-5-1') as never as { message: { content: unknown }; error?: string; errorDetails?: string }
  const text = textOf(msg)
  check('the row names the model and the active door', text.includes('Fable 5.1 is refused on Anthropic API key'), text)
  check('the row names the required version in plain words', text.includes('needs client version 2.1.251'), text)
  check('the row names what Mercury presents and where the number came from', text.includes(`Mercury presents ${CONTRACT} (constant)`), text)
  check('…and the override at the required floor', text.includes('MERCURY_ANTHROPIC_CLIENT_CONTRACT=2.1.251'), text)
  check("the wire's updater advice never reaches the operator", !/claude update|desktop app/i.test(text) && !text.includes(otherName), text)
  check('the row carries no errorDetails (the wire text stays in the debug log)', msg.errorDetails === undefined, msg.errorDetails)
  check('the kind is invalid_request', msg.error === 'invalid_request', msg.error)
}
{
  process.env.MERCURY_ANTHROPIC_CLIENT_CONTRACT = '2.1.240'
  const text = clientContractGateLine(gate400.message, 'claude-fable-5-1')
  check('under an override the line names the presented version, its source and remedy', text.includes('Mercury presents 2.1.240 (override)') && text.includes('MERCURY_ANTHROPIC_CLIENT_CONTRACT=2.1.251'), text)
  delete process.env.MERCURY_ANTHROPIC_CLIENT_CONTRACT
}
{
  const plainBody = { type: 'error', error: { type: 'invalid_request_error', message: 'messages: text content blocks must be non-empty' } }
  const plain400 = new APIError(400, plainBody, `400 ${JSON.stringify(plainBody)}`, undefined as never)
  const text = textOf(getAssistantMessageFromError(plain400, 'claude-fable-5-1') as never)
  check('an unrelated 400 keeps its generic tail', text.includes('API Error (400)') && !text.includes('client-contract'), text)
  delete process.env.ANTHROPIC_API_KEY
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = previousNodeEnv
}

{
  const auth = { ...(await import('../../src/models/sign-in/credentials/auth.js')), ...(await import('../../src/models/sign-in/lifecycle/oauthLifecycle.js')) }
  const { SUBSCRIPTION_OAUTH_SCOPES } = await import('../../src/models/sign-in/oauth/oauth.js')
  auth.saveOAuthTokensIfNeeded({
    accessToken: 'at-fixture', refreshToken: 'rt-fixture', expiresAt: Date.now() + 3_600_000,
    scopes: [...SUBSCRIPTION_OAUTH_SCOPES], subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x',
  } as never)
  auth.clearOAuthTokenCache()
  const revokedBody = { type: 'error', error: { type: 'authentication_error', message: 'OAuth access token has been revoked' } }
  const revoked401 = new APIError(401, revokedBody, `401 ${JSON.stringify(revokedBody)}`, undefined as never)
  let wallRow: { message: { content: unknown }; error?: string } | undefined
  let wallThrow = ''
  try {
    wallRow = getAssistantMessageFromError(revoked401, 'claude-fable-5-1') as never
  } catch (e) {
    wallThrow = String(e)
  }
  const wallText = wallRow ? textOf(wallRow) : ''
  check('a sign-in wall row composes with the config closed (a stored sign-in, no account suffix)', auth.isClaudeAISubscriber() && wallRow !== undefined && wallRow.error === 'authentication_failed' && wallText.includes('Anthropic sign-in expired') && !wallText.includes('· account'), wallThrow || wallText)
}


rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '='.repeat(76))
if (failures > 0) {
  console.log(`❌ client-contract door: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ client-contract door: the door presents the declared version; nothing else does; the override wins; the refusal is truthful')
