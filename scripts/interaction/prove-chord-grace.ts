#!/usr/bin/env bun
// ============================================================================
//  prove-chord-grace — the stray-`p` class: a chord prefix that
//  silently timed out let the suffix key TYPE into the composer ("^x …pause…
//  p" ⇒ a literal `p` in a fresh session's prompt).
//
//  Laws:
//    R. resolver truth (pure): ctrl+x arms a chord; +p completes to
//       app:commandPalette; a bare p with NO pending state is 'none' (the
//       leak shape — exactly why the grace stash must exist); an unmatched
//       suffix mid-chord cancels (and the interceptor consumes it).
//    G. the grace fix (structural pins on the ONE owner): a timed-out prefix
//       is STASHED one-shot; a late key inside CHORD_TIMEOUT_GRACE_MS
//       resolves THROUGH the stash (late completion fires; non-completing
//       keys pass through untouched); the timeout is 2s, not the old 1s.
// ============================================================================
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'chord-grace-home-'))

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { resolveKeyWithChordState } = await import('../../src/keybindings/resolver.ts')
const { DEFAULT_BINDINGS } = await import('../../src/keybindings/defaultBindings.ts')
const { parseBindings } = await import('../../src/keybindings/parser.ts')

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
check('ctrl+x arms the chord (chord_started)', armed.type === 'chord_started', armed.type)
if (armed.type === 'chord_started') {
  const done = resolveKeyWithChordState('p', key() as never, CONTEXTS, bindings as never, armed.pending)
  check('ctrl+x p completes to the command palette', done.type === 'match' && (done as { action: string }).action === 'app:commandPalette', JSON.stringify(done))
  const cancelled = resolveKeyWithChordState('q', key() as never, CONTEXTS, bindings as never, armed.pending)
  check('an unmatched suffix mid-chord cancels (interceptor consumes)', cancelled.type === 'chord_cancelled')
}
const leakShape = resolveKeyWithChordState('p', key() as never, CONTEXTS, bindings as never, null)
check("a bare 'p' with NO pending state is 'none' — the leak shape the grace stash closes", leakShape.type === 'none')

console.log('── G. the grace fix (pins on the ONE owner) ──')
const src = readFileSync(join(import.meta.dir, '../../src/keybindings/KeybindingProviderSetup.tsx'), 'utf8')
check('the timeout stashes the expired prefix (one-shot grace)', src.includes('expiredChordRef.current = { pending:'))
check('the grace window constant exists', src.includes('CHORD_TIMEOUT_GRACE_MS'))
check('grace resolution rides the SAME resolver with the stashed prefix', src.includes('effectivePending = expired.pending'))
check('a NON-completing late key passes through untouched (never eaten)', src.includes("viaGrace && result.type === 'chord_cancelled'"))
check('the stash clears one-shot on the next key', src.includes('expiredChordRef.current = null'))
check('the base timeout is 2s (was the 1s that bit)', src.includes('CHORD_TIMEOUT_MS = 2000'))
check('an explicit resolve/cancel supersedes an armed grace', /else \{\s*\n\s*\/\/ An explicit resolve\/cancel supersedes any armed grace\./.test(src))

console.log(failures === 0 ? '\nprove-chord-grace: GREEN' : `\nprove-chord-grace: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
