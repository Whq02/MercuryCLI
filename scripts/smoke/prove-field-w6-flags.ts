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
  check('the --help description names the ladder from its owner', main.includes('Reasoning effort level (${EFFORT_LEVELS.join(\', \')})'))
  check('the refusal names the values without claiming it ignored them', main.includes('`Unrecognised effort level "${value}". Valid values: ${EFFORT_LEVELS.join(\', \')}.`'))
  check('POISON: the flag no longer throws the env door\'s ignore-warning', !main.includes("warning ?? 'Valid effort levels: low, medium, high, max'"))
  const effort = readFileSync(join(ROOT, 'src/utils/effort.ts'), 'utf8')
  const ladder = readFileSync(join(ROOT, 'src/utils/effortLadder.ts'), 'utf8')
  check('the ladder is ONE tuple beside its type (five words, low to max) and the effort owner re-exports it', ladder.includes("const EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const") && ladder.includes('export type EffortLevel = (typeof EFFORT_LADDER)[number]') && effort.includes('export { EFFORT_LEVELS }'))
}

console.log('§P7 — the eager settings scan stops at `--` and takes the last occurrence')
{
  check('the scan slices the option region at the `--` sentinel', main.includes("const ddIndex = argv.indexOf('--')") && main.includes('argv.slice(0, ddIndex) : argv'))
  const sessionArgs = readFileSync(join(ROOT, 'src/cli/sessionArgs.ts'), 'utf8')
  check('the scan reads optionArgv through the session option reader (last-wins), not indexOf', main.includes('readSessionOption(optionArgv.slice(2), name).value') && sessionArgs.includes('for (const i of optionIndexes(args))') && sessionArgs.includes('if (flag === name) result = { present: true,'))
  check('POISON: the first-wins indexOf read is gone', !main.includes('const exact = argv.indexOf(name)'))
  check('the sources presence test also respects `--`', main.includes("readSessionOption(optionArgv.slice(2), '--config-layers').present"))

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
  check('the = form is read', eager(['--config=x'], '--config') === 'x')
  check('the space form is read', eager(['--config', 'y'], '--config') === 'y')
  check('a flag after `--` is NOT read', eager(['run', 'hi', '--', '--config', 'bad'], '--config') === undefined)
  check('a repeated flag is last-wins', eager(['--config', 'a', '--config', 'b'], '--config') === 'b')
  check('last-wins spans the two spellings', eager(['--config=a', '--config', 'b'], '--config') === 'b')
  check('absent flag is undefined', eager(['run', 'hi'], '--config') === undefined)
}

process.exit(failures === 0 ? 0 : 1)
