#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'test-path-selects-home-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = join(import.meta.dir, '..', '..')
const { discoverRunnerProfiles, runRunnerProfile } = await import(join(ROOT, 'src/services/ide/projectRunners.ts'))

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const project = mkdtempSync(join(tmpdir(), 'test-path-selects-project-'))
mkdirSync(join(project, 'test'))
writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'p', private: true, type: 'module', scripts: { test: 'node --test' } }) + '\n')
const lines = (names: string[]): string => ["import { test } from 'node:test'", "import assert from 'node:assert/strict'", ...names.map(n => `test('${n}', () => { assert.equal(1, 1) })`), ''].join('\n')
writeFileSync(join(project, 'test', 'alpha.test.mjs'), lines(['alpha one', 'alpha two']))
writeFileSync(join(project, 'test', 'beta.test.mjs'), lines(['beta one']))

const profile = discoverRunnerProfiles(project).profiles.find(p => p.runner === 'node-test' && p.kind === 'test')
check('the node:test profile is discovered from the manifest', profile !== undefined)
if (profile) {
  const file = join(project, 'test', 'alpha.test.mjs')
  const byPath = await runRunnerProfile(profile, { from: project, selection: file, selectionKind: 'path', selectionLabel: 'file:test/alpha.test.mjs' })
  const pathOut = byPath.state === 'ok' ? byPath.record.outputTail : JSON.stringify(byPath)
  const pathCmd = byPath.state === 'ok' ? byPath.record.command : []
  check('a FILE selection hands the file to node positionally, never as a name pattern', pathCmd.includes(file) && !pathCmd.includes('--test-name-pattern'), JSON.stringify(pathCmd))
  check("a FILE selection runs that file's real cases (node names them, not the file as a passing wrapper)", /ok \d+ - alpha one/.test(pathOut) && /ok \d+ - alpha two/.test(pathOut) && !/ok \d+ - .*alpha\.test\.mjs/.test(pathOut) && !/beta/.test(pathOut), pathOut.slice(-400))
  const byName = await runRunnerProfile(profile, { from: project, selection: 'beta one', selectionKind: 'node', selectionLabel: 'nodes:beta one' })
  const nameOut = byName.state === 'ok' ? byName.record.outputTail : JSON.stringify(byName)
  const nameCmd = byName.state === 'ok' ? byName.record.command : []
  check('a NAME selection still rides the name pattern and runs the named case', nameCmd.includes('--test-name-pattern') && /ok \d+ - beta one/.test(nameOut) && !/alpha one/.test(nameOut), `${JSON.stringify(nameCmd)} ${nameOut.slice(-300)}`)
  const whole = await runRunnerProfile(profile, { from: project })
  check('no selection runs everything', whole.state === 'ok' && whole.record.counts.passed === 3, JSON.stringify(whole.state === 'ok' ? whole.record.counts : whole))
}

rmSync(project, { recursive: true, force: true })
console.log(failures === 0 ? 'PASS: a file selection runs the file' : `FAIL: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
