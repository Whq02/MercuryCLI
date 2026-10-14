import assert from 'node:assert/strict'

;(globalThis as any).MACRO = { VERSION: 'proof', PACKAGE_URL: 'https://example.invalid' }
const contract = await import('../../src/services/search/searchContract.js')
const { decodeBraveWebSearch } = await import('../../src/services/search/brave.js')
const { decodeTavilySearch } = await import('../../src/services/search/tavily.js')
const { parseDuckDuckGoHtml, parseDuckDuckGoLite } = await import('../../src/services/search/duckduckgo.js')
const { WebSearchTool } = await import('../../src/tools/WebSearchTool/WebSearchTool.js')
const { ProviderSearchTool } = await import('../../src/tools/WebSearchTool/ProviderSearchTool.js')
const { searchTokenEstimate, SEARCH_PAYLOAD_TOKEN_CEILING } = await import('../../src/services/search/searchPayload.js')
for (const [source, decoded] of [
  ['brave', decodeBraveWebSearch({ web: { results: [{ title: 'B', url: 'https://example.com/b' }] } })],
  ['tavily', decodeTavilySearch({ results: [{ title: 'T', url: 'https://example.com/t' }] })],
  ['duckduckgo', parseDuckDuckGoHtml('<div class="result results_links"><a class="result__a" href="https://example.com/d">D</a></div>')],
  ['duckduckgo', parseDuckDuckGoLite('<a class="result-link" href="https://example.com/l">L</a>')],
] as const) {
  assert.equal(decoded.kind, 'results')
  if (decoded.kind !== 'results') throw new Error('decode failed')
  for (const hit of decoded.hits) {
    assert.equal(hit.source_type, source)
    assert.equal(typeof hit.snippet, 'string')
  }
}
for (const text of ['x', '汉字', '\\"\n', '🧭']) {
  const hits = contract.normaliseHits(Array.from({ length: 100 }, (_, i) => ({
    title: text.repeat(1000), url: `https://example.com/${i}`, snippet: text.repeat(1000), source_type: 'brave' as const,
  })), 100)
  assert.ok(hits.length <= contract.DEFAULT_MAX_RESULTS)
  assert.ok(hits.every(h => h.snippet.length <= contract.MAX_SNIPPET_CHARS))
  for (const tool of [WebSearchTool, ProviderSearchTool]) {
    const block = tool.mapToolResultToToolResultBlockParam({ query: text.repeat(20000), results: ['untrusted commentary'.repeat(5000), { tool_use_id: 'g', content: hits }], via: 'brave', tier: 'keyed', notes: [text.repeat(20000)], durationSeconds: 0 }, 'proof')
    const payload = String(block.content)
    assert.ok(searchTokenEstimate(payload) < SEARCH_PAYLOAD_TOKEN_CEILING, `token estimate ${searchTokenEstimate(payload)}`)
    const parsed = JSON.parse(payload)
    assert.ok(parsed.hits.length > 0)
    for (const hit of parsed.hits) assert.deepEqual(Object.keys(hit).sort(), ['snippet', 'source_type', 'title', 'url'])
    assert.ok(!payload.includes('untrusted commentary'))
  }
}
assert.equal(contract.normaliseHits([{ title: 'bad', url: 'javascript:alert(1)', snippet: '', source_type: 'brave' }]).length, 0)
console.log('PASS search result shape: every source named; strict hits; the characters/4 token estimate below 2,000')
