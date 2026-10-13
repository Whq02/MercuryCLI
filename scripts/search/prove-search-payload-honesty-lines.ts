import assert from 'node:assert/strict'

;(globalThis as any).MACRO = { VERSION: 'proof', PACKAGE_URL: 'https://example.invalid' }
const { mapSearchResult } = await import('../../src/tools/WebSearchTool/searchOutput.js')
const { searchPayload, SEARCH_PAYLOAD_TOKEN_CEILING } = await import('../../src/services/search/searchPayload.js')
const { DUCKDUCKGO_TERMS } = await import('../../src/services/search/searchSetting.js')
const { KEYED_DOOR_REMEDY, MAX_SNIPPET_CHARS, DEFAULT_MAX_RESULTS, failureLine, viaLine } = await import('../../src/services/search/searchContract.js')
const { roughTokenCountEstimation } = await import('../../src/services/tokenEstimation.js')

const sentence = 'The committee reviewed the quarterly figures while the engineers discussed the migration plan for the service and its rollout. '
const snippet = sentence.repeat(5).slice(0, MAX_SNIPPET_CHARS)
const hits = Array.from({ length: DEFAULT_MAX_RESULTS }, (_, i) => ({
  title: `Result ${i + 1}: the migration plan for the service and its quarterly review`,
  url: `https://docs.example.org/articles/2026/10/migration-plan-${i + 1}?ref=search&lang=en`,
  snippet,
  source_type: 'duckduckgo' as const,
}))
const failures = [
  failureLine({ ok: false, kind: 'provider-refused', via: 'anthropic-native', message: 'the provider answered 400 invalid_request: web_search is not enabled for this organization' }),
  failureLine({ ok: false, kind: 'rate-limited', via: 'brave', message: 'wait 27s; no request made' }),
  failureLine({ ok: false, kind: 'no-backend', via: 'stackexchange', message: 'Stack Exchange found no matching links' }),
  failureLine({ ok: false, kind: 'no-backend', via: 'searxng', message: 'no metasearch instance configured; MERCURY_SEARCH_SEARXNG_INSTANCES adds instances whose API-use policy you verified' }),
]
const unverified = 'Unverified web text; cite relevant URLs as markdown links.'
const via = viaLine('duckduckgo', 'keyless')

const block = mapSearchResult({ query: 'migration plan', results: [{ tool_use_id: 'g1', content: hits }], durationSeconds: 1, via: 'duckduckgo', tier: 'keyless', notes: [DUCKDUCKGO_TERMS, ...failures], hint: KEYED_DOOR_REMEDY }, 'proof')
const payload = String(block.content)
const parsed = JSON.parse(payload) as { hits: { snippet: string; source_type: string }[]; notes: string[] }
assert.ok(parsed.notes.includes(via), `the via line names the door that answered; it must survive the notes budget — notes kept: ${JSON.stringify(parsed.notes)}`)
assert.ok(parsed.notes.includes(unverified), `the unverified-text line is the law's own sentence; it must survive the notes budget — notes kept: ${JSON.stringify(parsed.notes)}`)
assert.ok(parsed.notes.includes(DUCKDUCKGO_TERMS), 'the first-use terms notice must survive the notes budget')

const whole = searchPayload(hits, [via, unverified])
const kept = JSON.parse(whole) as { hits: { snippet: string }[] }
const estimate = roughTokenCountEstimation(JSON.stringify({ hits, notes: [via, unverified] }))
assert.ok(estimate < SEARCH_PAYLOAD_TOKEN_CEILING, `the full ten-hit answer measures ${estimate} tokens by the tree's own estimator, under the ${SEARCH_PAYLOAD_TOKEN_CEILING} ceiling`)
assert.equal(kept.hits.length, DEFAULT_MAX_RESULTS, `an answer whose token estimate is under the ceiling reaches the model whole: ${kept.hits.length} of ${DEFAULT_MAX_RESULTS} hits delivered`)
assert.equal(kept.hits.filter(hit => hit.snippet !== '').length, DEFAULT_MAX_RESULTS, `every delivered hit keeps its snippet: ${kept.hits.filter(hit => hit.snippet !== '').length} of ${DEFAULT_MAX_RESULTS} snippets delivered`)
console.log(`PASS search payload honesty lines: the via line, the unverified line and the terms notice survive the budget; ten hits with snippets (${estimate} estimated tokens) reach the model whole`)
