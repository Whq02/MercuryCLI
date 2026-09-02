#!/usr/bin/env bun
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
