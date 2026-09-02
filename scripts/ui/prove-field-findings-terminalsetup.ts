#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-field-findings-terminalsetup.ts
//  The /terminal-setup refusal's newline
// instruction (CI-03's second half; the first half — the
//  win32 "Supported terminals" row — is closed).
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-field-findings-terminalsetup.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ── §1 · CI-03 (half 2): the fallback instruction teaches ONE backslash ─────
// Finding CI-03 (moderate, this half): the refusal's fallback line rendered
// TWO backslashes ("Backslash-then-return (\\ then Enter)") — and a draft
// ending in two backslashes reads as a UNC prefix to the continuation test,
// so typing exactly what the line taught SUBMITS the draft instead of
// inserting the newline it promises. One rendered backslash now.
console.log('§1 CI-03 — the instruction teaches the gesture that works')
{
  const { isBackslashContinuation } = await import('../../src/input-core/backslashContinuation.ts')
  const one = 'hello \\'
  const two = 'hello \\\\'
  check('the mechanism: one trailing backslash continues, two read as a UNC prefix and submit', isBackslashContinuation(one, one.length) === true && isBackslashContinuation(two, two.length) === false)
  const setup = read('src/commands/terminalSetup/terminalSetup.tsx')
  check('the line renders ONE backslash', setup.includes("chalk.dim('Backslash-then-return (\\\\ then Enter) already inserts a newline today.')"))
  check('POISON: the doubled artefact (and its keep-it comment) is gone', !setup.includes('(\\\\\\\\ then Enter)') && !setup.includes('artefact is reproduced'))
  check('the win32 supported-terminals row stays closed (the first half)', setup.includes("process.platform === 'darwin' ? ' - Apple Terminal\\n' : ''"))
}
// NEEDS-REAL-BOX: /terminal-setup in Windows Terminal — the dim line shows
// one backslash; typing `hello \` + Enter inserts a newline.

process.exit(failures === 0 ? 0 : 1)
