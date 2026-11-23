#!/usr/bin/env bun

process.env.NODE_ENV = 'test'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const { hasBinaryExtension } = await import('../../src/tools/read/binaryExtensions.ts')

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
  check(`${JSON.stringify(path)} ⇒ ${want}`, hasBinaryExtension(path) === want, String(hasBinaryExtension(path)) + (hasBinaryExtension(path) === want ? '' : ' (fix hasBinaryExtension or its BINARY_EXTENSIONS set in src/tools/read/binaryExtensions.ts)'))
}


console.log(failures === 0 ? '\nprove-read-binary-refusal: all green' : `\nprove-read-binary-refusal: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
