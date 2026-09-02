#!/usr/bin/env bun
// ============================================================================
//  scripts/tools/prove-read-binary-refusal.ts — Read's binary-extension
//  refusal can fire (FC-091). The guard handed hasBinaryExtension a DOTLESS
//  extension while the membership set spells its members with dots — and
//  the predicate's own dotless arm sliced the LAST CHARACTER (not the whole
//  name its docs claimed) — so .exe, .dll, .zip, .docx, .class and .sqlite
//  were all read as text: a 6 KB executable came back as 3.4 KB of content
//  carrying 524 replacement characters, is_error false.
//
//  §1 the predicate speaks PATHS (the membership matrix).
//  §2 the guard hands it the path (call-shaped).
//
//  Run: ~/.bun/bin/bun run scripts/tools/prove-read-binary-refusal.ts
// ============================================================================
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
