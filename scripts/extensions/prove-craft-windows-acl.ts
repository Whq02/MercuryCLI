import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const cases = ['repeat-private', 'clean-environment', 'original-error']
const selected = process.argv.includes('--case') ? [process.argv[process.argv.indexOf('--case') + 1]!] : cases
assert(selected.every(name => cases.includes(name)), 'Unknown ACL fixture')
if (process.platform === 'win32') {
  console.log('SKIP fake PowerShell executable on Windows; run prove-lightcraft.ts and prove-photocraft.ts with native ACLs')
  process.exit(0)
}
const scratch = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR ?? tmpdir(), 'craft-windows-acl-'))
const fake = String.raw`#!/usr/bin/env node
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
const script = process.argv.at(-1)
const path = process.env.MERCURY_LIGHTCRAFT_PRIVATE_DIR ?? process.env.PHOTOCRAFT_PRIVATE_PATH
const modules = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() === 'psmodulepath'))
const state = existsSync(process.env.CRAFT_FIXTURE_STATE) ? JSON.parse(readFileSync(process.env.CRAFT_FIXTURE_STATE, 'utf8')) : {}
const entry = { path, modules, script, read: script.includes('Get-Acl'), set: false }
if (process.env.CRAFT_FIXTURE_FAILURE) {
  appendFileSync(process.env.CRAFT_FIXTURE_LOG, JSON.stringify(entry) + '\n')
  console.error(process.env.CRAFT_FIXTURE_FAILURE)
  process.exit(1)
}
const checksBeforeSet = /if\s*\(\s*-not\s*\(Test-PrivateAcl\s+\$a\s+\$u\)\s*\)/.test(script)
if (checksBeforeSet) {
  assert(script.indexOf('Get-Acl') < script.indexOf('Set-Acl'))
  for (const term of ['AreAccessRulesProtected', 'GetOwner', 'GetAccessRules', 'FullControl', 'ContainerInherit,ObjectInherit', 'PropagationFlags', 'AccessControlType']) assert(script.includes(term), term)
}
if (script.includes('Set-Acl') && !(checksBeforeSet && state[path] === 'private')) {
  entry.set = true
  if (process.env.MERCURY_LIGHTCRAFT_PRIVATE_DIR && state[path] === 'private') {
    appendFileSync(process.env.CRAFT_FIXTURE_LOG, JSON.stringify(entry) + '\n')
    console.error('PrivilegeNotHeld: SeSecurityPrivilege is required for a second Set-Acl')
    process.exit(1)
  }
  state[path] = 'private'
  writeFileSync(process.env.CRAFT_FIXTURE_STATE, JSON.stringify(state))
}
appendFileSync(process.env.CRAFT_FIXTURE_LOG, JSON.stringify(entry) + '\n')
`
const runner = String.raw`import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = process.env.CRAFT_FIXTURE_ROOT
const light = await import(pathToFileURL(join(root, 'lightcraft/server/install.mjs')))
const photo = await import(pathToFileURL(join(root, 'photocraft/server/install.mjs')))
Object.defineProperty(process, 'platform', { value: 'win32' })
const readCalls = () => readFileSync(process.env.CRAFT_FIXTURE_LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line))
const data = join(root, 'data')
if (process.argv[2] === 'repeat-private') {
  const first = light.privateEnvironment(data)
  const second = light.privateEnvironment(data)
  assert.equal(first.LIGHTCRAFT_CONFIG_DIR, second.LIGHTCRAFT_CONFIG_DIR)
  assert.notEqual(first.TMPDIR, second.TMPDIR)
  let calls = readCalls()
  assert.equal(calls.filter(call => call.path === first.LIGHTCRAFT_CONFIG_DIR && call.set).length, 1)
  assert.equal(calls.filter(call => call.path === first.LIGHTCRAFT_CONFIG_DIR && call.read).length, 2)
  const state = JSON.parse(readFileSync(process.env.CRAFT_FIXTURE_STATE, 'utf8'))
  state[first.LIGHTCRAFT_CONFIG_DIR] = 'public'
  writeFileSync(process.env.CRAFT_FIXTURE_STATE, JSON.stringify(state))
  light.privateEnvironment(data)
  calls = readCalls()
  assert.equal(calls.filter(call => call.path === first.LIGHTCRAFT_CONFIG_DIR && call.set).length, 2)
} else if (process.argv[2] === 'clean-environment') {
  light.privateEnvironment(data)
  const token = photo.prepareControl(join(root, 'photo-data'))
  writeFileSync(token, 'a'.repeat(64))
  assert.equal(photo.readPrivateToken(token), 'a'.repeat(64))
  const calls = readCalls()
  assert.equal(calls.length, 4)
  for (const call of calls) assert.deepEqual(call.modules, {}, 'PowerShell 5.1 must rebuild its default module path')
  assert(process.env.PSModulePath.includes('WindowsApps'))
  assert(process.env.PsModulePath.includes('WindowsApps'))
} else {
  for (const failure of ['Microsoft.PowerShell.Security module could not be loaded', 'PrivilegeNotHeld: SeSecurityPrivilege', 'PowerShell ACL operation timed out']) {
    process.env.CRAFT_FIXTURE_FAILURE = failure
    assert.throws(() => photo.prepareControl(join(root, 'photo-data')), error => error.message.includes(failure) && error.stderr.toString().includes(failure))
    assert.throws(() => light.privateEnvironment(data), error => error.message.includes(failure) && error.stderr.toString().includes(failure))
  }
}
`
try {
  const bin = join(scratch, 'bin')
  const system = join(scratch, 'system')
  const powershell = join(system, 'System32', 'WindowsPowerShell', 'v1.0')
  mkdirSync(bin, { recursive: true })
  mkdirSync(powershell, { recursive: true })
  const fakeModule = join(scratch, 'powershell.mjs')
  writeFileSync(fakeModule, fake)
  const launcher = `#!/bin/sh\nexec node '${fakeModule.replaceAll("'", "'\\''")}' "$@"\n`
  for (const directory of [bin, powershell]) {
    writeFileSync(join(directory, 'powershell.exe'), launcher)
    chmodSync(join(directory, 'powershell.exe'), 0o755)
  }
  let failed = 0
  for (const name of selected) {
    const folder = join(scratch, name)
    mkdirSync(folder)
    for (const extension of ['lightcraft', 'photocraft']) {
      cpSync(join(root, 'src/extensions/bundled', extension), join(folder, extension), { recursive: true })
      cpSync(join(root, 'src/extensions/bundled/shared'), join(folder, extension, 'shared'), { recursive: true })
    }
    const file = join(folder, 'runner.mjs')
    writeFileSync(file, runner)
    const result = spawnSync('node', [file, name], {
      encoding: 'utf8', timeout: 30000,
      env: {
        ...process.env, PATH: bin + delimiter + process.env.PATH, SystemRoot: system,
        PSModulePath: String.raw`C:\Program Files\WindowsApps\Microsoft.PowerShell_7\Modules`,
        PsModulePath: String.raw`C:\Program Files\WindowsApps\Microsoft.PowerShell_7\Modules`,
        CRAFT_FIXTURE_ROOT: folder, CRAFT_FIXTURE_LOG: join(folder, 'calls.jsonl'), CRAFT_FIXTURE_STATE: join(folder, 'state.json'),
      },
    })
    if (result.status !== 0) {
      failed++
      console.error(`FAIL ${name}: exit ${result.status}\n${result.stderr || result.error}`)
    } else console.log(`PASS ${name}: exit 0`)
  }
  assert.equal(failed, 0, 'Windows ACL fixtures failed')
} finally { rmSync(scratch, { recursive: true, force: true }) }
