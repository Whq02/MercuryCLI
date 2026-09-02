#!/usr/bin/env bun
// ============================================================================
//  scripts/core-runtime/prove-metering-s3-truth.ts — the FN-018 S3 rows,
//  each at its owner: a figure that meant the wrong thing, a glyph beside
//  the wrong word, a billed call outside the ledger.
//
//   §16 the count-token probe's billed request joins the ledger
//   §17 the partial fold reports a real post figure
//   §19 the picker's supercode persists like /effort
//   §20 one definition of progress.tokenCount across the two task lanes
//   §21 the coordinator gauge counts the round's output
//   §22 the compaction trace subtracts the true post figure
//   §23 the effort toast's glyph follows the applied tier (driven)
//
//  Run:  ~/.bun/bin/bun run scripts/core-runtime/prove-metering-s3-truth.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
for (const key of ['MERCURY_EFFORT_LEVEL', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'MERCURY_AUTH_SCOPE_DIR']) delete process.env[key]
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-s3-'))
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:9'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

console.log('the metering S3 rows, each at its owner')

section('§16 the count-token probe folds its billed usage into the ledger')
{
  const src = read('src/services/tokenEstimation.ts')
  const probe = src.slice(src.indexOf('export async function countTokensViaHaikuFallback'), src.indexOf('export function roughTokenCountEstimation('))
  check('the probe settles its response usage through addToTotalSessionCost at the pinned price', /addToTotalSessionCost\(calculateUSDCost\(model, billed\), billed, model\)/.test(probe))
  check('…on the very usage the response carried (input, output, both cache families)', /cache_creation_input_tokens: usage\.cache_creation_input_tokens \?\? 0/.test(probe) && /cache_read_input_tokens: usage\.cache_read_input_tokens \?\? 0/.test(probe))
}

section('§17 the partial fold reports a real post figure')
{
  const src = read('src/services/compact/compact.ts')
  check('the partial path computes truePostCompactTokenCount over its own post-compact messages', /truePostCompactTokenCount: estimateContextTokens\(buildPostCompactMessages\(partialResult\)\)/.test(src))
  check('…so the summary card no longer falls back to the call\'s billed usage', !/no true-post estimate/.test(src))
}

section('§19 the picker\'s supercode persists like /effort')
{
  const src = read('src/commands/model/mercuryModel.tsx')
  const branch = src.slice(src.indexOf("if (mode === 'supercode') {"), src.indexOf("// A real effort level; selecting it clears supercode"))
  check('the supercode branch persists effortLevel max + supercodeEffort (the /effort contract)', /updateSettingsForSource\('userSettings', \{ effortLevel: 'max', supercodeEffort: true \}\)/.test(branch), branch.slice(0, 120))
  check('…and releases the launch pins first', /unpinAllLaunchEffort\(\)/.test(branch))
  check('…before the session state flips', branch.indexOf('updateSettingsForSource') < branch.indexOf('setAppState'))
  const effortCmd = read('src/commands/effort/effort.tsx')
  check('the /effort command still writes the same two fields (one contract, two doors)', /effortLevel: 'max',\s*\n\s*supercodeEffort: true,/.test(effortCmd))
}

section('§20 one definition of progress.tokenCount')
{
  const main = read('src/tasks/LocalMainSessionTask.ts')
  check('the main-session task reads the wire usage (last input side + running output) when present', /latestInputTokens = latest/.test(main) && /totalOutputTokens \+= usage\.output_tokens \?\? 0/.test(main))
  check('…and reports it as tokenCount, the estimate standing in only before any usage', /const tokensSnapshot = sawUsage \? latestInputTokens \+ totalOutputTokens : estimatedTokens/.test(main))
  const agent = read('src/tasks/LocalAgentTask/LocalAgentTask.tsx')
  check('the agent task defines the same quantity (latest input + total output)', /return tracker\.latestInputTokens \+ tracker\.totalOutputTokens/.test(agent))
}

section('§21 the coordinator gauge counts the round\'s output')
{
  const src = read('src/services/concourse/coordinatorCall.ts')
  const fn = src.slice(src.indexOf('function roundContextTokensOf'), src.indexOf('function textBlocksOf'))
  check('the round context is the four-field total (input + cache reads + cache writes + output)', /return n\(input\) \+ n\(read\) \+ n\(write\) \+ n\(output\)/.test(fn), fn.slice(-160))
  check('…and still declines to stamp when no input side was reported', /if \(typeof input !== 'number' && typeof read !== 'number' && typeof write !== 'number'\) return undefined/.test(fn))
}

section('§22 the compaction trace subtracts the true post figure')
{
  const src = read('src/run-core/turn-machine.ts')
  check('tokensFreed = pre − (truePostCompactTokenCount ?? postCompactTokenCount)', /const postForTrace = truePostCompactTokenCount \?\? postCompactTokenCount/.test(src) && /preCompactTokenCount - postForTrace/.test(src))
  check('…never pre − the summarisation call\'s own usage', !/\? preCompactTokenCount - postCompactTokenCount/.test(src))
}

section('§23 the effort toast\'s glyph follows the applied tier')
{
  const { getEffortNotificationText } = await import('../../src/components/EffortIndicator.ts')
  const figures = await import('../../src/constants/figures.ts')
  // The helper's signature is (effortValue, model).
  const medium = getEffortNotificationText('medium', 'kimi-k3') ?? ''
  check("medium on kimi-k3 (applied low): the LOW glyph beside the word low (the base paired the medium glyph with 'low')", medium.startsWith(`${figures.EFFORT_LOW} effort: low`), medium)
  const xhigh = getEffortNotificationText('xhigh', 'glm-5.3') ?? ''
  check('xhigh on glm-5.3 (applied high): the HIGH glyph beside the word high', xhigh.startsWith(`${figures.EFFORT_HIGH} effort: high`), xhigh)
  const src = read('src/components/EffortIndicator.ts')
  check('both halves come from the resolution (getDisplayedEffortLevel for the glyph)', /SYMBOLS\[getDisplayedEffortLevel\(model, effortValue\)\]/.test(src))
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-metering-s3-truth${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
