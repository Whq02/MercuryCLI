#!/usr/bin/env bun
// ============================================================================
//  scripts/memory/prove-retain-honesty.ts
//  PROOF (spec 06 C1): a failed retain is a PER-ITEM typed failure, never a
//  count that papers over swallowed errors. Injected failures: a read-only
//  library dir (the append physically cannot land), the backend off
//  mid-call, over-cap/empty content — each surfaces on ITS item while
//  healthy siblings in the same batch still store; the tool result marks
//  all-refused batches as errors.
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'mercury-retain-honesty-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_MNEME = '1'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { retainItems, _resetMemoryVerbSessionStateForTesting } = await import('../../src/memdir/memoryVerbs.js')
const { RetainTool } = await import('../../src/tools/MemoryTools/MemoryTools.js')
const { mnemeLibraryDir } = await import('../../src/memdir/mnemeGates.js')

section('a read-only library dir: the failure surfaces PER ITEM')
const lockedDir = join(scratch, 'locked-lib')
mkdirSync(lockedDir, { recursive: true })
chmodSync(lockedDir, 0o555)
const locked = retainItems([{ content: 'this cannot land' }], { session: 'honesty' }, lockedDir)
check('outcome is a typed per-item refusal', locked[0]?.status === 'refused', JSON.stringify(locked))
check('the reason says the fact was NOT stored', locked[0]?.status === 'refused' && locked[0].reason.includes('NOT stored'), JSON.stringify(locked))
chmodSync(lockedDir, 0o755)

section('mixed batch: healthy items store while the broken one refuses')
_resetMemoryVerbSessionStateForTesting()
const mixed = retainItems(
  [{ content: 'a healthy fact' }, { content: '   ' }, { content: 'another healthy fact' }],
  { session: 'honesty' },
  mnemeLibraryDir(),
)
check('item 0 stored', mixed[0]?.status === 'stored', JSON.stringify(mixed[0]))
check('item 1 refused (empty content), typed', mixed[1]?.status === 'refused' && mixed[1].reason.includes('empty'), JSON.stringify(mixed[1]))
check('item 2 stored — the batch never aborts on a sibling', mixed[2]?.status === 'stored', JSON.stringify(mixed[2]))

section('backend off mid-call: refused with the gate named, never a silent success')
process.env.MERCURY_MNEME = '0'
const off = retainItems([{ content: 'stored nowhere' }], { session: 'honesty' })
check('refused with MNEME named', off[0]?.status === 'refused' && off[0].reason.includes('MNEME'), JSON.stringify(off))
process.env.MERCURY_MNEME = '1'

section('the tool result never papers over refusals')
const blockAllRefused = RetainTool.mapToolResultToToolResultBlockParam(
  { outcomes: [{ index: 0, status: 'refused', reason: 'disk error' }], stored: 0, refused: 1 },
  'tid',
)
check('all-refused batch is an ERROR result', (blockAllRefused as { is_error?: boolean }).is_error === true)
check('the refusal text names the item and reason', String(blockAllRefused.content).includes('REFUSED — disk error'))
const blockMixed = RetainTool.mapToolResultToToolResultBlockParam(
  {
    outcomes: [
      { index: 0, status: 'stored', id: 'pending:x' },
      { index: 1, status: 'refused', reason: 'over cap' },
    ],
    stored: 1,
    refused: 1,
  },
  'tid',
)
check('mixed batch reports BOTH outcomes per item', String(blockMixed.content).includes('stored → pending:x') && String(blockMixed.content).includes('REFUSED — over cap'))

console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ ALL RETAIN-HONESTY PROOFS PASS' : `❌ ${failures} RETAIN-HONESTY PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
