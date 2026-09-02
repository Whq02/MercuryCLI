#!/usr/bin/env bun
// prove-postcompact-memory-exclude.ts — guards the post-compact file-restore
// memory exclusion (compact.ts shouldExcludeFromPostCompactRestore). Re-injecting
// memory files post-compact wastes tokens (the memory system re-surfaces them),
// so the exclusion must cover NOT just the top-level getMemoryPath set but ALSO
// child-directory memory (nested MERCURY.md / .mercury/rules/*.md) — via
// isInstructionFilePath, the engine-owned convention-driven classifier
// (src/services/instructions/). §b asserts the LIVE behavior instead of the
// old source text.
//   Run:  ~/.bun/bin/bun run scripts/memory/prove-postcompact-memory-exclude.ts
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

// (a) compact.ts wires isInstructionFilePath into the restore-exclusion
check('compact.ts imports isInstructionFilePath from the instruction engine', /import \{ isInstructionFilePath \} from '\.\.\/\.\.\/services\/instructions\/engine\.js'/.test(compact))
{
  const fn = compact.match(/function shouldExcludeFromPostCompactRestore[\s\S]*?\n}/)?.[0] ?? ''
  check('shouldExcludeFromPostCompactRestore calls isInstructionFilePath', /isInstructionFilePath\(normalizedFilename\)/.test(fn))
  check('the per-type getMemoryPath set is kept (belt-and-suspenders union)', /MEMORY_TYPE_VALUES\.map/.test(fn))
  check('the stale "Refactor to use isInstructionFilePath" TODO is gone', !/TODO: Refactor to use is(Memory|Instruction)FilePath/.test(fn))
}

// (b) isInstructionFilePath actually closes the child-dir gap — LIVE behavior
{
  const p = (...seg: string[]): string => ['', 'proj', ...seg].join(sep)
  // The native convention is the only instruction-file convention in the
  // tree (src/services/instructions/adapters/mercuryNative.ts): MERCURY.md /
  // MERCURY.local.md at any depth, and rules under every project-config home.
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
