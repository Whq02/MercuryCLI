#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join, sep } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let fail = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) fail++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
const root = join(import.meta.dir, '..', '..')
const compact = readFileSync(join(root, 'src/services/compact/compact.ts'), 'utf-8')
const { isInstructionFilePath } = await import(
  join(root, 'src/services/instructions/engine.ts')
)

console.log('── post-compact memory-file exclusion (child-dir memory) ──')

check('compact.ts imports isInstructionFilePath from the instruction engine', /import \{ isInstructionFilePath \} from '\.\.\/\.\.\/services\/instructions\/engine\.js'/.test(compact))
{
  const fn = compact.match(/function shouldExcludeFromPostCompactRestore[\s\S]*?\n}/)?.[0] ?? ''
  check('shouldExcludeFromPostCompactRestore calls isInstructionFilePath', /isInstructionFilePath\(normalizedFilename\)/.test(fn))
  check('the per-type getMemoryPath set is kept (belt-and-suspenders union)', /MEMORY_TYPE_VALUES\.map/.test(fn))
  check('the stale "Refactor to use isInstructionFilePath" TODO is gone', !/TODO: Refactor to use is(Memory|Instruction)FilePath/.test(fn))
}

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
