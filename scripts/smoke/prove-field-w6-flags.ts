#!/usr/bin/env bun
// ============================================================================
//  scripts/smoke/prove-field-w6-flags.ts
//  TASK-018 wave 6 (flags-and-argv-surface) — three flag-honesty fixes.
//
//   P2  -V prints the same `Mercury <version>` banner as -v/--version and the
//       zero-import fast path, instead of `<version> (<binary>)` the moment a
//       second token appeared.
//   P3  --effort refuses an unrecognised value honestly (it no longer prints
//       "ignoring it in favour of the default" while hard-exiting 1), and its
//       --help line finally names the five valid values.
//   P7  the eager --settings / --setting-sources argv scan stops at the `--`
//       end-of-options sentinel and takes the LAST occurrence (was: read past
//       `--`, and first-wins via indexOf).
//
//  Source-anchored (the driven end-to-end — a real -V / --effort banana /
//  --settings= run against the built artifact — is the live-box check), plus a
//  behavioural replica of the argv scan and the effort help string.
//  Run: ~/.bun/bin/bun run scripts/smoke/prove-field-w6-flags.ts
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
const cli = readFileSync(join(ROOT, 'src/entrypoints/cli.tsx'), 'utf8')

console.log('§P2 — -V prints the same banner as its siblings')
{
  check('the -V listener writes `Mercury ${MERCURY_VERSION}`', main.includes('writeSync(1, `Mercury ${MERCURY_VERSION}\\n`)'))
  check('POISON: the `<version> (<binary>)` form is gone', !main.includes('writeSync(1, `${MERCURY_VERSION} (${cliName})'))
  check('the fast path prints the same `Mercury <version>`', cli.includes('console.log(`Mercury ${MACRO.VERSION}`)'))
  check('the slow path prints the same `Mercury <version>`', main.includes('console.log(`Mercury ${MACRO.VERSION}`)'))
}

console.log('§P3 — --effort refuses honestly and names its values')
{
  check('the --help description names the five levels', main.includes('Reasoning effort level (${EFFORT_LEVELS.join(\', \')})'))
  check('the refusal names the values without claiming it ignored them', main.includes('`Unrecognised effort level "${value}". Valid values: ${EFFORT_LEVELS.join(\', \')}.`'))
  check('POISON: the flag no longer throws the env door\'s ignore-warning', !main.includes("warning ?? 'Valid effort levels: low, medium, high, max'"))
  const effort = readFileSync(join(ROOT, 'src/utils/effort.ts'), 'utf8')
  check('the ladder EFFORT_LEVELS is the five values the description names', effort.includes("export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']"))
}

console.log('§P7 — the eager settings scan stops at `--` and takes the last occurrence')
{
  check('the scan slices the option region at the `--` sentinel', main.includes("const ddIndex = argv.indexOf('--')") && main.includes('argv.slice(0, ddIndex) : argv'))
  check('the scan iterates optionArgv (last-wins), not indexOf', main.includes('for (let i = 0; i < optionArgv.length; i++)'))
  check('POISON: the first-wins indexOf read is gone', !main.includes('const exact = argv.indexOf(name)'))
  check('the sources presence test also respects `--`', main.includes("optionArgv.includes('--setting-sources')"))

  // Behavioural replica of the fixed eagerFlagValue, exercised over the arms
  // the packet drove.
  const eager = (argv: string[], name: string): string | undefined => {
    const dd = argv.indexOf('--')
    const region = dd >= 0 ? argv.slice(0, dd) : argv
    let value: string | undefined
    for (let i = 0; i < region.length; i++) {
      const t = region[i]
      if (t === name) value = region[i + 1]
      else if (t !== undefined && t.startsWith(`${name}=`)) value = t.slice(name.length + 1)
    }
    return value
  }
  check('the = form is read', eager(['--settings=x'], '--settings') === 'x')
  check('the space form is read', eager(['--settings', 'y'], '--settings') === 'y')
  check('a flag after `--` is NOT read', eager(['-p', 'hi', '--', '--settings', 'bad'], '--settings') === undefined)
  check('a repeated flag is last-wins', eager(['--settings', 'a', '--settings', 'b'], '--settings') === 'b')
  check('last-wins spans the two spellings', eager(['--settings=a', '--settings', 'b'], '--settings') === 'b')
  check('absent flag is undefined', eager(['-p', 'hi'], '--settings') === undefined)
}

process.exit(failures === 0 ? 0 : 1)
