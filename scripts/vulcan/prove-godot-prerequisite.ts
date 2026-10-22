#!/usr/bin/env bun
import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { godotPrerequisiteFailure } from './proofGodot.ts'

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
console.log('PASS an empty-project prerequisite distinguishes an available engine from missing runtime, spawn failure, crash and timeout; every autodiscovered live leg names its skip')
