#!/usr/bin/env bun
// prove-mixed-endings-preserved — a one-word Edit must not rewrite every
// line ending in a mixed-endings file (field card FC-017). The write door
// carried ONE LineEndingType for the whole file (the majority vote), so a
// six-character edit deleted three carriage returns — or injected two — on
// lines the edit never touched, while the returned patch showed those lines
// as unchanged context. The write now reconciles against the ORIGINAL raw
// spelling: untouched lines keep their exact terminator; only lines inside
// the changed region take the majority style.
//
//   §1 the write flow end-to-end: read mixed → edit one LF line → write —
//      the CRLF lines keep their bytes (the card's own repro shape).
//   §2 the reconciliation unit: top/bottom alignment, majority in the middle.
//   §3 controls: uniform LF and uniform CRLF files write exactly as before.
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'mixed-endings-')))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { readFileSyncWithMetadata } = await import('../../src/utils/fileRead.ts')
const fileMod = await import('../../src/utils/file.ts')
const { writeTextContent } = fileMod

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

type Preserve = (raw: string, updated: string, majority: 'LF' | 'CRLF') => string
const preserve: Preserve | undefined = (fileMod as { preserveUntouchedLineEndings?: Preserve })
  .preserveUntouchedLineEndings

// The card's shape: five LF lines and three CRLF lines (LF majority).
const MIXED = 'a1\na2\na3\na4\na5\nb1\r\nb2\r\nb3\r\n'

section('§1 THE WRITE FLOW (the card repro)')
{
  const path = join(SCRATCH, 'mixed.txt')
  writeFileSync(path, MIXED)
  const meta = readFileSyncWithMetadata(path)
  // A one-word edit on an LF line, exactly as the tool applies it: the
  // replacement runs on the NORMALIZED content...
  const updated = meta.content.replace('a2', 'a2-edited')
  // ...and the write door reconciles + writes (the fixed door's shape:
  // reconcile against raw, then hand writeTextContent pass-through endings).
  if (preserve) {
    writeTextContent(path, preserve(meta.rawContent, updated, meta.lineEndings), meta.encoding, 'LF')
  } else {
    // The pre-fix door: one majority ending for the whole file.
    writeTextContent(path, updated, meta.encoding, meta.lineEndings)
  }
  const after = readFileSync(path, 'utf8')
  check('the edited line carries the edit', after.includes('a2-edited'))
  check(
    'the CRLF lines the edit never touched KEEP their carriage returns (FC-017)',
    after.includes('b1\r\n') && after.includes('b2\r\n') && after.includes('b3\r\n'),
    JSON.stringify(after.slice(-14)),
  )
  check(
    'the LF lines stay LF (no endings invented)',
    after.includes('a1\na2-edited\na3\n'),
    JSON.stringify(after.slice(0, 20)),
  )
}

section('§2 THE RECONCILIATION UNIT')
{
  check('preserveUntouchedLineEndings exists on the write module', typeof preserve === 'function')
  if (preserve) {
    // CRLF-majority file, edit inside the middle: untouched top/bottom keep
    // their exact endings; the changed middle takes the majority (CRLF).
    const raw = 'top\r\nkeep-lf\nmid\r\nbottom\r\n'
    const updated = 'top\nkeep-lf\nmid-CHANGED\nbottom\n'
    const out = preserve(raw, updated, 'CRLF')
    check('untouched top keeps CRLF', out.startsWith('top\r\n'), JSON.stringify(out))
    check('untouched LF line keeps LF', out.includes('keep-lf\n') && !out.includes('keep-lf\r\n'))
    check('the changed middle takes the majority style', out.includes('mid-CHANGED\r\n'))
    check('untouched bottom keeps CRLF', out.endsWith('bottom\r\n'))

    // A pure no-op returns the raw bytes.
    check('a no-op reconciliation returns the raw spelling byte-exact', preserve(raw, raw.replaceAll('\r\n', '\n'), 'CRLF') === raw)
  }
}

section('§3 UNIFORM CONTROLS')
{
  const lfPath = join(SCRATCH, 'uniform-lf.txt')
  writeFileSync(lfPath, 'x1\nx2\nx3\n')
  const lfMeta = readFileSyncWithMetadata(lfPath)
  const lfUpdated = lfMeta.content.replace('x2', 'x2-e')
  if (preserve) writeTextContent(lfPath, preserve(lfMeta.rawContent, lfUpdated, lfMeta.lineEndings), lfMeta.encoding, 'LF')
  else writeTextContent(lfPath, lfUpdated, lfMeta.encoding, lfMeta.lineEndings)
  check('a uniform-LF file stays uniform LF', readFileSync(lfPath, 'utf8') === 'x1\nx2-e\nx3\n')

  const crlfPath = join(SCRATCH, 'uniform-crlf.txt')
  writeFileSync(crlfPath, 'y1\r\ny2\r\ny3\r\n')
  const crlfMeta = readFileSyncWithMetadata(crlfPath)
  const crlfUpdated = crlfMeta.content.replace('y2', 'y2-e')
  if (preserve) writeTextContent(crlfPath, preserve(crlfMeta.rawContent, crlfUpdated, crlfMeta.lineEndings), crlfMeta.encoding, 'LF')
  else writeTextContent(crlfPath, crlfUpdated, crlfMeta.encoding, crlfMeta.lineEndings)
  check('a uniform-CRLF file stays uniform CRLF', readFileSync(crlfPath, 'utf8') === 'y1\r\ny2-e\r\ny3\r\n')
}

rmSync(SCRATCH, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-mixed-endings-preserved: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-mixed-endings-preserved: all green')
