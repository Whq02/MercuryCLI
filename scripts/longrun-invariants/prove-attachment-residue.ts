#!/usr/bin/env bun
// ============================================================================
//  scripts/longrun-invariants/prove-attachment-residue.ts — attachment residue.
//
//  What the code did vs the invariant it missed:
//   • critical_system_reminder had no dedup law: getAttachments runs once
//     per tool round, so the identical reminder re-attached on every round
//     of a multi-round turn.
//   • Persisted-output sizes were measured in UTF-16 code units but labelled
//     bytes — wrong in both directions on multi-byte output.
//
//  The invariant: an unchanged reminder attaches once per turn (changed
//  content still fires); a byte label measures bytes and a char budget says
//  chars. (The one-renderer §A leg retired with the room-context attachment.)
// ============================================================================
import { mkdtempSync, rmSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'attachment-residue-home-'))
process.env.MERCURY_CONFIG_DIR = HOME

await import('../../src/tasks.js')
const { getCriticalSystemReminderAttachment } = await import(
  '../../src/utils/attachments/sessionContext.js'
)
const { persistToolResult, buildLargeToolResultMessage, PREVIEW_SIZE_CHARS } = await import(
  '../../src/utils/toolResultStorage.js'
)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

section('§B critical_system_reminder: once per turn, changed content still fires')
{
  const ctx = { criticalSystemReminder_EXPERIMENTAL: 'THE STANDING RULE' } as never
  const fresh = getCriticalSystemReminderAttachment(ctx, [])
  check('an un-emitted reminder attaches', fresh.length === 1)

  const already = [
    { type: 'user', isMeta: false, message: {} },
    {
      type: 'attachment',
      attachment: { type: 'critical_system_reminder', content: 'THE STANDING RULE' },
    },
    { type: 'assistant' },
  ]
  check(
    'the IDENTICAL reminder is suppressed for the rest of the turn',
    getCriticalSystemReminderAttachment(ctx, already).length === 0,
  )
  const changed = { criticalSystemReminder_EXPERIMENTAL: 'A NEW RULE' } as never
  check(
    'changed content still fires immediately',
    getCriticalSystemReminderAttachment(changed, already).length === 1,
  )
  const nextTurn = [
    ...already,
    { type: 'user', isMeta: false, message: {} }, // a NEW real user frame
  ]
  check(
    'a new user turn re-arms the reminder',
    getCriticalSystemReminderAttachment(ctx, nextTurn).length === 1,
  )
}

section('§C sizes: bytes are bytes, the char budget says chars')
{
  // 3-byte UTF-8 characters: length 12k, bytes 36k — the two claims diverge.
  const multi = '漢'.repeat(12_000)
  const result = await persistToolResult(multi, 'vigil-q13-probe')
  check('the result persisted', !('error' in result), JSON.stringify(result).slice(0, 120))
  if (!('error' in result)) {
    check(
      'originalSize measures BYTES on disk, not UTF-16 units',
      result.originalSize === Buffer.byteLength(multi, 'utf8'),
      `${result.originalSize} vs ${Buffer.byteLength(multi, 'utf8')}`,
    )
    const msg = buildLargeToolResultMessage(result)
    check('the size label reflects the byte measure (35.2KB, not 11.7KB)',
      /35\.\d+KB|36\.?\d*KB|34\.\d+KB/i.test(msg), msg.split('\n')[1])
    check('the preview budget is labelled in CHARS',
      msg.includes(`~${PREVIEW_SIZE_CHARS} chars`), msg.split('\n').find(l => l.startsWith('Preview')))
    check('no byte claim rides the preview budget line',
      !/Preview \(head \+ tail, 2\.0KB/.test(msg))
  }
}

rmSync(HOME, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} ATTACHMENT-RESIDUE PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL ATTACHMENT-RESIDUE PROOFS PASS')
process.exit(0)
