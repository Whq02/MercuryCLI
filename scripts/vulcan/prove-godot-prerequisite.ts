#!/usr/bin/env bun
import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { godotPrerequisiteFailure, resolveProofGodot } from './proofGodot.ts'

assert.equal(godotPrerequisiteFailure({ status: 0, stdout: 'Godot Engine 4\n', stderr: '' }), null)
assert.match(godotPrerequisiteFailure({ status: null, signal: 'SIGKILL', stderr: 'ERROR: sh: dotnet: command not found\n' })!, /dotnet: command not found/)
assert.match(godotPrerequisiteFailure({ status: 0, stderr: 'ERROR: .NET: One of the dependent libraries is missing.' })!, /dependent libraries/)
assert.match(godotPrerequisiteFailure({ status: null, error: new Error('spawn failed: executable missing') })!, /executable missing/)
assert.match(godotPrerequisiteFailure({ status: null, signal: 'SIGKILL' })!, /SIGKILL/)
assert.match(godotPrerequisiteFailure({ status: 2, stderr: 'ERROR: cannot initialize engine' })!, /cannot initialize engine/)
for (const name of ['check', 'debugger', 'instances', 'media', 'query-boot', 'scene-tree', 'service']) {
  const source = readFileSync(join(import.meta.dir, `prove-engine-${name}.ts`), 'utf8')
  assert.ok(source.includes("import('./proofGodot.ts')") && source.includes('resolveProofGodot()'), `${name} must probe the engine before its live legs`)
  assert.ok(source.includes('[SKIP]') && source.includes('.reason}'), `${name} must name why its live leg did not run`)
}
if (process.platform === 'win32') {
  console.log('not read on Windows: godot stub script uses POSIX #!/bin/sh')
} else {
  const scratch = mkdtempSync(join(tmpdir(), 'godot-stub-'))
  const calls = join(scratch, 'calls.txt')
  const stub = join(scratch, 'godot')
  const kept = { bin: process.env.GODOT_BIN, path: process.env.PATH }
  try {
    for (const [build, wanted, launched] of [['4.7.2.stable.mono.official.ed1daf0bf', /is a \.NET build and no dotnet is installed/, ['--version']], ['4.7.2.stable.official.ed1daf0bf', null, ['--version', '--headless']]] as const) {
      writeFileSync(calls, '')
      writeFileSync(stub, `#!/bin/sh\necho "$1" >> ${JSON.stringify(calls)}\n[ "$1" = --version ] && echo ${build}\nexit 0\n`)
      chmodSync(stub, 0o755)
      process.env.GODOT_BIN = stub
      process.env.PATH = `${scratch}:/usr/bin:/bin`
      const found = await resolveProofGodot()
      const firstWords = readFileSync(calls, 'utf8').split('\n').filter(Boolean)
      if (wanted === null) assert.deepEqual([found.resolved, found.reason], [stub, null], `a standard build that opens an empty project is taken: ${found.reason}`)
      else assert.ok(found.resolved === null && wanted.test(found.reason ?? ''), `a .NET build with no dotnet on the path is skipped by name: ${found.reason}`)
      assert.deepEqual(firstWords, launched, `the engine was started with ${firstWords.join(' then ')}; a .NET build with no dotnet is asked its version and never opened`)
    }
  } finally {
    if (kept.bin === undefined) delete process.env.GODOT_BIN
    else process.env.GODOT_BIN = kept.bin
    process.env.PATH = kept.path
    rmSync(scratch, { recursive: true, force: true })
  }
}
console.log('PASS an empty-project prerequisite distinguishes an available engine from missing runtime, spawn failure, crash and timeout; every autodiscovered live leg names its skip')
