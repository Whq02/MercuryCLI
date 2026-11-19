#!/usr/bin/env bun
import { getFlagSpec } from '../../src/substrate/flagRegistry.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

section('the reader is the one owner of the transcript file')
{
  const readerRow = getFlagSpec('MERCURY_TRANSCRIPT_READER')
  check('the registry row names the reader and its evidence', readerRow?.kind === 'default-on' && readerRow.tier === 'behavioral' && readerRow.evidence === 'scripts/sessionStorage/prove-transcript-tail-reader.ts')
}
console.log(failures === 0 ? '\n✅ ALL TRANSCRIPT-CONSUMER-OWNERSHIP PROOFS PASS' : `\n❌ ${failures} TRANSCRIPT-CONSUMER-OWNERSHIP PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
