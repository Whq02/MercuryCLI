#!/usr/bin/env bun
// ============================================================================
//  scripts/sessionStorage/prove-first-prompt-extractor.ts — the S1 label
//  leak class: the first-prompt extractor must recognize input RECORDS, so
//  no transcript bypasses the filter and lets the raw head 'content'
//  scrape paint <command-name> markup into session labels. Pins the record
//  format through the ONE extractor; a line outside the record format
//  contributes nothing.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { extractFirstPromptFromChunk } from '../../src/utils/sessionStorage/logs.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' first-prompt extractor — input records through ONE extractor')
console.log('============================================================')

const record = (o: number, payload: unknown): string =>
  JSON.stringify({ recordId: `r${o}`, ordinal: o, payload })

check(
  'a retired-format line contributes nothing (never a scraped label)',
  extractFirstPromptFromChunk(
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'other-era line' } }) + '\n',
  ) === '',
)
check(
  'the real prompt extracts past a command-wrapped opener (the S1 leak shape)',
  extractFirstPromptFromChunk(
    [
      record(1, { kind: 'session-meta', metaKind: 'header', fields: {} }),
      record(2, { kind: 'input', content: '<command-name>/model</command-name><command-args></command-args>' }),
      record(3, { kind: 'input', content: 'refactor the wallet enumeration' }),
    ].join('\n') + '\n',
  ) === 'refactor the wallet enumeration',
)
check(
  'a command-only session falls back to the CLEAN command name (never raw markup)',
  extractFirstPromptFromChunk(
    record(2, { kind: 'input', content: '<command-name>/model</command-name><command-args></command-args>' }) + '\n',
  ) === '/model',
)
check(
  'hidden/virtual inputs never title a session',
  extractFirstPromptFromChunk(
    record(2, { kind: 'input', content: 'virtual tick', meta: { isVirtual: true } }) + '\n',
  ) === '',
)
check(
  'array content walks fabric text blocks (`kind`, never a wire `type`)',
  extractFirstPromptFromChunk(
    record(2, { kind: 'input', content: [{ kind: 'text', text: 'block prompt' }] }) + '\n',
  ) === 'block prompt',
)

console.log('\n' + '═'.repeat(60))
if (failures > 0) {
  console.error(`❌ ${failures} FIRST-PROMPT PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ FIRST-PROMPT EXTRACTOR PROVEN (records only, no markup leak)')
