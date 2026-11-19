#!/usr/bin/env bun
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

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


console.log(failures === 0 ? '\nprove-read-encoding-door: all green' : `\nprove-read-encoding-door: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
