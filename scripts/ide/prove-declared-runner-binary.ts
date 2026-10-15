#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const root = mkdtempSync(path.join(tmpdir(), 'declared-runner-'))
process.env.MERCURY_CONFIG_DIR = path.join(root, 'home')
process.env.MERCURY_BARE = '1'
const { discoverRunnerProfiles, resolveRunnerBinary, runRunnerProfile } = await import('../../src/services/ide/projectRunners.ts')
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const binDir = path.join(root, 'node_modules', '.bin')
mkdirSync(binDir, { recursive: true })
let failures = 0
function check(label: string, body: () => void) {
  try { body(); console.log(`PASS ${label}`) }
  catch (e) { failures++; console.error(`FAIL ${label}: ${e}`) }
}
try {
  for (const runner of ['vitest', 'jest']) {
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { [runner]: '*' } }))
    const bin = path.join(binDir, runner)
    writeFileSync(bin, '#!/bin/sh\n')
    writeFileSync(`${bin}.cmd`, '@echo off\n')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    check(`${runner}: Windows profile selects the cmd spelling beside the sh shim`, () => {
      const profile = discoverRunnerProfiles(root).profiles.find(p => p.runner === runner)!
      assert.equal(profile.command[0], `${bin}.cmd`)
      assert.equal(profile.availability.state, 'ok')
    })
    const entry = path.join(root, 'node_modules', runner, runner === 'vitest' ? 'vitest.mjs' : 'bin/jest.js')
    mkdirSync(path.dirname(entry), { recursive: true })
    writeFileSync(entry, `import { writeFileSync } from 'node:fs'; const output = process.argv.find(a => a.startsWith('--outputFile=')); writeFileSync(output.slice(13), JSON.stringify({numTotalTests:1,testResults:[{assertionResults:[{status:'passed'}]}]})); console.log(JSON.stringify(process.argv.slice(2)));`)
    const selection = 'literal & %NAME% ^ " >'
    const running = runRunnerProfile(discoverRunnerProfiles(root).profiles.find(p => p.runner === runner)!, { from: root, selection })
    Object.defineProperty(process, 'platform', platform)
    const run = await running
    Object.defineProperty(process, 'platform', { value: 'win32' })
    check(`${runner}: the cmd shim runs its JavaScript entry without a shell`, () => {
      assert.equal(run.state, 'ok')
      if (run.state === 'ok') {
        assert.equal(run.record.exitCode, 0)
        assert.equal(run.record.counts.passed, 1)
        assert.deepEqual(run.record.command.slice(0, 2), [process.execPath, entry])
        assert.ok(run.record.outputTail.join('\n').includes(JSON.stringify(selection)))
      }
    })
    rmSync(`${bin}.cmd`)
    check(`${runner}: sh shim alone is unavailable with an install remedy`, () => {
      const profile = discoverRunnerProfiles(root).profiles.find(p => p.runner === runner)!
      assert.equal(profile.availability.state, 'unavailable')
      if (profile.availability.state === 'unavailable') assert.match(profile.availability.remedy, /install/)
    })
    Object.defineProperty(process, 'platform', platform)
    check(`${runner}: Unix keeps the bare executable`, () => assert.equal(discoverRunnerProfiles(root).profiles.find(p => p.runner === runner)!.command[0], bin))
  }
  writeFileSync(path.join(binDir, 'tool.exe'), '')
  check('PATHEXT resolves both a PATH name and an explicit filename', () => {
    const env = { PATH: binDir, PATHEXT: '.EXE;.CMD' }
    assert.equal(resolveRunnerBinary('tool', env, 'win32'), path.join(binDir, 'tool.exe'))
    assert.equal(resolveRunnerBinary(path.join(binDir, 'tool'), env, 'win32'), path.join(binDir, 'tool.exe'))
    assert.equal(resolveRunnerBinary(path.join(binDir, 'tool.exe'), env, 'win32'), path.join(binDir, 'tool.exe'))
  })
} finally {
  Object.defineProperty(process, 'platform', platform)
  rmSync(root, { recursive: true, force: true })
}
if (failures) process.exit(1)
console.log('prove-declared-runner-binary: GREEN')
