import assert from 'node:assert/strict'

;(globalThis as any).MACRO = { VERSION: 'proof', PACKAGE_URL: 'https://example.invalid' }
const { searchPayload, searchTokenEstimate, SEARCH_PAYLOAD_TOKEN_CEILING, SEARCH_PAYLOAD_NOTES_TOKEN_CAP } = await import('../../src/services/search/searchPayload.js')
const { DEFAULT_MAX_RESULTS } = await import('../../src/services/search/searchContract.js')

const via = 'via DuckDuckGo (keyless)'
const unverified = 'Unverified web text; cite relevant URLs as markdown links.'
const hits = Array.from({ length: DEFAULT_MAX_RESULTS }, (_, i) => ({
  title: `Result ${i + 1}: a long documentation page about the scheduler and its precedence rules`,
  url: `https://docs.example.org/reference/${i + 1}/${'section-'.repeat(80)}`,
  snippet: 'The scheduler applies the command line first, then the environment, then the file, then the defaults. '.repeat(4),
  source_type: 'duckduckgo' as const,
}))
assert.ok(searchTokenEstimate(JSON.stringify({ hits, notes: [via, unverified] })) >= SEARCH_PAYLOAD_TOKEN_CEILING, 'the fixture is an answer that cannot ride whole')

const payload = searchPayload(hits, ['note one'], [via, unverified])
const parsed = JSON.parse(payload) as { hits: { snippet: string }[]; notes: string[] }
assert.ok(searchTokenEstimate(payload) < SEARCH_PAYLOAD_TOKEN_CEILING, `the delivered answer stays under the ceiling: ${searchTokenEstimate(payload)}`)
assert.ok(parsed.hits.length > 0 && parsed.hits.length < DEFAULT_MAX_RESULTS, `whole hits are withheld to fit: ${parsed.hits.length} delivered`)
assert.ok(parsed.hits.every(hit => hit.snippet !== ''), 'a hit is cut before a snippet is cut: every delivered hit keeps its snippet')
const withheld = DEFAULT_MAX_RESULTS - parsed.hits.length
assert.ok(parsed.notes.includes(`${withheld} of ${DEFAULT_MAX_RESULTS} hits withheld to keep this answer under about 2,000 tokens (characters/4)`), `the cut is said in words — notes: ${JSON.stringify(parsed.notes)}`)
assert.deepEqual(parsed.notes.slice(0, 2), [via, unverified], 'the reserved lines ride first')
assert.ok(parsed.notes.includes('note one'), 'a short note survives beside the cut line')

const flood = Array.from({ length: 12 }, (_, i) => `door ${i + 1} left a line of its own: ${'words '.repeat(30)}`)
const noted = JSON.parse(searchPayload(hits.slice(0, 1), flood, [via, unverified])) as { notes: string[] }
assert.deepEqual(noted.notes.slice(0, 2), [via, unverified], 'the reserved lines are never dropped by the notes cap')
const others = noted.notes.slice(2)
assert.ok(others.length > 0 && others.length < flood.length, `the notes cap applies to the other notes: ${others.length} of ${flood.length} kept`)
assert.ok(searchTokenEstimate(JSON.stringify(others)) <= SEARCH_PAYLOAD_NOTES_TOKEN_CAP, 'the other notes stay under their cap')
assert.deepEqual(others, flood.slice(0, others.length), 'the other notes keep their order, the earliest first')

const whole = JSON.parse(searchPayload(hits.slice(0, 3), ['note one'], [via, unverified])) as { hits: unknown[]; notes: string[] }
assert.equal(whole.hits.length, 3)
assert.ok(!whole.notes.some(note => note.includes('withheld')), 'an answer that fits carries no cut line')
console.log('PASS search payload cut said: whole hits are withheld before any snippet, the withheld count is said in words, and the honesty lines ride first')
