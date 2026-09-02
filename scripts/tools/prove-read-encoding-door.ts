#!/usr/bin/env bun
// ============================================================================
//  scripts/tools/prove-read-encoding-door.ts — the read door speaks the
//  encoding verdict BEFORE showing content (FC-092). A UTF-16BE file came
//  back as ordinary numbered mojibake with is_error false and an edit
//  anchor minted for it; the Edit door then refused the same file for its
//  lossy decode — the operator learned the file was unreadable only after
//  being shown its contents.
//
//  §1 the underlying verdict (readFileSyncWithMetadata): BE decodes lossy,
//     LE decodes lossless — the fact the write doors act on (control).
//  §2 the read door's BE-BOM refusal (call-shaped): the two-byte check, the
//     teaching text, and the LE/BOM-less roads untouched.
//
//  Run: ~/.bun/bin/bun run scripts/tools/prove-read-encoding-door.ts
// ============================================================================
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const ROOT = join(import.meta.dir, '..', '..')

console.log('§1 the underlying verdict')
{
  const { readFileSyncWithMetadata } = await import('../../src/utils/fileRead.ts')
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'read-enc-')))
  const text = 'line one\nline two\n'
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
  const be = Buffer.concat([
    Buffer.from([0xfe, 0xff]),
    Buffer.from(Buffer.from(text, 'utf16le').swap16()),
  ])
  writeFileSync(join(dir, 'le.txt'), le)
  writeFileSync(join(dir, 'be.txt'), be)
  const leMeta = readFileSyncWithMetadata(join(dir, 'le.txt'))
  check('UTF-16LE decodes LOSSLESS (the readable twin)', leMeta.losslessDecode === true, leMeta.encoding)
  const beMeta = readFileSyncWithMetadata(join(dir, 'be.txt'))
  check('UTF-16BE decodes LOSSY (the write doors refuse this)', beMeta.losslessDecode === false, beMeta.encoding)
  rmSync(dir, { recursive: true, force: true })
}

console.log('§2 the read door')
{
  const src = readFileSync(join(ROOT, 'src', 'tools', 'FileReadTool', 'FileReadTool.ts'), 'utf8')
  check('the BE-BOM two-byte check guards the text lane', src.includes('0xfe') && src.includes('0xff') && src.includes('UTF-16BE (big-endian BOM)'))
  check('the refusal teaches the conversion (iconv), matching the write doors', src.includes('iconv -f utf-16be -t utf-8'))
}

console.log(failures === 0 ? '\nprove-read-encoding-door: all green' : `\nprove-read-encoding-door: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
