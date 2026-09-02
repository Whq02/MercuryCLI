#!/usr/bin/env bun
// ============================================================================
//  scripts/tool-economy/prove-deferral-wire-form.ts — the per-route WIRE
//  FORM of tool deferral is a capability table read by one owner, the
//  gateway is decided by evidence, and the verdict is durable and honest.
//
//    §1 THE TABLE — every declared route has a row; the home lane is the
//       only evidence-decided row; a representative model per route answers
//       the table; an unrecognised id reads the home lane's evidence;
//       absence has no wire.
//    §2 THE GATEWAY EVIDENCE LADDER (injected reads) — first-party is block
//       by contract; a gateway is block on the operator's explicit
//       MERCURY_TOOL_SEARCH assertion, else on a recorded block verdict,
//       text on a recorded text verdict, text while unprobed, text on an
//       unparseable base URL.
//    §3 THE CLASSIFIER over recorded gateway answer shapes — 2xx ⇒ block; a
//       400 naming the field/header/block ⇒ text; auth refusals and
//       unreachable wires are indeterminate (no verdict is ever minted from
//       them); other statuses are indeterminate too.
//    §4 THE DURABLE STORE — a verdict written under the config home reads
//       back; a stale one (past seven days) reads unprobed; the probe is
//       single-flight per host per process, records only verdicts, and
//       never runs twice in one process.
//    §5 THE POLICY — MERCURY_TOOL_DEFER_PROBE=0 and the nonessential-traffic
//       posture keep the probe off.
//    §6 THE FENCE — the strip choke point admits defer_loading only where
//       the block form is accepted; the ToolSearch description renders per
//       form through the schema cache (the key carries the form).
//    §7 THE PROBE SHAPE — one fixture tool marked defer_loading, one output
//       token, the beta header spelled once.
//
//  Run: ~/.bun/bin/bun run scripts/tool-economy/prove-deferral-wire-form.ts
// ============================================================================
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

