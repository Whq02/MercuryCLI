#!/usr/bin/env bun
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSyncWithMetadata } from '../../src/platform/files/syncFileRead.ts'

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
  const cp1252 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x97, 0x20, 0x6e, 0x61, 0xef, 0x76, 0x65, 0x0d, 0x0a])
  const p1 = join(dir, 'ansi.txt')
  writeFileSync(p1, cp1252)
  const m1 = readFileSyncWithMetadata(p1)
  check('a cp1252 file reads losslessDecode:false', m1.losslessDecode === false, 'readFileSyncWithMetadata in src/platform/files/syncFileRead.ts must set losslessDecode false when re-encoding the decoded text differs from the file bytes')
  check('…and the decode really holds U+FFFD (the destruction the write-back would commit)', m1.content.includes('�'), 'the cp1252 fixture should decode with U+FFFD; check the encoding picked by detectEncodingForResolvedPath in src/platform/files/syncFileRead.ts')

  const p2 = join(dir, 'be.txt')
  writeFileSync(p2, Buffer.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]))
  const m2 = readFileSyncWithMetadata(p2)
  check('a UTF-16BE file reads losslessDecode:false', m2.losslessDecode === false, 'a UTF-16BE file must not pass as lossless; see the losslessDecode round-trip in readFileSyncWithMetadata (src/platform/files/syncFileRead.ts)')

  const p3 = join(dir, 'clean.txt')
  writeFileSync(p3, 'café — naïve ✓ 🚀\n', 'utf8')
  check('clean multi-byte UTF-8 reads losslessDecode:true', readFileSyncWithMetadata(p3).losslessDecode === true, 'valid UTF-8 must round-trip to its bytes; see the losslessDecode comparison in readFileSyncWithMetadata (src/platform/files/syncFileRead.ts)')

  const p4 = join(dir, 'bom.txt')
  writeFileSync(p4, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello\n', 'utf8')]))
  check('a UTF-8 BOM file reads losslessDecode:true', readFileSyncWithMetadata(p4).losslessDecode === true, 'a UTF-8 BOM file must read as lossless; see the losslessDecode comparison in readFileSyncWithMetadata (src/platform/files/syncFileRead.ts)')

  const p5 = join(dir, 'le.txt')
  writeFileSync(p5, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi\n', 'utf16le')]))
  check('a UTF-16LE BOM file reads losslessDecode:true', readFileSyncWithMetadata(p5).losslessDecode === true, 'a UTF-16LE BOM file must read as lossless; see the losslessDecode comparison in readFileSyncWithMetadata (src/platform/files/syncFileRead.ts)')

  const p6 = join(dir, 'fffd.txt')
  writeFileSync(p6, 'real � char\n', 'utf8')
  check('a genuine U+FFFD character is NOT lossy', readFileSyncWithMetadata(p6).losslessDecode === true, 'a real U+FFFD in valid UTF-8 must stay lossless; losslessDecode must compare bytes, not scan for U+FFFD (readFileSyncWithMetadata in src/platform/files/syncFileRead.ts)')
}


process.exit(failures === 0 ? 0 : 1)
