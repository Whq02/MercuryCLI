#!/usr/bin/env bun
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyProjectRoot } from '../../src/boot/entrypoints/projectRoot.ts'

const original = process.cwd()
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'project-root-')))
const target = join(scratch, 'project with spaces')
mkdirSync(target)
const link = join(scratch, 'linked-project')
symlinkSync(target, link)
let checks = 0
const check = (label: string, ok: unknown): void => { assert(ok, `${label} — change applyProjectRoot in src/boot/entrypoints/projectRoot.ts (the --project / --project= handling: argv splice, realpath, process.chdir)`); checks++; console.log(`PASS ${label}`) }
try {
  const plain = ['node', 'app', 'run', 'hello']
  check('an undeclared launch changes neither cwd nor arguments', !applyProjectRoot(plain) && process.cwd() === original && plain.join('|') === 'node|app|run|hello')
  const args = ['node', 'app', '--project', link, 'run', 'hello']
  check('the declaration applies before ordinary arguments', applyProjectRoot(args))
  check('the declared project is canonical and supports spaces', process.cwd() === target)
  assert.deepEqual(args, ['node', 'app', 'run', 'hello'], 'applyProjectRoot must splice the --project pair out of argv (src/boot/entrypoints/projectRoot.ts)')
  process.chdir(original)
  const equals = ['node', 'app', `--project=${target}`, '--help']
  check('the equals spelling selects the same root', applyProjectRoot(equals) && process.cwd() === target)
  assert.deepEqual(equals, ['node', 'app', '--help'], 'applyProjectRoot must splice the --project=<dir> argument out of argv (src/boot/entrypoints/projectRoot.ts)')
  process.chdir(original)
  const file = join(scratch, 'file.txt')
  writeFileSync(file, 'not a directory')
  for (const value of ['', '--help', join(scratch, 'missing'), file]) {
    const invalid = ['node', 'app', '--project', value, 'run']
    const before = [...invalid]
    assert.throws(() => applyProjectRoot(invalid), /[\s\S]*/, `applyProjectRoot must throw for --project value ${JSON.stringify(value)} (empty, option-like, missing or not a directory) in src/boot/entrypoints/projectRoot.ts`)
    assert.deepEqual(invalid, before, 'applyProjectRoot must leave argv untouched when it throws (src/boot/entrypoints/projectRoot.ts)')
    check('an invalid declaration changes nothing', process.cwd() === original)
  }
  const afterEnd = ['node', 'app', '--', '--project', target]
  check('a prompt operand cannot move the project', !applyProjectRoot(afterEnd) && process.cwd() === original)
  console.log(`Project root declaration: ${checks} checks passed`)
} finally {
  process.chdir(original)
  rmSync(scratch, { recursive: true, force: true })
}
