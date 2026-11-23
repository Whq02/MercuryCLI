#!/usr/bin/env bun
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'mercury-retain-honesty-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail || (!cond && hint) ? ` — ${!cond && hint ? `${hint}${detail ? ' | ' : ''}` : ''}${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { retainItems, _resetMemoryVerbSessionStateForTesting } = await import('../../src/sessions/mneme/memoryVerbs.js')
const { RetainTool } = await import('../../src/tools/memory/MemoryTools.js')
const { mnemeLibraryDir } = await import('../../src/sessions/mneme/mnemeGates.js')

section('a read-only library dir: the failure surfaces PER ITEM')
const lockedDir = join(scratch, 'locked-lib')
mkdirSync(lockedDir, { recursive: true })
chmodSync(lockedDir, 0o555)
const locked = retainItems([{ content: 'this cannot land' }], { session: 'honesty' }, lockedDir)
check('outcome is a typed per-item refusal', locked[0]?.status === 'refused', JSON.stringify(locked), 'a write failure in retainItems in src/sessions/mneme/memoryVerbs.ts must come back as a refused outcome for that item, not a throw or a stored status')
check('the reason says the fact was NOT stored', locked[0]?.status === 'refused' && locked[0].reason.includes('NOT stored'), JSON.stringify(locked), 'the refusal reason built in retainItems in src/sessions/mneme/memoryVerbs.ts must say the fact was NOT stored')
chmodSync(lockedDir, 0o755)

section('mixed batch: healthy items store while the broken one refuses')
_resetMemoryVerbSessionStateForTesting()
const mixed = retainItems(
  [{ content: 'a healthy fact' }, { content: '   ' }, { content: 'another healthy fact' }],
  { session: 'honesty' },
  mnemeLibraryDir(),
)
check('item 0 stored', mixed[0]?.status === 'stored', JSON.stringify(mixed[0]), 'retainItems in src/sessions/mneme/memoryVerbs.ts must store a healthy item in a mixed batch')
check('item 1 refused (empty content), typed', mixed[1]?.status === 'refused' && mixed[1].reason.includes('empty'), JSON.stringify(mixed[1]), 'retainItems in src/sessions/mneme/memoryVerbs.ts must refuse blank content with a reason naming empty')
check('item 2 stored — the batch never aborts on a sibling', mixed[2]?.status === 'stored', JSON.stringify(mixed[2]), 'retainItems in src/sessions/mneme/memoryVerbs.ts must keep storing items after a refused sibling')

section('memory switched off mid-call: refused with the switch named, never a silent success')
process.env.MERCURY_BARE = '1'
const off = retainItems([{ content: 'stored nowhere' }], { session: 'honesty' })
check('refused with memory off named', off[0]?.status === 'refused' && off[0].reason.includes('memory is off'), JSON.stringify(off), 'retainItems in src/sessions/mneme/memoryVerbs.ts must refuse with the words memory is off when memory is switched off')
delete process.env.MERCURY_BARE

section('the tool result never papers over refusals')
const blockAllRefused = RetainTool.mapToolResultToToolResultBlockParam(
  { outcomes: [{ index: 0, status: 'refused', reason: 'disk error' }], stored: 0, refused: 1 },
  'tid',
)
check('all-refused batch is an ERROR result', (blockAllRefused as { is_error?: boolean }).is_error === true, '', 'RetainTool.mapToolResultToToolResultBlockParam in src/tools/memory/MemoryTools.ts must set is_error when every item was refused')
check('the refusal text names the item and reason', String(blockAllRefused.content).includes('REFUSED — disk error'), '', 'RetainTool.mapToolResultToToolResultBlockParam in src/tools/memory/MemoryTools.ts must print REFUSED with the reason for each refused item')
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
check('mixed batch reports BOTH outcomes per item', String(blockMixed.content).includes('stored → pending:x') && String(blockMixed.content).includes('REFUSED — over cap'), '', 'RetainTool.mapToolResultToToolResultBlockParam in src/tools/memory/MemoryTools.ts must list both the stored id and the refusal of a mixed batch')

console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ ALL RETAIN-HONESTY PROOFS PASS' : `❌ ${failures} RETAIN-HONESTY PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
