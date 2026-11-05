#!/usr/bin/env bun
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

console.log('§1 the note line keeps its fix through the middle cut (no key: ⌃s and the coordinator chip left the screen with the two-pane concourse)')
{
  check('the line names no key', !MANAGER_NEEDS_MODEL_LINE.includes('⌃'), MANAGER_NEEDS_MODEL_LINE)
  check('the fix rides the TAIL (what middle-truncation preserves)', MANAGER_NEEDS_MODEL_LINE.endsWith('serve a local model'))
  for (const w of [38, 30, 24]) {
    const cut = wrapText(MANAGER_NEEDS_MODEL_LINE, w, 'truncate-middle')
    check(`at ${w} columns the cut still carries the fix`, cut.endsWith('local model'), cut)
  }
}

console.log('\n§2 the unknown-model construction names the choice and the registry, no key')
{
  const mm = readFileSync(join(ROOT, 'src', 'services', 'concourse', 'managerMode.ts'), 'utf-8')
  check('its template ends with the registry, not a key', /is not in the composed registry`/.test(mm))
  check('managerMode.ts paints no key glyph', !mm.includes('⌃'))
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
