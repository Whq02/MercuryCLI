#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { tellSessionStorageTheBuiltInCommands } from '../../src/sessions/transcripts/builtInCommands.js'
import { extractFirstPromptFromChunk } from '../../src/sessions/transcripts/sessionListings.js'

let failures = 0
const extractorHint = 'change extractFirstPromptFromChunk in src/sessions/transcripts/sessionListings.ts so this input gives the expected title'
function check(label: string, cond: boolean, detail = extractorHint): void {
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
tellSessionStorageTheBuiltInCommands(() => new Set(['model']))
check(
  'a session whose only act is a built-in command has no name from it',
  extractFirstPromptFromChunk(
    record(2, { kind: 'input', content: '<command-name>/model</command-name><command-args></command-args>' }) + '\n',
  ) === '',
  'change extractFirstPromptFromHead in src/sessions/transcripts/sessionStoragePortable.ts so a built-in command alone returns the empty string',
)
check(
  'a command that is no built-in still falls back to its CLEAN name (never raw markup)',
  extractFirstPromptFromChunk(
    record(2, { kind: 'input', content: '<command-name>/deploy</command-name><command-args></command-args>' }) + '\n',
  ) === '/deploy',
  'change extractFirstPromptFromHead in src/sessions/transcripts/sessionStoragePortable.ts so a non-built-in command still falls back to its clean name',
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
