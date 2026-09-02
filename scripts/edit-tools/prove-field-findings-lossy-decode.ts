#!/usr/bin/env bun
// ============================================================================
//  scripts/edit-tools/prove-field-findings-lossy-decode.ts — a lossy decode
// never writes back (TASK-017 supplement S1,
//  `legacy-ansi-file-decoded-and-rewritten-as-utf8`).
//
//  The disease: the encoding detector knows exactly two BOMs and calls
//  everything else UTF-8, so a legacy ANSI/cp1252 file (PowerShell 5.1
//  Set-Content, pre-1903 Notepad, cmd `>` redirection at the OEM page) or a
//  UTF-16BE file decoded with U+FFFD where its bytes were — and the edit
//  tool REWROTE the file with those replacement characters, destroying
//  every such byte the edit never touched. The fix: the read owner
//  (readFileSyncWithMetadata) re-encodes its decode and compares bytes —
//  `losslessDecode` — and both edit doors refuse on false with the move
//  spelled out.
//
//  Run: ~/.bun/bin/bun run scripts/edit-tools/prove-field-findings-lossy-decode.ts
// ============================================================================
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSyncWithMetadata } from '../../src/utils/fileRead.ts'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const dir = mkdtempSync(join(tmpdir(), 'ff-lossy-'))

console.log('§1 the read owner tells a lossy decode from a clean one')
{
  // The finder's file: cp1252 "café — naïve" (é=0xE9, —=0x97, ï=0xEF).
  const cp1252 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x97, 0x20, 0x6e, 0x61, 0xef, 0x76, 0x65, 0x0d, 0x0a])
  const p1 = join(dir, 'ansi.txt')
  writeFileSync(p1, cp1252)
  const m1 = readFileSyncWithMetadata(p1)
  check('a cp1252 file reads losslessDecode:false', m1.losslessDecode === false)
  check('…and the decode really holds U+FFFD (the destruction the write-back would commit)', m1.content.includes('�'))

  // UTF-16BE (FE FF "hi") — the detector has no BE arm; the decode is
  // mojibake and a write-back would destroy it.
  const p2 = join(dir, 'be.txt')
  writeFileSync(p2, Buffer.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]))
  const m2 = readFileSyncWithMetadata(p2)
  check('a UTF-16BE file reads losslessDecode:false', m2.losslessDecode === false)

  // Clean UTF-8 (multi-byte incl. an emoji) round-trips true.
  const p3 = join(dir, 'clean.txt')
  writeFileSync(p3, 'café — naïve ✓ 🚀\n', 'utf8')
  check('clean multi-byte UTF-8 reads losslessDecode:true', readFileSyncWithMetadata(p3).losslessDecode === true)

  // A UTF-8 BOM survives the round-trip (BOM ≠ lossy).
  const p4 = join(dir, 'bom.txt')
  writeFileSync(p4, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello\n', 'utf8')]))
  check('a UTF-8 BOM file reads losslessDecode:true', readFileSyncWithMetadata(p4).losslessDecode === true)

  // UTF-16LE with its BOM (FF FE) round-trips true (the detector's own arm).
  const p5 = join(dir, 'le.txt')
  writeFileSync(p5, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi\n', 'utf16le')]))
  check('a UTF-16LE BOM file reads losslessDecode:true', readFileSyncWithMetadata(p5).losslessDecode === true)

  // A file that legitimately CONTAINS U+FFFD is not lossy (the compare is
  // byte-level, never a character scan).
  const p6 = join(dir, 'fffd.txt')
  writeFileSync(p6, 'real � char\n', 'utf8')
  check('a genuine U+FFFD character is NOT lossy', readFileSyncWithMetadata(p6).losslessDecode === true)
}

console.log('§2 both edit doors refuse a lossy decode (the write never runs)')
{
  const tool = readFileSync(join(import.meta.dir, '../../src/tools/FileEditTool/FileEditTool.ts'), 'utf8')
  check('validation refuses (7b, its own errorCode)', tool.includes('if (fileExists && !decodeLossless) {') && tool.includes('errorCode: 14'))
  check(
    "the atomic write door has its own belt (throw before any write)",
    tool.includes('if (!metadata.losslessDecode) {') && tool.includes('Nothing was written.'),
  )
  check('the refusal names the destruction and the move', tool.includes('destroying content the edit never touches') && tool.includes('iconv -f cp1252 -t utf-8'))
}
// NEEDS-REAL-BOX (the finder's drill): `Set-Content -Encoding Default
// .\notes.txt "café — naïve"` under Windows PowerShell 5.1, ask Mercury for
// a one-line edit elsewhere in the file: the edit is REFUSED with the
// sentence above; a hex view shows the on-disk bytes untouched.

process.exit(failures === 0 ? 0 : 1)
