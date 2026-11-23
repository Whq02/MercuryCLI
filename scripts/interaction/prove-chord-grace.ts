#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'chord-grace-home-'))

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { resolveKeyWithChordState } = await import('../../src/screen/keys/resolver.ts')
const { DEFAULT_BINDINGS } = await import('../../src/screen/keys/defaultBindings.ts')
const { parseBindings } = await import('../../src/screen/keys/parser.ts')

const bindings = parseBindings(DEFAULT_BINDINGS)
const CONTEXTS = ['Chat', 'Global'] as never[]

const key = (over: Record<string, unknown> = {}) => ({
  ctrl: false, meta: false, shift: false, escape: false, super: false,
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
  return: false, backspace: false, delete: false, tab: false, pageDown: false, pageUp: false,
  ...over,
})

console.log('── R. resolver truth ──')
const armed = resolveKeyWithChordState('x', key({ ctrl: true }) as never, CONTEXTS, bindings as never, null)
check('ctrl+x arms the chord (chord_started)', armed.type === 'chord_started', `${armed.type}; ctrl+x must start a chord, so check the 'ctrl+x p' row in src/screen/keys/defaultBindings.ts and resolveKeyWithChordState in src/screen/keys/resolver.ts`)
if (armed.type === 'chord_started') {
  const done = resolveKeyWithChordState('p', key() as never, CONTEXTS, bindings as never, armed.pending)
  check('ctrl+x p completes to the command palette', done.type === 'match' && (done as { action: string }).action === 'app:commandPalette', `${JSON.stringify(done)}; 'ctrl+x p' must resolve to app:commandPalette, so check src/screen/keys/defaultBindings.ts and resolveKeyWithChordState in src/screen/keys/resolver.ts`)
  const cancelled = resolveKeyWithChordState('q', key() as never, CONTEXTS, bindings as never, armed.pending)
  check('an unmatched suffix mid-chord cancels (interceptor consumes)', cancelled.type === 'chord_cancelled', `${cancelled.type}; an unmatched second key must return chord_cancelled, so fix the pending-chord branch of resolveKeyWithChordState in src/screen/keys/resolver.ts`)
}
const leakShape = resolveKeyWithChordState('p', key() as never, CONTEXTS, bindings as never, null)
check("a bare 'p' with NO pending state is 'none' — the leak shape the grace stash closes", leakShape.type === 'none', `${leakShape.type}; a lone p with no pending chord must resolve to none, so check the 'p' bindings in src/screen/keys/defaultBindings.ts and resolveKeyWithChordState in src/screen/keys/resolver.ts`)


console.log(failures === 0 ? '\nprove-chord-grace: GREEN' : `\nprove-chord-grace: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
