#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')

let failures = 0
function check(label: string, condition: boolean, detail?: unknown): void {
  if (!condition) failures++
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${label}${!condition && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`)
}
const show = (value: unknown): string => JSON.stringify(value)

type Refusal = { at: string; status: number; ms: number; headers: Record<string, string>; ratelimit_headers_present: boolean; body: { type: string; error: { type: string; message: string } } }
type Leg = {
  leg: string
  law: string
  road: string
  request: Record<string, unknown>
  response: Record<string, unknown> & { status: number; refusals?: Refusal[]; headers?: Record<string, string>; input_tokens?: number; count?: number; content?: Array<Record<string, unknown>>; usage?: { output_tokens_details?: { thinking_tokens?: number } }; final_line?: string; expected_final_line?: string; body?: { error?: { type?: string; message?: string } } }
}
type Fixture = { model: string; observed_at: string; product_commit: string; usage_window_before: { five_hour_utilization: number; seven_day_sonnet: unknown }; legs: Leg[] }

const fixture = JSON.parse(read('scripts/model-registry/fixtures/sonnet-55-count-thinking-probe.json')) as Fixture
const leg = (name: string): Leg => fixture.legs.find(l => l.leg === name) ?? { leg: name, law: '', road: '', request: {}, response: { status: 0 } }
const ID = 'claude-sonnet-5-5'
const ATTRIBUTION = 'x-anthropic-billing-header: cc_version='
const isDoorRefusal = (refusal: Refusal): boolean =>
  refusal.status === 429 && refusal.body.error.type === 'rate_limit_error' && refusal.body.error.message === 'Error' && refusal.headers['x-should-retry'] === 'true' && refusal.headers['retry-after'] === undefined && refusal.ratelimit_headers_present === false && refusal.ms < 2_000
const secondsBetween = (a: string, b: string): number => Math.abs(Date.parse(a) - Date.parse(b)) / 1000

console.log('the receipt: the first-party door, the seed with a signed thinking block, the two count shapes and the product road, as the wire answered on 2026-09-30')
{
  check('the fixture records the row, the day, the product commit and the usage window it was read under', fixture.model === ID && fixture.observed_at.startsWith('2026-09-30T') && /^[0-9a-f]{40}$/.test(fixture.product_commit) && typeof fixture.usage_window_before.five_hour_utilization === 'number', { model: fixture.model, observed_at: fixture.observed_at, commit: fixture.product_commit })
  check('the usage window was open and no Sonnet window existed: the refusals below are not the login\'s', fixture.usage_window_before.five_hour_utilization < 100 && fixture.usage_window_before.seven_day_sonnet === null, fixture.usage_window_before)
  check('nothing sensitive rides the fixture: request ids, bearer, ids and the signature are named, not copied', !/req_(?!\*\*\*)[A-Za-z0-9_-]{6,}/.test(read('scripts/model-registry/fixtures/sonnet-55-count-thinking-probe.json')) && !/Bearer [A-Za-z0-9._~+/=-]{16,}/.test(read('scripts/model-registry/fixtures/sonnet-55-count-thinking-probe.json')) && !/sk-ant-[A-Za-z0-9_-]{8,}/.test(read('scripts/model-registry/fixtures/sonnet-55-count-thinking-probe.json')) && !/"signature": "(?!sig_\*\*\*)/.test(read('scripts/model-registry/fixtures/sonnet-55-count-thinking-probe.json')))
}

console.log('\n§1 the door reads the attribution line')
{
  const d1 = leg('D1')
  const refusals = d1.response.refusals ?? []
  check('D1: the earlier lanes\' shape — the CLI prefix as one string, no attribution line, no metadata — was refused three times', typeof d1.request.system === 'string' && d1.request.metadata === 'absent' && refusals.length === 3 && refusals.every(isDoorRefusal), refusals.map(r => [r.status, r.body.error.message, r.headers, r.ratelimit_headers_present]))
  check('D1: each refusal is the door\'s own answer — 429 rate_limit_error "Error" within a quarter of a second, x-should-retry true, no retry-after, not one rate-limit accounting header', refusals.every(r => r.ms < 1_000 && r.ratelimit_headers_present === false), refusals.map(r => r.ms))
  check('D1: the three refusals came 90 s apart, so the refusal is stable, not a burst', refusals.length === 3 && secondsBetween(refusals[0]!.at, refusals[1]!.at) >= 85 && secondsBetween(refusals[1]!.at, refusals[2]!.at) >= 85, refusals.map(r => r.at))
  const d2 = leg('D2')
  const d2system = d2.request.system as string[]
  check('D2: the live session\'s shape — the attribution line, then the CLI prefix, as system blocks, with metadata.user_id — answered 200 under the same account within seconds of the third refusal', Array.isArray(d2system) && d2system[0]!.startsWith(ATTRIBUTION) && typeof d2.request.metadata === 'object' && d2.response.status === 200 && secondsBetween(refusals[2]!.at, String(d2.response.at)) < 60, { system: d2system, status: d2.response.status, at: d2.response.at })
  check('D2: the admitted answer carries the usage window\'s accounting: unified status allowed, the five-hour window a third used', d2.response.headers?.['anthropic-ratelimit-unified-status'] === 'allowed' && Number(d2.response.headers?.['anthropic-ratelimit-unified-5h-utilization']) < 1, d2.response.headers)
  const d3 = leg('D3')
  const d3system = d3.request.system as string[]
  check('D3: the attribution line alone (no metadata) is admitted', Array.isArray(d3system) && d3system[0]!.startsWith(ATTRIBUTION) && d3.request.metadata === 'absent' && d3.response.status === 200 && d3.response.headers?.['anthropic-ratelimit-unified-status'] === 'allowed', { system: d3system, status: d3.response.status })
  const d4 = leg('D4')
  check('D4: metadata.user_id alone, without the attribution line, is refused the same way — the attribution line is the field the door keys on', typeof d4.request.system === 'string' && typeof d4.request.metadata === 'object' && (d4.response.refusals ?? []).length === 1 && (d4.response.refusals ?? []).every(isDoorRefusal), d4.response.refusals)
}

console.log('\n§2 every first-party create the product sends opens with the attribution line')
{
  const sideQuery = read('src/utils/sideQuery.ts')
  const streamCore = read('src/services/providers/anthropic/streamCore.ts')
  const tokenEstimation = read('src/services/tokenEstimation.ts')
  check('the side-query builder puts the attribution line in its own first system block, the CLI prefix next', sideQuery.includes('const attributionHeader = getAttributionHeader(fingerprint)') && sideQuery.includes("if (attributionHeader) systemBlocks.push({ type: 'text', text: attributionHeader })") && sideQuery.includes('getCLISyspromptPrefix({ isNonInteractive: false, hasAppendSystemPrompt: false })'))
  const cacheAndUsage = read('src/services/providers/anthropic/cacheAndUsage.ts')
  check('the main stream assembles its system prompt from the attribution line first, through the one owner the count endpoint rides too', streamCore.includes('let attributionLine = getAttributionHeader(fingerprint)') && streamCore.includes('assembleTurnSystemPrompt(attribution, sessionSystemPrompt, posture)') && cacheAndUsage.includes('return asSystemPrompt([attribution, getCLISyspromptPrefix(posture), ...systemPrompt].filter(Boolean))'))
  const probe = tokenEstimation.slice(tokenEstimation.indexOf('export async function countTokensViaHaikuFallback'), tokenEstimation.indexOf('export function roughTokenCountEstimation('))
  check('the create-probe counter rides the side-query builder (base: a direct client create with no system prompt and the beta headers spread into the body)', probe.includes('sideQuery({') && !probe.includes('client.beta.messages.create(') && !tokenEstimation.includes('getExtraBodyParams'), probe.slice(0, 200))
  const f5 = leg('F5')
  check('F5: the shipped probe\'s wire answer is on the record — 400 invalid_request_error, "anthropic_beta: Extra inputs are not permitted"', f5.response.status === 400 && f5.response.body?.error?.type === 'invalid_request_error' && (f5.response.body?.error?.message ?? '').includes('anthropic_beta: Extra inputs are not permitted') && f5.request.system === 'absent', f5.response.body)
}

console.log('\n§3 the seed, the two count shapes and the product road')
{
  const c0 = leg('C0')
  const thinking = (c0.response.content ?? []).find(block => block.type === 'thinking')
  check('C0: the seed answered 200 under the main stream\'s composition with a signed thinking block (720 thinking tokens billed, a 2348-character signature) and the right final line', c0.response.status === 200 && thinking !== undefined && (thinking.signature_chars as number) > 0 && (c0.response.usage?.output_tokens_details?.thinking_tokens ?? 0) > 0 && c0.response.final_line === c0.response.expected_final_line && c0.response.final_line === 'n=644397 digits=33', { status: c0.response.status, thinking, final: c0.response.final_line })
  const c1 = leg('C1')
  const c2 = leg('C2')
  const c3 = leg('C3')
  check('C1: the manual budget shape the counter used to send every model is ACCEPTED by the count endpoint on the row (200, 761 tokens) — it is not refused there', show(c1.request.thinking) === show({ type: 'enabled', budget_tokens: 1024 }) && c1.response.status === 200 && c1.response.input_tokens === 761, { thinking: c1.request.thinking, status: c1.response.status, input_tokens: c1.response.input_tokens })
  check('C2: the adaptive shape counts 200 with 734 tokens — the two shapes count the same conversation differently, and adaptive is the shape the session sends', show(c2.request.thinking) === show({ type: 'adaptive' }) && c2.response.status === 200 && c2.response.input_tokens === 734 && c2.response.input_tokens !== c1.response.input_tokens, { thinking: c2.request.thinking, status: c2.response.status, input_tokens: c2.response.input_tokens })
  check('C3: the product road sends the adaptive shape for the row and gets exactly the adaptive figure', c3.road === 'countMessagesTokensWithAPI' && show(c3.request.thinking) === show({ type: 'adaptive' }) && c3.response.status === 200 && c3.response.count === 734 && c3.response.count === c2.response.input_tokens, { thinking: c3.request.thinking, status: c3.response.status, count: c3.response.count })
  check('C1–C3 each replayed the seed\'s signed block verbatim (the count endpoint validates signatures; a forged one is a 400)', [c1, c2, c3].every(l => ((l.request.messages as Array<{ role: string; content: unknown }>)[1]?.content as Array<Record<string, unknown>>)?.some(block => block.type === 'thinking' && block.signature === 'sig_***' && block.signature_chars === 2348)))
}

console.log('\n§4 the count carries the system prompt: the drop header, the figures, the product road, the /context derivation (2026-09-30, the second receipt)')
{
  type SystemFixture = Fixture & { drop_header: string; prefix_observed_at: string; figures: Record<string, number | null>; redactions: string[] }
  const path = 'scripts/model-registry/fixtures/sonnet-55-count-system-probe.json'
  const raw = read(path)
  const second = JSON.parse(raw) as SystemFixture
  const legOf = (name: string): Leg => second.legs.find(l => l.leg === name) ?? { leg: name, law: '', road: '', request: {}, response: { status: 0 } }
  const HEADER = 'anthropic-thinking-prefix-mismatch'
  const mismatch = (l: Leg): string | undefined => l.response.headers?.[HEADER] ?? (l.response as { mismatch_header?: string | null }).mismatch_header ?? undefined
  check('the second fixture records the row, the day, the product commit and an open usage window', second.model === ID && second.observed_at.startsWith('2026-09-30T') && /^[0-9a-f]{40}$/.test(second.product_commit) && second.usage_window_before.five_hour_utilization < 100 && second.usage_window_before.seven_day_sonnet === null, { model: second.model, observed_at: second.observed_at, window: second.usage_window_before })
  check('nothing sensitive rides it: request ids, the bearer, the account, the organisation, the workspace, the trace and the signature are named, not copied', !/req_(?!\*\*\*)[A-Za-z0-9_-]{6,}/.test(raw) && !/Bearer [A-Za-z0-9._~+/=-]{16,}/.test(raw) && !/sk-ant-[A-Za-z0-9_-]{8,}/.test(raw) && !/"signature": "(?!sig_\*\*\*)/.test(raw) && !/wrkspc_/.test(raw) && !/"anthropic-organization-id": "(?!<)/.test(raw) && !/"traceresponse": "(?!<)/.test(raw) && !/cc_version=\d/.test(raw))
  check('the drop header is named once, by the fixture and by the wire alike', second.drop_header === HEADER)
  const s0 = legOf('S0')
  const seedSystem = s0.request.system as Array<{ text: string; chars: number; cache_control?: unknown }>
  const s0thinking = (s0.response.content ?? []).find(block => block.type === 'thinking')
  check('S0: the seed rode the shared builder\'s three system blocks — the attribution line uncached, the CLI prefix and the session prompt cached — with the binding and answered 200 with a signed thinking block and the right final line', s0.road.includes('buildTurnSystemBlocks') && Array.isArray(seedSystem) && seedSystem.length === 3 && seedSystem[0]!.text.startsWith(ATTRIBUTION) && seedSystem[0]!.cache_control === undefined && seedSystem[1]!.cache_control !== undefined && seedSystem[2]!.cache_control !== undefined && show((s0.request.thinking as { block_binding?: unknown }).block_binding) === show({ prefix_mismatch_behavior: 'drop_block' }) && s0.response.status === 200 && s0thinking !== undefined && (s0thinking.signature_chars as number) > 0 && s0.response.final_line === 'n=644397 digits=33' && (s0.response.usage?.output_tokens_details?.thinking_tokens ?? 0) === 738, { system: seedSystem, status: s0.response.status, final: s0.response.final_line })
  const k1 = legOf('K1')
  const k2 = legOf('K2')
  const k3 = legOf('K3')
  const k4 = legOf('K4')
  const k5 = legOf('K5')
  const k6 = legOf('K6')
  const k7 = legOf('K7')
  check('K1: the count as shipped — no system prompt — answered 200 with the drop header naming the system (kind=system_changed, sections=system, the block at messages.1.content.0) and read 937', k1.request.system === 'absent' && k1.response.status === 200 && k1.response.input_tokens === 937 && (mismatch(k1) ?? '').includes('kind=system_changed') && (mismatch(k1) ?? '').includes('sections=system') && (mismatch(k1) ?? '').includes('block=messages.1.content.0'), { status: k1.response.status, input_tokens: k1.response.input_tokens, header: mismatch(k1) })
  check('K2: the same count carrying the seed\'s exact system blocks answered 200 WITHOUT the drop header and read 1789', Array.isArray(k2.request.system) && show((k2.request.system as Array<{ chars: number }>).map(b => b.chars)) === show(seedSystem.map(b => b.chars)) && k2.response.status === 200 && k2.response.input_tokens === 1789 && mismatch(k2) === undefined, { status: k2.response.status, input_tokens: k2.response.input_tokens, header: mismatch(k2) })
  check('K3: the right system prompt with a tool the seed did not carry is flagged kind=tools_changed (sections=tools) and read 1411 — the check covers the tools set, so the count carries the turn\'s tools too', Array.isArray(k3.request.tools) && (k3.request.tools as unknown[]).length === 1 && k3.response.status === 200 && k3.response.input_tokens === 1411 && (mismatch(k3) ?? '').includes('kind=tools_changed') && (mismatch(k3) ?? '').includes('sections=tools'), { input_tokens: k3.response.input_tokens, header: mismatch(k3) })
  check('K4: the seed\'s system blocks with the thinking block removed read 1049 with no header, so the block counted 740 tokens — the seed billed 738 thinking tokens', k4.response.status === 200 && k4.response.input_tokens === 1049 && mismatch(k4) === undefined && (k2.response.input_tokens ?? 0) - (k4.response.input_tokens ?? 0) === 740 && Math.abs(740 - 738) <= 2 && second.figures.thinking_size === 740, { input_tokens: k4.response.input_tokens, thinking: second.figures.thinking_size })
  check('K1 against K4: the system blocks themselves are 112 tokens', (k4.response.input_tokens ?? 0) - (k1.response.input_tokens ?? 0) === 112 && second.figures.system_size === 112)
  check('K5: the product road countMessagesTokensWithAPI carried the same blocks byte-equal to the seed\'s, got 1789 with no header, and hit the count endpoint once', k5.road === 'countMessagesTokensWithAPI' && k5.request.system_byte_equal_to_seed === true && show(k5.request.thinking) === show({ type: 'adaptive' }) && k5.response.status === 200 && k5.response.count === 1789 && k5.response.count === k2.response.input_tokens && mismatch(k5) === undefined && show(k5.request.wire_hits) === show([{ path: '/v1/messages/count_tokens', status: 200 }]), { count: k5.response.count, header: mismatch(k5), hits: k5.request.wire_hits })
  check('K6 and K7: the request prefix with the counter\'s placeholder read 122 and the placeholder alone 10, both without a header', k6.response.status === 200 && k6.response.input_tokens === 122 && k7.response.status === 200 && k7.response.input_tokens === 10 && mismatch(k6) === undefined && mismatch(k7) === undefined && show((k6.request as { messages?: unknown }).messages) === show([{ role: 'user', content: 'hi' }]), { k6: k6.response.input_tokens, k7: k7.response.input_tokens })
  check('/context\'s Messages row: 1789 - 122 + 10 = 1677 against 937 before — a rise of exactly the thinking block, the system prompt taken back out to the token', second.figures.messages_row === 1677 && second.figures.messages_row_before === 937 && second.figures.rise === 740 && 1789 - 122 + 10 === 1677 && 1677 - 937 === 740)
  check('K1–K5 each replayed the seed\'s signed block verbatim; K4 alone dropped it', [k1, k2, k3, k5].every(l => ((l.request.messages as Array<{ role: string; content: unknown }>)[1]?.content as Array<Record<string, unknown>>)?.some(block => block.type === 'thinking' && block.signature === 'sig_***' && (block.signature_chars as number) > 0)) && !((k4.request.messages as Array<{ role: string; content: unknown }>)[1]?.content as Array<Record<string, unknown>>).some(block => block.type === 'thinking'))
  const analyzer = read('src/utils/analyzeContext.ts')
  const counter = read('src/services/tokenEstimation.ts')
  check('the product: the counter takes the system blocks as its third argument and sends them as the request\'s system field; /context derives the row as request minus prefix plus placeholder', counter.includes('system?: readonly TextBlockParam[]') && counter.includes("...(carried !== undefined ? { system: carried as never } : {})") && analyzer.includes('return Math.max(0, request - prefix + placeholder)') && analyzer.includes('buildTurnSystemBlocks('))
}

console.log(failures === 0 ? '\nALL TOKEN-COUNT THINKING RECEIPT PROOFS PASS' : `\nFAIL — ${failures} token-count thinking receipt check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
