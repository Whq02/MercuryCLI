import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const root = new URL('../../', import.meta.url).pathname
assert.ok(existsSync(join(root, 'src/services/host/boxes.ts')), 'own computers are first-class recorded targets')
const { discoverBox, readBox, listBoxes } = await import('../../src/services/host/boxes.js')
const { boxInspectionScript, windowsBoxInspectionScript } = await import('../../src/services/host/ssh.js')
const facts = 'OS darwin\nARCH arm64\nHOME /fixture/home\nUID 501\nMEMORY 51539607552\nDISPLAYS {"SPDisplaysDataType":[{"sppci_model":"Apple test GPU"}]}\nENGINE ollama|/fixture/bin/ollama|0.34.4|11434\nENGINE llamacpp|/fixture/bin/llama-server|test-build|30000\nBANK /fixture/bank\n'
const commands: { command: string; args: string[] }[] = []
const runner = {
  async run(command: string, args: string[]) { commands.push({ command, args }); return facts },
  tunnel() { throw new Error('Discovery must not tunnel') },
}
const signal = new AbortController().signal
const remote = await discoverBox({ name: 'fixture', kind: 'ssh', target: { host: 'fixture.invalid', user: 'tester' }, os: 'darwin' }, runner, signal)
assert.equal(commands.length, 1, 'one SSH read discovers the box')
assert.equal(commands[0]!.command, 'ssh')
assert.equal(remote.memoryGb, 48)
assert.equal(remote.unifiedMemory, true)
assert.equal(remote.gpus[0]!.name, 'Apple test GPU')
assert.equal(remote.engines[0]!.kind, 'ollama')
assert.equal(remote.engines[0]!.version, '0.34.4')
assert.equal(remote.engines[0]!.port, 11434)
assert.deepEqual(remote.bankPaths, ['/fixture/bank'])
assert.equal(readBox('fixture')!.target!.host, 'fixture.invalid')
assert.equal(JSON.parse(readFileSync(join(process.env.MERCURY_CONFIG_DIR, 'host/boxes/fixture.json'), 'utf8')).memoryGb, 48)
const local = await discoverBox({ name: 'this-computer', kind: 'this-computer' }, runner, signal)
assert.equal(local.os, 'darwin')
assert.equal(commands[1]!.command, '/bin/sh')
assert.equal(listBoxes().length, 2)
assert.match(boxInspectionScript, /system_profiler SPDisplaysDataType/)
assert.match(boxInspectionScript, /sysctl -n hw.memsize/)
assert.match(windowsBoxInspectionScript, /Win32_ComputerSystem/)
await assert.rejects(() => discoverBox({ name: '../escape', kind: 'this-computer' }, runner, signal))
await assert.rejects(() => discoverBox({ name: 'bad', kind: 'ssh', target: { host: '-bad' } }, runner, signal))
console.log('MERCURY HOST GREEN · discovery, persistence, memory, engines and banks; fixtures only')
