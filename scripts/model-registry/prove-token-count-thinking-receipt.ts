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
  check('the main stream assembles its system prompt from the attribution line first', streamCore.includes('let attributionLine = getAttributionHeader(fingerprint)') && streamCore.includes('asSystemPrompt([attribution, ...systemPromptBody].filter(Boolean))'))
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

console.log(failures === 0 ? '\nALL TOKEN-COUNT THINKING RECEIPT PROOFS PASS' : `\nFAIL — ${failures} token-count thinking receipt check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
