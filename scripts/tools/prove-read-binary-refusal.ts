#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const ROOT = join(import.meta.dir, '..', '..')

const { hasBinaryExtension } = await import('../../src/constants/files.ts')

console.log('§1 the predicate speaks paths')
for (const [path, want] of [
  ['/tmp/sample.exe', true],
  ['C:\\bin\\sample.DLL', true],
  ['archive.zip', true],
  ['deck.docx', true],
  ['Main.class', true],
  ['db.sqlite', true],
  ['notes.txt', false],
  ['Makefile', false],
  ['exe', false],
  ['trailing.', false],
] as Array<[string, boolean]>) {
  check(`${JSON.stringify(path)} ⇒ ${want}`, hasBinaryExtension(path) === want, String(hasBinaryExtension(path)))
}

console.log('§2 the guard hands it the path')
{
  const src = readFileSync(join(ROOT, 'src', 'tools', 'FileReadTool', 'FileReadTool.ts'), 'utf8')
  check(
    'the binary-extension arm tests input.file_path (never the dotless ext)',
    src.includes('hasBinaryExtension(input.file_path)') && !src.includes('hasBinaryExtension(ext)'),
  )
}

console.log(failures === 0 ? '\nprove-read-binary-refusal: all green' : `\nprove-read-binary-refusal: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
