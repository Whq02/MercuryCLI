#!/usr/bin/env bun
import { join } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const REPO = join(import.meta.dir, '../..')
const SRC = join(REPO, 'src')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const { HELD_PLATE, QUEUED_PLATE, HELD_FOR_COMPACTION_LINE } = await import(join(SRC, 'components/messages/TranscriptNameplate.tsx'))

section('H1 a send during the compaction is held, and says so')
check('the plate word is held, in the queued column (same width)', HELD_PLATE === 'held'.padEnd(8) && HELD_PLATE.length === QUEUED_PLATE.length)
check('the composer line says until when and how to take it back', HELD_FOR_COMPACTION_LINE.includes('held until the compaction lands') && HELD_FOR_COMPACTION_LINE.includes('delivers once') && HELD_FOR_COMPACTION_LINE.includes('↑'))


console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
