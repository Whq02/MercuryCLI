import assert from 'node:assert/strict'

;(globalThis as any).MACRO = { VERSION: 'proof', PACKAGE_URL: 'https://example.invalid' }
const { WebSearchTool } = await import('../../src/tools/WebSearchTool/WebSearchTool.js')
const { ProviderSearchTool } = await import('../../src/tools/WebSearchTool/ProviderSearchTool.js')

const answer = 'The vendor page lists the 2026-09 release as grok-4.8 and names 2026-09-01 as its date.'
const output = {
  query: 'xAI grok-4.8 release date',
  results: [
    answer,
    { tool_use_id: 'srvtoolu_1', content: [{ title: 'xAI models', url: 'https://docs.x.ai/developers/models', snippet: '', source_type: 'provider' as const }] },
  ],
  durationSeconds: 2,
  via: 'anthropic-native',
  tier: 'native' as const,
}
for (const tool of [WebSearchTool, ProviderSearchTool]) {
  const block = tool.mapToolResultToToolResultBlockParam(output, 'proof')
  const content = String(block.content)
  assert.ok(content.includes('2026-09-01'), `${tool.name}: the provider's own search answer is the native door's evidence; the model must see its words, labelled as the provider's — got: ${content}`)
  assert.ok(Buffer.byteLength(content) < 8000, `${tool.name}: bounded`)
}
console.log("PASS native search answer reaches the model: the provider's search text rides the result, labelled, beside the links")
