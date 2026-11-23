#!/usr/bin/env bun
import { join } from 'node:path'
import { MERCURY_VERSION } from '../../src/platform/product/product.ts'
import { EFFORT_LEVELS } from '../../src/models/effort/effortLadder.ts'
import { builtCli, builtHelp } from '../lib/builtProduct.ts'

let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const banner = `Mercury ${MERCURY_VERSION}\n`
const viaListener = builtCli(['--no-commands', '-V'])
const viaAction = builtCli(['--version', '--no-commands'])
const flagDoor = builtCli(['run', '--effort', 'banana', 'hi'])

console.log('§P2 — -V prints the same banner as its siblings')
{
  check('the -V listener writes `Mercury ${MERCURY_VERSION}`', viaListener.status === 0 && viaListener.stdout === banner, `got status ${viaListener.status} stdout ${JSON.stringify(viaListener.stdout)}; make the -V listener in src/boot/main/rootOptions.ts (exitWithVersionLine) print exactly ${JSON.stringify(banner)}`)
  check('the slow path prints the same `Mercury <version>`', viaAction.status === 0 && viaAction.stdout === banner, `got status ${viaAction.status} stdout ${JSON.stringify(viaAction.stdout)}; make the version branch in src/boot/entrypoints/cli.tsx print exactly ${JSON.stringify(banner)}`)
}

console.log('§P3 — --effort refuses honestly and names its values')
{
  check('the --help description names the ladder from its owner', builtHelp().includes(`--effort <level> Reasoning effort level (${EFFORT_LEVELS.join(', ')})`), 'make the --effort option description in src/boot/main/rootOptions.ts list EFFORT_LEVELS from src/models/effort/effortLadder.ts')
  check('the refusal names the values without claiming it ignored them', flagDoor.status !== 0 && flagDoor.stderr.includes(`Unrecognised effort level "banana". Valid values: ${EFFORT_LEVELS.join(', ')}.`), `got status ${flagDoor.status} stderr ${JSON.stringify(flagDoor.stderr)}; make the --effort parser in src/boot/main/rootOptions.ts throw the Unrecognised effort level message`)
}

console.log('§P7 — the eager settings scan stops at `--` and takes the last occurrence')
{

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
