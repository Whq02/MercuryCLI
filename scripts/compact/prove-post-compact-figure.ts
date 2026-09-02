#!/usr/bin/env bun
// ============================================================================
//  scripts/compact/prove-post-compact-figure.ts — the /compact receipt's
//  "after" figure counts the summary and every restored attachment
//  (FN-018 rank 9).
//
//  truePostCompactTokenCount was estimateMessageTokens (the micro-compact
//  estimator) over the post-compact messages: it skips every message that
//  is not user/assistant, skips a STRING body, and multiplies by 4/3 — so
//  the boundary marker, the summary (string content) and every restored
//  attachment counted zero, while the pre side used tokenEstimation's
//  estimator, which counts strings and attachments and applies no 4/3. A
//  fold restoring 40,000 tokens of attachments and a 6,000-token summary
//  onto a 12,000-token tail was reported as "180.0k to 12.0k", and the same
//  wrong figure rode the context-epoch ledger as tokensAfter. The
//  whole-context estimator (microCompact's estimateContextTokens, which
//  main landed for the same defect — strings, attachments, system rows,
//  one uniform headroom factor, over the one character-ratio owner) now
//  sits on both compaction owners' post side.
//
//   §1 the mechanism, with the real estimators: the old figure drops the
//      string summary; the new counts it and the restored attachment
//   §2 the shape: both compaction owners take the post figure from the
//      pre side's estimator family; the fill reads the same family
//
//  Run:  ~/.bun/bin/bun run scripts/compact/prove-post-compact-figure.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-post-compact-'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')

const { roughTokenCountEstimation } = await import('../../src/services/tokenEstimation.ts')
const { estimateMessageTokens, estimateContextTokens } = await import('../../src/services/compact/microCompact.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')

console.log('the post-compact figure counts what the fold restored')

// ── §1 the mechanism ────────────────────────────────────────────────────────
section('§1 the real estimators over the post-compact shape')
{
  const summaryText = 'SUMMARY: ' + 'the operator adjusted modules and asked to land the change. '.repeat(120)
  const summary = createUserMessage({ content: summaryText }) as never
  const kept = createAssistantMessage({ content: [{ type: 'text', text: 'reply: module 5 adjusted. '.repeat(20) }] } as never) as never
  const post = [summary, kept]
  const oldFigure = estimateMessageTokens(post as never)
  const newFigure = estimateContextTokens(post as never)
  const summaryAlone = roughTokenCountEstimation(summaryText)
  check('the string-bodied summary is thousands of tokens (the fixture is meaningful)', summaryAlone > 1500, String(summaryAlone))
  check('THE OLD ESTIMATOR DROPPED THE STRING SUMMARY (the receipt\'s "after" figure omitted it)', oldFigure < summaryAlone / 2, `old=${oldFigure} summary=${summaryAlone}`)
  check('the new figure counts the summary', newFigure >= summaryAlone, `new=${newFigure}`)
  check('…and the kept tail beside it', newFigure > summaryAlone)
  // The landed whole-context estimator applies the compaction layer's 4/3
  // headroom uniformly (main's decision — one factor on every compaction
  // owner): the figure is bounded by the raw character estimate below and
  // that estimate under the factor above.
  const rawSum = summaryAlone + roughTokenCountEstimation('reply: module 5 adjusted. '.repeat(20))
  check('the figure counts the summary AND the tail under the estimator\'s one headroom factor', newFigure >= rawSum && newFigure <= Math.ceil((rawSum * 4) / 3) + 8, `new=${newFigure} raw=${rawSum}`)
}

// ── §2 the shape ────────────────────────────────────────────────────────────
section('§2 the shape: one estimator family on both sides')
{
  const compact = readFileSync(join(ROOT, 'src/services/compact/compact.ts'), 'utf8')
  check('compact.ts takes the true post figure from the whole-context estimator over the post-compact messages', /truePostCompactTokenCount = estimateContextTokens\(buildPostCompactMessages\(partial\)\)/.test(compact))
  check('…and the partial fold too (the same owner, never the call\'s billed usage)', /truePostCompactTokenCount: estimateContextTokens\(buildPostCompactMessages\(partialResult\)\)/.test(compact))
  check('…and no longer from the round estimator', !/truePostCompactTokenCount = estimateMessageTokens\(/.test(compact))
  const memory = readFileSync(join(ROOT, 'src/services/compact/sessionMemoryCompact.ts'), 'utf8')
  check('the session-memory fold takes its summary estimate from the same owner', /const summaryEstimate = estimateContextTokens\(\[summaryMessage\]\)/.test(memory))
  const micro = readFileSync(join(ROOT, 'src/services/compact/microCompact.ts'), 'utf8')
  const estimator = micro.slice(micro.indexOf('export function estimateContextTokens'), micro.indexOf('export function estimateContextTokens') + 1400)
  check('the whole-context estimator counts string bodies, attachments and system rows over the one character-ratio owner', /typeof content === 'string'/.test(estimator) && /case 'attachment':/.test(estimator) && /case 'system':/.test(estimator) && /roughTokenCountEstimation\(/.test(estimator))
  const epoch = compact.slice(compact.indexOf('advanceContextEpoch(owner, {'), compact.indexOf('advanceContextEpoch(owner, {') + 400)
  check('the context-epoch ledger rides the corrected figure as tokensAfter', /tokensAfter: truePostCompactTokenCount/.test(epoch))
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-post-compact-figure${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
