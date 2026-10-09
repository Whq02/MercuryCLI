#!/usr/bin/env bun
import { join } from 'node:path'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const { interpretKey } = await import(join(SRC, 'ink/input/interpreter.ts'))

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const nameOf = (code: number): string | undefined => interpretKey(`\x1b[${code}u`).name
const table: Array<[number, string]> = [
  [9, 'tab'], [13, 'return'], [27, 'escape'], [32, 'space'], [127, 'backspace'],
  [57399, '0'], [57400, '1'], [57401, '2'], [57402, '3'], [57403, '4'], [57404, '5'], [57405, '6'], [57406, '7'], [57407, '8'], [57408, '9'],
  [57409, '.'], [57410, '/'], [57411, '*'], [57412, '-'], [57413, '+'], [57414, 'return'], [57415, '='],
]
for (const [code, name] of table) check(`CSI ${code} u names ${JSON.stringify(name)}`, nameOf(code) === name, JSON.stringify(nameOf(code)))
check('a printable code names its lower-cased character', nameOf(65) === 'a' && nameOf(97) === 'a' && nameOf(126) === '~' && nameOf(33) === '!')
check('a code outside the printable range and the table has no name', nameOf(31) === undefined && nameOf(1092) === undefined && nameOf(57398) === undefined && nameOf(57416) === undefined)

console.log(failures ? `FAIL keycode names: ${failures} failures` : 'PASS keycode names')
process.exit(failures ? 1 : 0)
