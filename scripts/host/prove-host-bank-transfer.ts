import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import type { HostRecipe } from '../../src/services/host/recipes.ts'
import type { HostRunner } from '../../src/services/host/ssh.ts'

assert.ok(process.env.MERCURY_CONFIG_DIR, 'a scratch MERCURY_CONFIG_DIR is required')
const f = await llmhostFixture()
let checks = 0
let failures = 0
const check = (name: string, truth: unknown) => { checks++; if (!truth) failures++; console.log((truth ? 'PASS ' : 'FAIL ') + name) }
try {
  const { HOST_RECIPES } = await import('../../src/services/host/recipes.ts')
  const { startHostEngine } = await import('../../src/services/host/ssh.ts')
  const gguf = { ...HOST_RECIPES.find(row => row.engine === 'llamacpp')!, id: 'fixture-bank-transfer', model: 'fixture/bank-transfer', weightFile: 'tiny.gguf', include: 'tiny.gguf', mmproj: undefined }
  const tensors = { ...HOST_RECIPES.find(row => !row.engine || row.engine === 'sglang')!, id: 'fixture-bank-tensors', model: 'fixture/bank-transfer', engine: 'sglang' as const, weightFile: undefined, mmproj: undefined }
  const exercise = async (name: string, recipe: HostRecipe, files: Record<string, string>, accepted: boolean) => {
    const folder = join(f.home, 'transfer', name)
    mkdirSync(folder, { recursive: true })
    for (const [path, bytes] of Object.entries(files)) { mkdirSync(join(folder, path, '..'), { recursive: true }); writeFileSync(join(folder, path), bytes) }
    const commands: { command: string; args: string[] }[] = []
    const runner: HostRunner = {
      tunnel() { throw new Error('this proof starts no tunnel') },
      async run(command, args) { commands.push({ command, args }); return args.at(-1)?.includes('command -v llama-server') ? 'MERCURY_PREBUILT_ENGINE yes\n' : '' },
    }
    let error: unknown
    try { await startHostEngine({ host: '127.0.0.1', port: 22000, user: 'root' }, recipe, runner, new AbortController().signal, false, true, folder) } catch (caught) { error = caught }
    check(name + (accepted ? ' accepts the complete bank' : ' refuses the incomplete or mismatched bank'), accepted ? !error : Boolean(error))
    const transfers = commands.filter(row => row.command === 'rsync')
    const launch = commands.find(row => row.command === 'ssh' && row.args.at(-1)?.includes('nohup setsid'))?.args.at(-1)
    check(name + (accepted ? ' transfers once and launches without downloading weights' : ' never transfers or launches'), accepted ? transfers.length === 1 && transfers[0]!.args.includes(folder + '/') && launch && !launch.includes('hf download') : !transfers.length && !launch)
  }
  await exercise('single-gguf', gguf, { 'tiny.gguf': 'weights' }, true)
  await exercise('sharded-gguf', { ...gguf, weightFile: 'tiny-00001-of-00002.gguf' }, { 'tiny-00001-of-00002.gguf': 'first', 'tiny-00002-of-00002.gguf': 'second' }, true)
  await exercise('missing-gguf', gguf, {}, false)
  await exercise('missing-gguf-shard', { ...gguf, weightFile: 'tiny-00001-of-00002.gguf' }, { 'tiny-00001-of-00002.gguf': 'first' }, false)
  await exercise('missing-projector', { ...gguf, mmproj: 'mmproj.gguf' }, { 'tiny.gguf': 'weights' }, false)
  await exercise('single-gguf-projector', { ...gguf, mmproj: 'mmproj.gguf' }, { 'tiny.gguf': 'weights', 'mmproj.gguf': 'projector' }, true)
  const config = JSON.stringify({ _name_or_path: 'fixture/bank-transfer' })
  await exercise('single-safetensors', tensors, { 'config.json': config, 'model.safetensors': 'weights' }, true)
  await exercise('sharded-safetensors', tensors, { 'config.json': config, 'model.safetensors.index.json': JSON.stringify({ weight_map: { first: 'first.safetensors', second: 'second.safetensors' } }), 'first.safetensors': 'first', 'second.safetensors': 'second' }, true)
  await exercise('missing-safetensors', tensors, { 'config.json': config }, false)
  await exercise('empty-safetensors', tensors, { 'config.json': config, 'model.safetensors': '' }, false)
  await exercise('missing-safetensors-shard', tensors, { 'config.json': config, 'model.safetensors.index.json': JSON.stringify({ weight_map: { first: 'first.safetensors', second: 'second.safetensors' } }), 'first.safetensors': 'first' }, false)
  await exercise('mismatched-model', tensors, { 'config.json': JSON.stringify({ _name_or_path: 'fixture/other-model' }), 'model.safetensors': 'weights' }, false)
  await exercise('invalid-safetensors-index', tensors, { 'config.json': config, 'model.safetensors.index.json': '{invalid', 'model.safetensors': 'weights' }, false)
  assert.equal(failures, 0, failures + ' bank-transfer checks failed')
  console.log('HOST BANK TRANSFER GREEN — ' + checks + ' checks; scratch files and captured commands only')
} finally { f.close() }
