#!/usr/bin/env bun
// ============================================================================
//  scripts/context/prove-context-free-space-agreement.ts — /context's
//  breakdown, grid and Free space are computed from the SAME numerator as
//  its headline (FN-018 rank 14).
//
//  The headline is the compaction trigger's own count (the recorded wire
//  usage plus the tail after it) whenever a response has settled; the
//  breakdown rows, the grid and Free space were computed from the measured
//  categories alone. Off the Anthropic route both token counters answer
//  null, so every measured category coalesces to 0: a 200,000-token window
//  holding 120,000 real tokens printed the headline "120,000/200,000 (60%)"
//  beside "Free space 197,000" and a grid painted almost entirely free —
//  two irreconcilable answers to how much room is left on one screen, and
//  the disclosure line did not say the grid and Free space were wrong.
//  Whatever the headline counts beyond the measured categories now rides
//  its own row, so rows, grid and Free space add up to the headline.
//
//   §1 DRIVEN: a settled transcript with recorded usage and no counter —
//      the headline, the unmeasured row, Free space and the grid agree
//   §2 DRIVEN: no recorded usage — the measured categories stand alone,
//      no unmeasured row is minted
//   §3 the shape and the disclosure words
//
//  Run:  ~/.bun/bin/bun run scripts/context/prove-context-free-space-agreement.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_MODEL', 'MERCURY_SIMPLE', 'MERCURY_DISABLE_1M_CONTEXT']) {
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-ctx-free-'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { analyzeContextUsage } = await import('../../src/utils/analyzeContext.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')

const MODEL = 'claude-fable-5-1'
const agents = { activeAgents: [], allAgents: [] }
type Usage = { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }
let n = 0
const assistant = (usage: Usage, text: string): unknown => ({
  type: 'assistant',
  uuid: `a-${++n}`,
  timestamp: new Date().toISOString(),
  message: { id: `msg_${n}`, model: MODEL, role: 'assistant', content: [{ type: 'text', text }], usage, stop_reason: 'end_turn' },
})
const analyze = (messages: unknown[]) =>
  analyzeContextUsage(messages as never, MODEL, async () => getEmptyToolPermissionContext(), [], agents, 120, { options: {} } as never)
const row = (data: Awaited<ReturnType<typeof analyze>>, name: string) => data.categories.find(c => c.name === name)
const usedSquares = (data: Awaited<ReturnType<typeof analyze>>): number =>
  data.gridRows.flat().filter(square => (square as { color?: string }).color !== 'promptBorder').length

console.log('/context: one numerator for the headline, the rows, the grid and Free space')

// ── §1 recorded usage, no counter ───────────────────────────────────────────
section('§1 a settled transcript with recorded usage: the screen adds up to its headline')
{
  const usage: Usage = { input_tokens: 100_000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 20_000 }
  const data = await analyze([createUserMessage({ content: 'the operator asks' }), assistant(usage, 'the settled answer')])
  const recorded = 120_500
  check('the counters answered nothing here (the fixture is the off-route shape)', data.countsAvailable === false)
  check('the headline is the recorded usage', data.totalTokens === recorded, String(data.totalTokens))
  const unmeasured = row(data, 'Unmeasured (recorded usage)')
  check('THE UNMEASURED ROW CARRIES WHAT THE HEADLINE COUNTS BEYOND THE MEASURED ROWS (the base minted no such row)', unmeasured !== undefined && unmeasured.tokens === recorded, JSON.stringify(unmeasured))
  const free = row(data, 'Free space')
  const reserve = data.categories.find(c => c.name === 'Autocompact buffer' || c.name === 'Compact buffer')
  check('FREE SPACE FOLLOWS THE HEADLINE (the base overstated it by the whole recorded usage)', free !== undefined && reserve !== undefined && free.tokens === Math.max(0, data.maxTokens - recorded - reserve.tokens), `free=${String(free?.tokens)} window=${data.maxTokens} reserve=${String(reserve?.tokens)}`)
  const contentSum = data.categories.filter(c => !c.isDeferred).reduce((t, c) => t + c.tokens, 0)
  check('the rows add up to the window (content + reserve + free)', contentSum === data.maxTokens, `${contentSum} vs ${data.maxTokens}`)
  check('the grid paints the used share (the base painted it almost entirely free)', usedSquares(data) >= Math.floor((recorded / data.maxTokens) * data.gridRows.flat().length) - 1, String(usedSquares(data)))
  check('the percentage is the headline over the window', data.percentage === Math.round((recorded / data.maxTokens) * 100), String(data.percentage))
}

// ── §2 no recorded usage ────────────────────────────────────────────────────
section('§2 no recorded usage: the measured categories stand alone')
{
  const data = await analyze([createUserMessage({ content: 'a fresh session with no settled response' })])
  check('no unmeasured row is minted when the headline is the measured sum', row(data, 'Unmeasured (recorded usage)') === undefined, data.categories.map(c => c.name).join(' · '))
  const free = row(data, 'Free space')
  const reserve = data.categories.find(c => c.name === 'Autocompact buffer' || c.name === 'Compact buffer')
  const measured = data.categories.filter(c => !c.isDeferred && c.name !== 'Free space' && c !== reserve).reduce((t, c) => t + c.tokens, 0)
  check('Free space is the window less the measured content and the reserve', free !== undefined && reserve !== undefined && free.tokens === Math.max(0, data.maxTokens - measured - reserve.tokens))
}

// ── §3 the shape ────────────────────────────────────────────────────────────
section('§3 the shape and the disclosure words')
{
  const src = readFileSync(join(ROOT, 'src/utils/analyzeContext.ts'), 'utf8')
  check('the headline total is computed BEFORE the free-space math', src.indexOf("const totalTokens = fill.source === 'usage'") < src.indexOf('const freeSpace = Math.max('))
  check('free space is the window less the layout total (the larger of measured and recorded)', /const usedForLayout = Math\.max\(actualUsage, totalTokens\)/.test(src) && /contextWindow - usedForLayout - reserveTokens/.test(src))
  check('the unmeasured row rides the same push-only-when-positive rule', /pushContent\('Unmeasured \(recorded usage\)', unmeasured, 'inactive'\)/.test(src))
  const view = readFileSync(join(ROOT, 'src/components/ContextVisualization.tsx'), 'utf8')
  check('the disclosure line says the grid and free space follow the recorded usage', /the total, the grid and free space follow the recorded usage/.test(view))
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-context-free-space-agreement${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
