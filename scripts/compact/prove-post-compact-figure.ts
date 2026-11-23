#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
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

const { roughTokenCountEstimation } = await import('../../src/models/facts/tokenEstimation.ts')
const { estimateMessageTokens, estimateContextTokens } = await import('../../src/engine/compaction/pruneToolResults.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/engine/messages/messages.ts')

console.log('the post-compact figure counts what the fold restored')

section('§1 the real estimators over the post-compact shape')
{
  const summaryText = 'SUMMARY: ' + 'the operator adjusted modules and asked to land the change. '.repeat(120)
  const summary = createUserMessage({ content: summaryText }) as never
  const kept = createAssistantMessage({ content: [{ type: 'text', text: 'reply: module 5 adjusted. '.repeat(20) }] } as never) as never
  const post = [summary, kept]
  const oldFigure = estimateMessageTokens(post as never)
  const newFigure = estimateContextTokens(post as never)
  const summaryAlone = roughTokenCountEstimation(summaryText)
  check('the string-bodied summary is thousands of tokens (the fixture is meaningful)', summaryAlone > 1500, `${summaryAlone}; roughTokenCountEstimation in src/models/facts/tokenEstimation.ts returned too little for the fixture, so check that function or lengthen summaryText in this script`)
  check('THE OLD ESTIMATOR DROPPED THE STRING SUMMARY (the receipt\'s "after" figure omitted it)', oldFigure < summaryAlone / 2, `old=${oldFigure} summary=${summaryAlone}; estimateMessageTokens in src/engine/compaction/pruneToolResults.ts now counts string-bodied messages, so this script no longer shows the old gap and its fixture or label needs updating`)
  check('the new figure counts the summary', newFigure >= summaryAlone, `new=${newFigure}; estimateContextTokens in src/engine/compaction/pruneToolResults.ts must count a string-bodied user message`)
  check('…and the kept tail beside it', newFigure > summaryAlone, `new=${newFigure} summary=${summaryAlone}; estimateContextTokens in src/engine/compaction/pruneToolResults.ts must also count the kept assistant message`)
  const rawSum = summaryAlone + roughTokenCountEstimation('reply: module 5 adjusted. '.repeat(20))
  check('the figure counts the summary AND the tail under the estimator\'s one headroom factor', newFigure >= rawSum && newFigure <= Math.ceil((rawSum * 4) / 3) + 8, `new=${newFigure} raw=${rawSum}; estimateContextTokens in src/engine/compaction/pruneToolResults.ts must count summary plus tail once, with at most the one 4/3 headroom factor`)
}


console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-post-compact-figure${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
