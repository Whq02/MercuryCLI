#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'HF_TOKEN', 'MERCURY_CONFIG_DIR', 'MERCURY_AUTH_SCOPE_DIR']) {
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-spend-total-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const ROOT = join(import.meta.dir, '..', '..')

const ledger = await import('../../src/cost-tracker.ts')
const { providerSessionSpend } = await import('../../src/services/providers/providerUsage.ts')

console.log('the session-spend view reports the prompt as sent')
ledger.resetCostState()
ledger.addToTotalSessionCost(
  0.75,
  { input_tokens: 8000, output_tokens: 500, cache_read_input_tokens: 120000, cache_creation_input_tokens: 40000, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 } } as never,
  'claude-sonnet-5',
)
const anthropic = providerSessionSpend('anthropic' as never)
check('THE ANTHROPIC COLUMN IS THE WHOLE PROMPT: 8,000 + 120,000 + 40,000 (the base reported 128,000)', anthropic.inputTokens === 168_000, String(anthropic.inputTokens))
check('output and cost ride unchanged', anthropic.outputTokens === 500 && anthropic.costUSD === 0.75 && anthropic.models === 1)

ledger.addToTotalSessionCost(
  0.2,
  { input_tokens: 3000, output_tokens: 100, cache_read_input_tokens: 700, cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 } } as never,
  'gpt-5.6-sol',
)
const openai = providerSessionSpend('openai' as never)
check('off the Anthropic lane cache-write is zero and the sum is unchanged: 3,000 + 700', openai.inputTokens === 3_700, String(openai.inputTokens))
check('lanes never cross (the Anthropic column stands)', providerSessionSpend('anthropic' as never).inputTokens === 168_000)

const src = readFileSync(join(ROOT, 'src/services/providers/providerUsage.ts'), 'utf8')
check('the sum carries all three input-side counters', /record\.inputTokens \+ record\.cacheReadInputTokens \+ record\.cacheCreationInputTokens/.test(src))
check('the field says what it names (read AND written prefix)', /prefix READ plus the\s*\n?\s*\*?\s*prefix WRITTEN/.test(src))

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-session-spend-prompt-total${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
