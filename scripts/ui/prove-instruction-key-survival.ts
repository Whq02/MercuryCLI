#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-instruction-key-survival.ts — manager mode's
//  instruction lines keep their KEY inside the region their slot's
//  truncation preserves (FC-132). Every line was authored longer than its
//  only slot and each ellipsis landed on the key the line exists to teach:
//  the composer note rendered manager mode needs…tor chip) picks one —
//  eliding ⌃s, the one key that makes the mode runnable.
//
//  §1 the note line (truncate-middle slot): the key rides the TAIL and
//     survives the cut at the narrow widths the card names.
//  §2 the unknown-model construction is tail-keyed too.
//  §3 the truncate-end card rows lead with their keys (source pins — the
//     concourse PTY family stays in the announced-window queue).
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-instruction-key-survival.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const ROOT = join(import.meta.dir, '..', '..')

const { MANAGER_NEEDS_MODEL_LINE } = await import('../../src/services/concourse/managerMode.ts')
const wrapText = (await import('../../src/ink/wrap-text.ts')).default

console.log('§1 the note line keeps ⌃s through the middle cut')
{
  check('the key rides the TAIL (what middle-truncation preserves)', MANAGER_NEEDS_MODEL_LINE.endsWith('⌃s picks one'))
  for (const w of [38, 30, 24]) {
    const cut = wrapText(MANAGER_NEEDS_MODEL_LINE, w, 'truncate-middle')
    check(`at ${w} columns the cut still teaches the key`, cut.includes('⌃s picks one'), cut)
  }
}

console.log('\n§2 the unknown-model construction is tail-keyed')
{
  const mm = readFileSync(join(ROOT, 'src', 'services', 'concourse', 'managerMode.ts'), 'utf-8')
  check(
    "its template ends with keyHintLabel('⌃s') picks one",
    /keyHintLabel\('⌃s'\)\} picks one`/.test(mm),
  )
}

console.log('\n§3 the truncate-end card rows lead with their keys')
{
  const cards = readFileSync(join(ROOT, 'src', 'components', 'concourse', 'ManagerCards.tsx'), 'utf-8')
  check(
    'the ask legend orders select and commit before the expendable tail',
    /select · ↵ commit · \$\{customOrdinal\} custom answer · esc close/.test(cards),
  )
  check(
    'the supervision row leads with its key (after dispatch — s switches:)',
    cards.includes('after dispatch — s switches:'),
  )
  check('no trailing — s switches survives to be eaten first', !cards.includes('> — s switches</Text>'))
}

console.log(failures === 0 ? '\nprove-instruction-key-survival: all green' : `\nprove-instruction-key-survival: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
