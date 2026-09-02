#!/usr/bin/env bun
// ============================================================================
//  scripts/smoke/prove-field-w6-concourse-persist.ts
//  TASK-018 wave 6 (flags-and-argv-surface) — `--concourse-off` /
//  `--concourse-on` persist on the non-interactive road too.
//
//  --help promises the switch is "persisted … for this and every future boot",
//  unconditionally, but its sole CLI writer sat inside interactiveLaunch, so a
//  headless `-p … --concourse-off` was accepted at exit 0 and wrote nothing.
//  The persist is hoisted to the shared point before the interactive/print
//  fork, so both roads honour it — while staying exactly one CLI writer (the
//  other is /config), the invariant concourseEnabled.ts documents.
//
//  Source-anchored (the driven check — a real `-p … --concourse-off` writing
//  concourseEnabled into a scratch config home — is the live-box verification).
//  Run: ~/.bun/bin/bun run scripts/smoke/prove-field-w6-concourse-persist.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const main = readFileSync(join(ROOT, 'src/main.tsx'), 'utf8')

console.log('§1 — the persist sits before the interactive/print fork')
{
  const persist = main.indexOf('if (opts.concourseOff === true || opts.concourseOn === true) {')
  const fork = main.indexOf('// ── the interactive/print fork')
  check('the persist block is present', persist >= 0)
  check('the fork marker is present', fork >= 0)
  check('the persist runs BEFORE the fork (both roads reach it)', persist >= 0 && fork >= 0 && persist < fork)
  check('the switch is read last-wins from argv', main.includes("[...process.argv].reverse().find(a => a === '--concourse-off' || a === '--concourse-on')"))
}

console.log('§2 — still exactly one CLI writer (the boot switch); no interactiveLaunch copy')
{
  const setCalls = (main.match(/setConcourseEnabled\(/g) ?? []).length
  check('setConcourseEnabled is called exactly once in main.tsx', setCalls === 1, `found ${setCalls}`)
  const interactive = main.indexOf('async function interactiveLaunch(')
  const persist = main.indexOf('if (opts.concourseOff === true || opts.concourseOn === true) {')
  check('the persist is NOT inside interactiveLaunch (it is above it)', persist >= 0 && interactive >= 0 && persist < interactive)
}

process.exit(failures === 0 ? 0 : 1)