delete process.env.NODE_ENV
for (const k of ['ANTHROPIC_BASE_URL', 'MERCURY_TOOL_SEARCH', 'MERCURY_TOOL_DEFER', 'MERCURY_TOOL_DEFER_PROBE', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC', 'ANTHROPIC_MODEL']) {
  delete process.env[k]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'deferral-wire-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const wire = await import('../../src/services/providers/deferralWire.ts')
const probe = await import('../../src/services/providers/deferralProbe.ts')
const { PROVIDER_ID_SPACES, declaredRouteOf } = await import('../../src/services/providers/routeLaw.ts')
const { toolToAPISchema } = await import('../../src/utils/api.ts')
const { clearToolSchemaCache } = await import('../../src/utils/toolSchemaCache.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const { getPrompt } = await import('../../src/tools/ToolSearchTool/prompt.ts')

const ROUTE_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5.6-sol',
  zai: 'glm-5.3',
  moonshot: 'kimi-k3',
  deepseek: 'deepseek-v4-pro',
  'openai-compat': 'compat/qwen-max',
  openrouter: 'openrouter/qwen/qwen3-coder',
  gemini: 'gemini-3-pro',
  huggingface: 'huggingface/deepseek-ai/DeepSeek-V4-Pro-0813',
  local: 'local/qwen3-32b',
}

section('§1 THE TABLE — one row per declared route, read by one owner')
{
  // The id-space table declares every routed family; the home lane is
  // recognised through recognizeModelId (claude-mark · aliases · env pins)
  // rather than an id-space row, so it joins the declared set by its own
  // recognition — asserted, not assumed.
  const declared = new Set<string>(PROVIDER_ID_SPACES.map((s: { route: string }) => s.route))
  check('the home lane is recognised as a route of its own', declaredRouteOf('claude-sonnet-5') === 'anthropic')
  declared.add('anthropic')
  const tabled = new Set(Object.keys(wire.DEFERRAL_WIRE_CAPABILITY))
  check('every declared route has a capability row', [...declared].every(r => tabled.has(r)), [...declared].filter(r => !tabled.has(r)).join(','))
  check('no capability row names an undeclared route', [...tabled].every(r => declared.has(r)), [...tabled].filter(r => !declared.has(r)).join(','))
  check('the home lane is the ONLY evidence-decided row', Object.entries(wire.DEFERRAL_WIRE_CAPABILITY).filter(([, c]) => c === 'gateway-evidence').map(([r]) => r).join(',') === 'anthropic')
  check('every other row is the text form', Object.entries(wire.DEFERRAL_WIRE_CAPABILITY).filter(([r]) => r !== 'anthropic').every(([, c]) => c === 'text'))
  for (const [route, model] of Object.entries(ROUTE_MODELS)) {
    const verdict = wire.deferralWireFormFor(model)
    const expected = route === 'anthropic' ? 'block' : 'text'
    check(`${route} (${model}) → ${expected} (${verdict.why})`, declaredRouteOf(model) === route && verdict.form === expected && (route === 'anthropic' ? verdict.why === 'first-party-contract' : verdict.why === 'route-table'))
  }
  const stranger = wire.deferralWireFormFor('mystery-model-9000')
  check('an unrecognised id reads the home lane evidence (first-party here ⇒ block)', stranger.form === 'block' && stranger.why === 'first-party-contract')
  const absent = wire.deferralWireFormFor('')
  check('absence has no wire ⇒ text / no-route', absent.form === 'text' && absent.why === 'no-route')
}

section('§2 THE GATEWAY EVIDENCE LADDER — injected reads, one rung at a time')
{
  const gatewayEnv = { ANTHROPIC_BASE_URL: 'https://litellm.corp.example.com' }
  const reads = (extra: Partial<Parameters<typeof wire.homeLaneWireForm>[0]> = {}) => ({
    firstPartyBaseUrl: () => false,
    env: gatewayEnv,
    ...extra,
  })
  check('gateway host is keyed from the base URL', wire.gatewayHost(gatewayEnv) === 'litellm.corp.example.com')
  check('first-party host keys no gateway', wire.gatewayHost({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }) === null && wire.gatewayHost({}) === null)
  const fp = wire.homeLaneWireForm({ firstPartyBaseUrl: () => true, env: {} })
  check('first-party ⇒ block by contract', fp.form === 'block' && fp.why === 'first-party-contract')
  const asserted = wire.homeLaneWireForm(reads({ env: { ...gatewayEnv, MERCURY_TOOL_SEARCH: 'tst' } }))
  check("gateway + the operator's explicit MERCURY_TOOL_SEARCH ⇒ block (asserted)", asserted.form === 'block' && asserted.why === 'gateway-asserted')
  const probedBlock = wire.homeLaneWireForm(reads({ probeVerdict: () => 'block' }))
  check('gateway + recorded block verdict ⇒ block (probed)', probedBlock.form === 'block' && probedBlock.why === 'gateway-probed-block')
  const probedText = wire.homeLaneWireForm(reads({ probeVerdict: () => 'text' }))
  check('gateway + recorded text verdict ⇒ text (probed)', probedText.form === 'text' && probedText.why === 'gateway-probed-text')
  const unprobed = wire.homeLaneWireForm(reads({ probeVerdict: () => undefined }))
  check('gateway + no verdict ⇒ text (unprobed — the form that cannot fail)', unprobed.form === 'text' && unprobed.why === 'gateway-unprobed')
  const unparseable = wire.homeLaneWireForm({ firstPartyBaseUrl: () => false, env: { ANTHROPIC_BASE_URL: 'not a url' }, probeVerdict: () => 'block' })
  check('an unparseable base URL keys no host ⇒ text (unprobed), whatever the store holds', unparseable.form === 'text' && unparseable.why === 'gateway-unprobed')
  check('an empty MERCURY_TOOL_SEARCH is not an assertion', wire.homeLaneWireForm(reads({ env: { ...gatewayEnv, MERCURY_TOOL_SEARCH: '' } })).why === 'gateway-unprobed')
  check('toolReferenceWireAccepted follows the ladder (first-party true, unprobed gateway false)', wire.toolReferenceWireAccepted({ firstPartyBaseUrl: () => true, env: {} }) === true && wire.toolReferenceWireAccepted(reads()) === false)
}

section('§3 THE CLASSIFIER — recorded gateway answer shapes')
{
  const cases: Array<{ label: string; status: number | null; body: string; expect: string }> = [
    { label: '2xx ⇒ block', status: 200, body: '', expect: 'verdict:block' },
    { label: 'LiteLLM-style 400 naming defer_loading ⇒ text', status: 400, body: '{"error":{"message":"litellm.BadRequestError: AnthropicException - tools.0.defer_loading: Extra inputs are not permitted"}}', expect: 'verdict:text' },
    { label: '400 naming the beta header ⇒ text', status: 400, body: '{"type":"error","error":{"type":"invalid_request_error","message":"Unsupported beta: advanced-tool-use-2025-11-20"}}', expect: 'verdict:text' },
    { label: '400 naming tool_reference ⇒ text', status: 400, body: 'tool_reference blocks are not supported by this gateway', expect: 'verdict:text' },
    { label: '400 about something else (an unknown model) ⇒ indeterminate', status: 400, body: '{"error":{"message":"model not found: claude-sonnet-5"}}', expect: 'indeterminate:other-status' },
    { label: '401 ⇒ indeterminate (auth refused the probe, not the shape)', status: 401, body: 'unauthorized', expect: 'indeterminate:auth-refused' },
    { label: '403 ⇒ indeterminate (auth refused)', status: 403, body: 'forbidden', expect: 'indeterminate:auth-refused' },
    { label: 'no reply ⇒ indeterminate (unreachable)', status: null, body: 'fetch failed: ECONNREFUSED', expect: 'indeterminate:unreachable' },
    { label: '502 ⇒ indeterminate (other status)', status: 502, body: 'bad gateway', expect: 'indeterminate:other-status' },
    { label: '429 ⇒ indeterminate (other status — never a verdict from a rate limit)', status: 429, body: 'rate limited', expect: 'indeterminate:other-status' },
  ]
  for (const c of cases) {
    const v = probe.classifyGatewayProbe({ status: c.status, bodyText: c.body })
    const got = v.kind === 'verdict' ? `verdict:${v.verdict}` : `indeterminate:${v.reason}`
    check(c.label, got === c.expect, got)
    check(`${c.label}: the evidence carries the status and the first body line`, v.evidence.startsWith(c.status === null ? 'no reply' : `http ${c.status}`) && (c.body === '' || v.evidence.includes(c.body.split('\n')[0]!.slice(0, 40))))
  }
}

section('§4 THE DURABLE STORE — verdicts persist, go stale, and the probe is single-flight')
{
  probe._resetGatewayProbeStoreForTesting()
  probe._resetGatewayProbeFlightsForTesting()
  const host = 'gw.example.test'
  check('unprobed host reads undefined', probe.readGatewayProbeVerdict(host) === undefined)
  probe.recordGatewayProbe(host, { verdict: 'text', evidence: 'http 400: defer_loading refused', status: 400, probedAt: new Date().toISOString() })
  const file = join(process.env.MERCURY_CONFIG_DIR!, 'tool-deferral-probe.json')
  check('the verdict is written under the config home', existsSync(file))
  check('…and reads back', probe.readGatewayProbeVerdict(host) === 'text')
  probe._resetGatewayProbeStoreForTesting()
  check('…across a fresh in-memory view (the file is the record)', probe.readGatewayProbeVerdict(host) === 'text' && JSON.parse(readFileSync(file, 'utf8')).hosts[host].evidence.includes('defer_loading'))
  const eightDays = () => Date.now() + 8 * 24 * 60 * 60 * 1000
  check('a verdict older than seven days reads unprobed (gateways get upgraded)', probe.readGatewayProbeVerdict(host, eightDays) === undefined)
  check('…while the record itself is still readable for receipts', probe.readGatewayProbeRecord(host)?.verdict === 'text')

  // Single-flight: two concurrent ensure() calls, one send.
  probe._resetGatewayProbeFlightsForTesting()
  let sends = 0
  const send = async (): Promise<{ status: number | null; bodyText: string }> => {
    sends++
    await new Promise(resolve => setTimeout(resolve, 20))
    return { status: 200, bodyText: '' }
  }
  const [a, b] = await Promise.all([
    probe.ensureGatewayProbe('single.example.test', send, 'claude-sonnet-5'),
    probe.ensureGatewayProbe('single.example.test', send, 'claude-sonnet-5'),
  ])
  check('two concurrent probes of one host send ONCE', sends === 1, String(sends))
  check('both callers see the same verdict', a?.kind === 'verdict' && b?.kind === 'verdict' && a.verdict === 'block' && b.verdict === 'block')
  check('the verdict was recorded', probe.readGatewayProbeVerdict('single.example.test') === 'block')
  const again = await probe.ensureGatewayProbe('single.example.test', send, 'claude-sonnet-5')
  check('a later call in the same process never re-sends (null = already attempted)', again === null && sends === 1)

  // An indeterminate answer records nothing.
  probe._resetGatewayProbeFlightsForTesting()
  const auth = await probe.ensureGatewayProbe('auth.example.test', async () => ({ status: 401, bodyText: 'unauthorized' }), 'claude-sonnet-5')
  check('an auth refusal is indeterminate and leaves NO verdict', auth?.kind === 'indeterminate' && probe.readGatewayProbeVerdict('auth.example.test') === undefined)
  const threw = await probe.ensureGatewayProbe('throw.example.test', async () => { throw new Error('socket hang up') }, 'claude-sonnet-5')
  check('a throwing send is unreachable, never a crash, never a verdict', threw?.kind === 'indeterminate' && threw.reason === 'unreachable' && probe.readGatewayProbeVerdict('throw.example.test') === undefined)
}

section('§5 THE POLICY — the probe is the operator\'s to arm; the traffic posture keeps it off')
{
  check('unset ⇒ never (a gateway rides the text form, no request the session did not ask for)', probe.gatewayProbePolicyAllows({}) === false && wire.gatewayProbeAllowedByFlag() === false)
  process.env.MERCURY_TOOL_DEFER_PROBE = '0'
  check('MERCURY_TOOL_DEFER_PROBE=0 ⇒ never', probe.gatewayProbePolicyAllows({}) === false && wire.gatewayProbeAllowedByFlag() === false)
  process.env.MERCURY_TOOL_DEFER_PROBE = '1'
  check('MERCURY_TOOL_DEFER_PROBE=1 ⇒ armed', probe.gatewayProbePolicyAllows({}) === true && wire.gatewayProbeAllowedByFlag() === true)
  check('…but MERCURY_DISABLE_NONESSENTIAL_TRAFFIC=1 keeps it off even when armed', probe.gatewayProbePolicyAllows({ MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1' }) === false)
  check("…while '0' and 'false' are not the posture", probe.gatewayProbePolicyAllows({ MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '0' }) === true && probe.gatewayProbePolicyAllows({ MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: 'false' }) === true)
  delete process.env.MERCURY_TOOL_DEFER_PROBE
}

section('§6 THE FENCE — defer_loading and the description follow the wire form')
{
  const fixture = {
    name: 'FenceTool',
    prompt: async () => 'a fence fixture',
    inputSchema: (await import('zod/v4')).z.object({ a: (await import('zod/v4')).z.string() }),
  } as never
  const build = async (model: string): Promise<Record<string, unknown>> => {
    clearToolSchemaCache()
    return (await toolToAPISchema(fixture, {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      tools: [],
      agents: [],
      model,
      deferLoading: true,
    })) as unknown as Record<string, unknown>
  }
  delete process.env.ANTHROPIC_BASE_URL
  check('first-party: defer_loading survives the strip', (await build('claude-sonnet-5')).defer_loading === true)
  process.env.ANTHROPIC_BASE_URL = 'https://litellm.corp.example.com'
  probe._resetGatewayProbeStoreForTesting()
  check('unprobed gateway: defer_loading never survives (the 400 class is fenced)', (await build('claude-sonnet-5')).defer_loading === undefined)
  process.env.MERCURY_TOOL_SEARCH = 'tst'
  check("gateway + the operator's assertion: the field rides", (await build('claude-sonnet-5')).defer_loading === true)
  delete process.env.MERCURY_TOOL_SEARCH
  probe.recordGatewayProbe('litellm.corp.example.com', { verdict: 'block', evidence: 'http 200', status: 200, probedAt: new Date().toISOString() })
  check('gateway + a recorded block verdict: the field rides', (await build('claude-sonnet-5')).defer_loading === true)
  probe.recordGatewayProbe('litellm.corp.example.com', { verdict: 'text', evidence: 'http 400: defer_loading', status: 400, probedAt: new Date().toISOString() })
  check('gateway + a recorded text verdict: the field is stripped', (await build('claude-sonnet-5')).defer_loading === undefined)
  process.env.MERCURY_TOOL_DEFER = '0'
  delete process.env.ANTHROPIC_BASE_URL
  check('MERCURY_TOOL_DEFER=0: stripped even on first-party (the off arm)', (await build('claude-sonnet-5')).defer_loading === undefined)
  delete process.env.MERCURY_TOOL_DEFER

  // The description per form, through the schema cache.
  const describe = async (model: string): Promise<string> => {
    clearToolSchemaCache()
    const schema = (await toolToAPISchema(ToolSearchTool as never, {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      tools: [ToolSearchTool as never],
      agents: [],
      model,
    })) as unknown as { description: string }
    return schema.description
  }
  check('first-party model: the block-form description (the unchanged bytes)', (await describe('claude-sonnet-5')) === getPrompt('block'))
  check('text-form model: the text-form description', (await describe('gpt-5.6-sol')) === getPrompt('text'))
  process.env.ANTHROPIC_BASE_URL = 'https://litellm.corp.example.com'
  probe._resetGatewayProbeStoreForTesting()
  probe.recordGatewayProbe('litellm.corp.example.com', { verdict: 'text', evidence: 'http 400: defer_loading', status: 400, probedAt: new Date().toISOString() })
  check('a text-verdict gateway: the same route, the text-form description (the key carries the form)', (await describe('claude-sonnet-5')) === getPrompt('text'))
  delete process.env.ANTHROPIC_BASE_URL
}

section('§7 THE PROBE SHAPE')
{
  const body = probe.gatewayProbeBody('claude-sonnet-5')
  const tools = body.tools as Array<Record<string, unknown>>
  check('one output token, one user turn', body.max_tokens === 1 && Array.isArray(body.messages) && (body.messages as unknown[]).length === 1)
  check('exactly one fixture tool, marked defer_loading, named for what it is', tools.length === 1 && tools[0]!.name === 'deferral_probe' && tools[0]!.defer_loading === true)
  check('the beta header is the first-party spelling', probe.PROBE_BETA_HEADER === 'advanced-tool-use-2025-11-20')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`❌ ${failures} DEFERRAL WIRE-FORM PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL DEFERRAL WIRE-FORM PROOFS PASS')
process.exit(0)
