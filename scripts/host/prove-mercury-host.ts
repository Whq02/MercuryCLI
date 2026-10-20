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
assert.ok(existsSync(join(root, 'src/services/host/boxRecipes.ts')), 'own computers have memory-based recipes')
const { BOX_RECIPES, fitsBox, boxFitWords, boxWeightsWords } = await import('../../src/services/host/boxRecipes.js')
const large = BOX_RECIPES.find(row => row.id === 'glm53-flash-gguf')!
assert.equal(fitsBox(large, local), false)
assert.equal(boxFitWords(large, local), 'needs 200 GB; this box has 48')
for (const recipe of BOX_RECIPES.filter(row => row.id !== large.id)) assert.equal(fitsBox(recipe, local), true, recipe.id)
assert.equal(BOX_RECIPES.filter(row => row.verified.by === 'measured').length, 1)
assert.equal(BOX_RECIPES.find(row => row.id === 'nemotron35-bolt')!.verified.on, '2026-10-19')
assert.match(boxWeightsWords(large, '/chosen/bank', false), /200 GB.*\/chosen\/bank/)
assert.match(boxWeightsWords(large, '/chosen/bank', true), /verify SHA256SUMS/)
console.log('MERCURY HOST GREEN · honest memory fits and download confirmation words')
const { mkdirSync, writeFileSync } = await import('node:fs')
const { createHash } = await import('node:crypto')
const { hostRunner } = await import('../../src/services/host/ssh.js')
const { verifyBoxBank } = await import('../../src/services/host/boxBank.js')
const bank = join(process.env.MERCURY_CONFIG_DIR, 'bank with spaces')
mkdirSync(bank, { recursive: true })
const contents = 'fixture model bytes'
writeFileSync(join(bank, 'model.gguf'), contents)
writeFileSync(join(bank, 'SHA256SUMS'), createHash('sha256').update(contents).digest('hex') + '  model.gguf\n')
const tiny = { ...large, files: ['model.gguf'] }
await verifyBoxBank(local, tiny, bank, hostRunner, signal)
writeFileSync(join(bank, 'model.gguf'), 'corrupt')
await assert.rejects(() => verifyBoxBank(local, tiny, bank, hostRunner, signal), /checksum failed/)
writeFileSync(join(bank, 'SHA256SUMS'), '0'.repeat(64) + '  ../escape\n')
await assert.rejects(() => verifyBoxBank(local, tiny, bank, hostRunner, signal), /Unsafe path/)
console.log('MERCURY HOST GREEN · bank verifies bytes, completeness and safe paths')
