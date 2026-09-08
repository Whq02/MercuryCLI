#!/usr/bin/env bun
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyProjectRoot } from '../../src/entrypoints/projectRoot.ts'

const original = process.cwd()
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'project-root-')))
const target = join(scratch, 'project with spaces')
mkdirSync(target)
const link = join(scratch, 'linked-project')
symlinkSync(target, link)
let checks = 0
const check = (label: string, ok: unknown): void => { assert(ok, label); checks++; console.log(`PASS ${label}`) }
try {
  const plain = ['node', 'app', '-p', 'hello']
  check('an undeclared launch changes neither cwd nor arguments', !applyProjectRoot(plain) && process.cwd() === original && plain.join('|') === 'node|app|-p|hello')
  const args = ['node', 'app', '--project-root', link, '-p', 'hello']
  check('the declaration applies before ordinary arguments', applyProjectRoot(args))
  check('the declared project is canonical and supports spaces', process.cwd() === target)
  assert.deepEqual(args, ['node', 'app', '-p', 'hello'])
  process.chdir(original)
  const equals = ['node', 'app', `--project-root=${target}`, '--help']
  check('the equals spelling selects the same root', applyProjectRoot(equals) && process.cwd() === target)
  assert.deepEqual(equals, ['node', 'app', '--help'])
  process.chdir(original)
  const file = join(scratch, 'file.txt')
  writeFileSync(file, 'not a directory')
  for (const value of ['', '--help', join(scratch, 'missing'), file]) {
    const invalid = ['node', 'app', '--project-root', value, '-p']
    const before = [...invalid]
    assert.throws(() => applyProjectRoot(invalid))
    assert.deepEqual(invalid, before)
    check('an invalid declaration changes nothing', process.cwd() === original)
  }
  const afterEnd = ['node', 'app', '--', '--project-root', target]
  check('a prompt operand cannot move the project', !applyProjectRoot(afterEnd) && process.cwd() === original)
  const entry = readFileSync(join(import.meta.dir, '../../src/entrypoints/cli.tsx'), 'utf8')
  const declared = entry.indexOf('applyProjectRoot(process.argv)')
  const loaded = entry.indexOf("import('../utils/startupProfiler.js')")
  check('the root is selected before project state loads', declared >= 0 && loaded > declared)
  check('a declared root skips saved splash-directory selection', entry.includes('process.stdout.isTTY && !hasProjectRoot'))
  console.log(`Project root declaration: ${checks} checks passed`)
} finally {
  process.chdir(original)
  rmSync(scratch, { recursive: true, force: true })
}
