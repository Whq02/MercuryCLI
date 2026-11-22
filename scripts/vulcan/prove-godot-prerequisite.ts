#!/usr/bin/env bun
import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { godotPrerequisiteFailure, resolveProofGodot } from './proofGodot.ts'

assert.equal(godotPrerequisiteFailure({ status: 0, stdout: 'Godot Engine 4\n', stderr: '' }), null, 'a clean version probe must read as available: fix godotPrerequisiteFailure in scripts/vulcan/proofGodot.ts')
assert.match(godotPrerequisiteFailure({ status: null, signal: 'SIGKILL', stderr: 'ERROR: sh: dotnet: command not found\n' })!, /dotnet: command not found/, 'a missing dotnet must be named from the probe output: fix godotPrerequisiteFailure in scripts/vulcan/proofGodot.ts')
assert.match(godotPrerequisiteFailure({ status: 0, stderr: 'ERROR: .NET: One of the dependent libraries is missing.' })!, /dependent libraries/, 'a .NET dependent-libraries error must fail the prerequisite even at status 0: fix godotPrerequisiteFailure in scripts/vulcan/proofGodot.ts')
assert.match(godotPrerequisiteFailure({ status: null, error: new Error('spawn failed: executable missing') })!, /executable missing/, 'a spawn error message must be returned as the reason: fix godotPrerequisiteFailure in scripts/vulcan/proofGodot.ts')
assert.match(godotPrerequisiteFailure({ status: null, signal: 'SIGKILL' })!, /SIGKILL/, 'a killed probe must name its signal: fix godotPrerequisiteFailure in scripts/vulcan/proofGodot.ts')
assert.match(godotPrerequisiteFailure({ status: 2, stderr: 'ERROR: cannot initialize engine' })!, /cannot initialize engine/, 'a nonzero exit must return the first ERROR line of stderr: fix godotPrerequisiteFailure in scripts/vulcan/proofGodot.ts')
for (const name of ['check', 'debugger', 'instances', 'media', 'query-boot', 'scene-tree', 'service']) {
  const source = readFileSync(join(import.meta.dir, `prove-engine-${name}.ts`), 'utf8')
  assert.ok(source.includes("import('./proofGodot.ts')") && source.includes('resolveProofGodot()'), `${name} must probe the engine before its live legs: make scripts/vulcan/prove-engine-${name}.ts import ./proofGodot.ts and call resolveProofGodot()`)
  assert.ok(source.includes('[SKIP]') && source.includes('.reason}'), `${name} must name why its live leg did not run: make scripts/vulcan/prove-engine-${name}.ts print [SKIP] with the resolveProofGodot reason`)
}
if (process.platform === 'win32') {
  console.log('not read on Windows: godot stub script uses POSIX #!/bin/sh')
} else {
  const scratch = mkdtempSync(join(tmpdir(), 'godot-stub-'))
  const noDotnetPath = join(scratch, 'empty-bin')
  const hostedDotnetBin = join(scratch, 'hosted-usr-bin')
  mkdirSync(noDotnetPath)
  mkdirSync(hostedDotnetBin)
  const fakeDotnet = join(hostedDotnetBin, 'dotnet')
  writeFileSync(fakeDotnet, '#!/bin/sh\necho 8.0.100\nexit 0\n')
  chmodSync(fakeDotnet, 0o755)
  const calls = join(scratch, 'calls.txt')
  const stub = join(scratch, 'godot')
  const kept = { bin: process.env.GODOT_BIN, path: process.env.PATH, dotnetRoot: process.env.DOTNET_ROOT }
  try {
    for (const [build, pathEnv, wanted, launched] of [
      ['4.7.2.stable.mono.official.ed1daf0bf', noDotnetPath, /is a \.NET build and no dotnet is installed/, ['--version']],
      ['4.7.2.stable.mono.official.ed1daf0bf', `${scratch}:${hostedDotnetBin}`, null, ['--version', '--headless']],
      ['4.7.2.stable.official.ed1daf0bf', noDotnetPath, null, ['--version', '--headless']],
    ] as const) {
      writeFileSync(calls, '')
      writeFileSync(stub, `#!/bin/sh\necho "$1" >> ${JSON.stringify(calls)}\n[ "$1" = --version ] && echo ${build}\nexit 0\n`)
      chmodSync(stub, 0o755)
      process.env.GODOT_BIN = stub
      process.env.PATH = pathEnv
      delete process.env.DOTNET_ROOT
      const found = await resolveProofGodot()
      const firstWords = readFileSync(calls, 'utf8').split('\n').filter(Boolean)
      if (wanted === null) assert.deepEqual([found.resolved, found.reason], [stub, null], `a build whose runtime is present and opens an empty project is taken: ${found.reason}; fix resolveProofGodot in scripts/vulcan/proofGodot.ts`)
      else assert.ok(found.resolved === null && wanted.test(found.reason ?? ''), `a .NET build with no dotnet on the path is skipped by name: ${found.reason}; fix resolveProofGodot in scripts/vulcan/proofGodot.ts`)
      assert.deepEqual(firstWords, launched, `the engine was started with ${firstWords.join(' then ')}; a .NET build with no dotnet is asked its version and never opened; fix resolveProofGodot in scripts/vulcan/proofGodot.ts`)
    }
  } finally {
    if (kept.bin === undefined) delete process.env.GODOT_BIN
    else process.env.GODOT_BIN = kept.bin
    if (kept.path === undefined) delete process.env.PATH
    else process.env.PATH = kept.path
    if (kept.dotnetRoot === undefined) delete process.env.DOTNET_ROOT
    else process.env.DOTNET_ROOT = kept.dotnetRoot
    rmSync(scratch, { recursive: true, force: true })
  }
}
console.log('PASS an empty-project prerequisite distinguishes an available engine from missing runtime, spawn failure, crash and timeout; every autodiscovered live leg names its skip')
