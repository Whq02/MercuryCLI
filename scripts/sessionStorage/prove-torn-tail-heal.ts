#!/usr/bin/env bun
// prove-torn-tail-heal — appending onto an unterminated transcript tail
// (field card FC-016). The record terminator is written only as a SUFFIX and
// no appender checks the file it lands on, so resuming a transcript whose
// final byte is not a newline concatenated the next record onto the last
// line — a record that parsed before the resume did not parse after it
// (exit 0, both streams empty). The per-file state resolver (which already
// opens the file to recover the ordinal floor) now records an unterminated
// tail, and the next encoded line heals it with one leading newline.
//
//   §1 the torn-tail append: every line parses after, count = before + 1.
//   §2 control: a clean tail gains no blank line (byte-exact single append).
//   §3 a fresh file still opens with the header.
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'torn-tail-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { appendEntryToFile } = await import('../../src/utils/sessionStorage/writer.ts')
const { resetTranscriptFormatCacheForTesting } = await import('../../src/utils/sessionStorage/vnext.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const parseableLines = (path: string): { parseable: number; total: number } => {
  const lines = readFileSync(path, 'utf8').split('\n').filter(l => l.length > 0)
  let parseable = 0
  for (const line of lines) {
    try {
      JSON.parse(line)
      parseable++
    } catch {
      /* unparseable */
    }
  }
  return { parseable, total: lines.length }
}

section('§1 THE TORN TAIL')
{
  const file = join(HOME, 'torn.jsonl')
  // Two records, then the final newline stripped (the card's repro).
  appendEntryToFile(file, { type: 'user', uuid: 'aaaaaaaa-0000-0000-0000-000000000001', message: 'first' })
  appendEntryToFile(file, { type: 'user', uuid: 'aaaaaaaa-0000-0000-0000-000000000002', message: 'second' })
  const before = parseableLines(file)
  check('fixture: every line parseable before the tear', before.parseable === before.total && before.total >= 2, JSON.stringify(before))
  const content = readFileSync(file, 'utf8')
  writeFileSync(file, content.replace(/\n$/, ''))
  // A resume is a fresh process: the per-file state cache resets.
  resetTranscriptFormatCacheForTesting()
  appendEntryToFile(file, { type: 'user', uuid: 'aaaaaaaa-0000-0000-0000-000000000003', message: 'third' })
  const after = parseableLines(file)
  check(
    'after the resume-append EVERY line still parses (FC-016: no spliced record)',
    after.parseable === after.total,
    JSON.stringify(after),
  )
  check('and the count is before + 1', after.total === before.total + 1, `before=${before.total} after=${after.total}`)
}

section('§2 CLEAN-TAIL CONTROL')
{
  const file = join(HOME, 'clean.jsonl')
  appendEntryToFile(file, { type: 'user', uuid: 'bbbbbbbb-0000-0000-0000-000000000001', message: 'one' })
  resetTranscriptFormatCacheForTesting()
  appendEntryToFile(file, { type: 'user', uuid: 'bbbbbbbb-0000-0000-0000-000000000002', message: 'two' })
  const raw = readFileSync(file, 'utf8')
  check('no blank line invented on a clean tail', !raw.includes('\n\n'), JSON.stringify(raw.slice(0, 80)))
  const { parseable, total } = parseableLines(file)
  check('every line parses', parseable === total)
}

section('§3 FRESH FILE')
{
  const file = join(HOME, 'fresh.jsonl')
  resetTranscriptFormatCacheForTesting()
  appendEntryToFile(file, { type: 'user', uuid: 'cccccccc-0000-0000-0000-000000000001', message: 'hello' })
  const raw = readFileSync(file, 'utf8')
  check('the header still lands first on a fresh file', raw.startsWith('{'), JSON.stringify(raw.slice(0, 40)))
  check('and the file does not open with a stray newline', !raw.startsWith('\n'))
}

rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-torn-tail-heal: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-torn-tail-heal: all green')
