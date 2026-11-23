#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'attachment-residue-home-'))
process.env.MERCURY_CONFIG_DIR = HOME

await import('../../src/engine/tasks/tasks.js')
const { getCriticalSystemReminderAttachment } = await import(
  '../../src/engine/attachments/sessionNotices.js'
)
const { persistToolResult, buildLargeToolResultMessage, PREVIEW_SIZE_CHARS } = await import(
  '../../src/engine/tool-dispatch/toolResultStorage.js'
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
  const ctx = { standingRule: 'THE STANDING RULE' } as never
  const fresh = getCriticalSystemReminderAttachment(ctx, [])
  check('an un-emitted reminder attaches', fresh.length === 1, 'change getCriticalSystemReminderAttachment in src/engine/attachments/sessionNotices.ts so a standingRule not yet emitted this turn returns one critical_system_reminder')

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
    'change awarenessAlreadyEmittedThisTurn in src/engine/attachments/sessionNotices.ts so an identical reminder already in this turn returns no attachment',
  )
  const changed = { standingRule: 'A NEW RULE' } as never
  check(
    'changed content still fires immediately',
    getCriticalSystemReminderAttachment(changed, already).length === 1,
    'change awarenessAlreadyEmittedThisTurn in src/engine/attachments/sessionNotices.ts so it compares the reminder content and lets changed content through',
  )
  const nextTurn = [
    ...already,
    { type: 'user', isMeta: false, message: {} },
  ]
  check(
    'a new user turn re-arms the reminder',
    getCriticalSystemReminderAttachment(ctx, nextTurn).length === 1,
    'change awarenessAlreadyEmittedThisTurn in src/engine/attachments/sessionNotices.ts so it stops scanning at the latest user turn and a new turn re-arms the reminder',
  )
}

section('§C sizes: bytes are bytes, the char budget says chars')
{
  const multi = '漢'.repeat(12_000)
  const result = await persistToolResult(multi, 'vigil-q13-probe')
  check('the result persisted', !('error' in result), JSON.stringify(result).slice(0, 120) + '; persistToolResult in src/engine/tool-dispatch/toolResultStorage.ts returned an error, read it above and fix the write under MERCURY_CONFIG_DIR')
  if (!('error' in result)) {
    check(
      'originalSize measures BYTES on disk, not UTF-16 units',
      result.originalSize === Buffer.byteLength(multi, 'utf8'),
      `${result.originalSize} vs ${Buffer.byteLength(multi, 'utf8')}; change persistToolResult in src/engine/tool-dispatch/toolResultStorage.ts so originalSize is the UTF-8 byte length`,
    )
    const msg = buildLargeToolResultMessage(result)
    check('the size label reflects the byte measure (35.2KB, not 11.7KB)',
      /35\.\d+KB|36\.?\d*KB|34\.\d+KB/i.test(msg), msg.split('\n')[1] + '; change buildLargeToolResultMessage in src/engine/tool-dispatch/toolResultStorage.ts so the size label formats originalSize bytes')
    check('the preview budget is labelled in CHARS',
      msg.includes(`~${PREVIEW_SIZE_CHARS} chars`), msg.split('\n').find(l => l.startsWith('Preview')) + '; change the Preview line of buildLargeToolResultMessage in src/engine/tool-dispatch/toolResultStorage.ts to say PREVIEW_SIZE_CHARS chars')
    check('no byte claim rides the preview budget line',
      !/Preview \(head \+ tail, 2\.0KB/.test(msg), 'change the Preview line of buildLargeToolResultMessage in src/engine/tool-dispatch/toolResultStorage.ts to state the budget in chars, not KB')
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
