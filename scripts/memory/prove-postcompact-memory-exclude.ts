#!/usr/bin/env bun
import { join, sep } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let fail = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) fail++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
const root = join(import.meta.dir, '..', '..')
const { isInstructionFilePath } = await import(
  join(root, 'src/sessions/instructions/instructionFiles.ts')
)

console.log('── post-compact memory-file exclusion (child-dir memory) ──')


{
  const p = (...seg: string[]): string => ['', 'proj', ...seg].join(sep)
  check(
    'isInstructionFilePath matches MERCURY.md / MERCURY.local.md anywhere',
    isInstructionFilePath(p('deep', 'child', 'MERCURY.md')) &&
      isInstructionFilePath(p('MERCURY.local.md')),
  )
  check(
    'isInstructionFilePath matches .mercury/rules/*.md (child-dir memory)',
    isInstructionFilePath(p('sub', '.mercury', 'rules', 'style.md')) &&
      !isInstructionFilePath(p('sub', 'rules', 'style.md')),
  )
  check(
    'isInstructionFilePath rejects ordinary files',
    !isInstructionFilePath(p('src', 'index.ts')) && !isInstructionFilePath(p('README.md')),
  )
  check(
    'isInstructionFilePath covers the Mercury-native family: MERCURY.md excluded from restore too',
    isInstructionFilePath(p('deep', 'MERCURY.md')) &&
      isInstructionFilePath(p('MERCURY.local.md')),
  )
}

console.log(fail === 0 ? '✅ post-compact memory-exclusion guard holds' : `❌ ${fail} check(s) FAILED`)
process.exit(fail === 0 ? 0 : 1)
