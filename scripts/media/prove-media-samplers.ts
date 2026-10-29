import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client, StdioClientTransport } from '../../src/services/mcp/sdk.js'
import { installLiveFixture, proofHome, root, serverPath, stopFixtureEngine } from './fixture.ts'

process.chdir(proofHome)
const client = new Client({ name: 'media-sampling-proof', version: '1.0.0' })
try {
  installLiveFixture()
  mkdirSync(join(root, 'models'), { recursive: true })
  writeFileSync(join(root, 'models/image.gguf'), Buffer.alloc(8))
  writeFileSync(join(root, 'models/encoder.gguf'), Buffer.alloc(2))
  const local = JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8'))
  local.recipes = [{ schema_version: 1, id: 'fixture-recipe', name: 'Fixture', slots: [{ id: 'diffusion_model', required: true }, { id: 'llm', required: false }], defaults: { sampling_method: 'heun', scheduler: 'karras' } }]
  local.runtime = { families: ['fixture-recipe'], componentFamilies: ['fixture-recipe'] }
  writeFileSync(join(root, 'catalog.json'), JSON.stringify(local))
  await client.connect(new StdioClientTransport({ command: 'node', args: [serverPath], cwd: proofHome, env: { ...process.env, MEDIA_ROOT: root, MEDIA_OUTPUT_DIR: join(root, 'outputs') } as Record<string, string>, stderr: 'pipe' }))
  const tools = await client.listTools(), schema = tools.tools.find(tool => tool.name === 'image_generate')!.inputSchema
  assert.ok(schema.properties?.sampler)
  assert.ok(schema.properties?.scheduler)
  const generate = (args: Record<string, unknown>) => client.callTool({ name: 'image_generate', arguments: { model: 'image-one', prompt: 'fixture', width: 64, height: 64, wait: true, seed: 123, ...args } })
  for (const args of [{ sampler: 'not-a-sampler' }, { scheduler: 'not-a-scheduler' }]) {
    const refused = await generate(args)
    assert.equal(refused.isError, true)
    assert.match((refused.content as Array<{ text: string }>)[0]!.text, /euler|discrete/)
  }
  assert.equal(existsSync(join(root, 'engine-calls.jsonl')), false)
  for (const [args, expected] of [[{}, ['heun', 'karras']], [{ sampler: 'dpm++2m_sde', scheduler: 'exponential' }, ['dpm++2m_sde', 'exponential']], [{ scheduler: 'normal' }, ['heun', 'discrete']]] as const) {
    const generated = await generate(args)
    assert.equal(generated.isError ?? false, false, JSON.stringify(generated))
    const result = JSON.parse((generated.content as Array<{ text: string }>)[0]!.text)
    assert.deepEqual([result.sampler, result.scheduler], [...expected])
  }
  const calls = readFileSync(join(root, 'engine-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(call => call.route === 'img_gen')
  assert.deepEqual(calls.map(call => [call.body.sample_params.sample_method, call.body.sample_params.scheduler]), [['heun', 'karras'], ['dpm++2m_sde', 'exponential'], ['heun', 'discrete']])
  assert.deepEqual(await client.listTools(), tools)
  console.log('media samplers: discovered enums, unknown-name lists, family pins, independent overrides and native result names')
} finally {
  await client.close()
  await stopFixtureEngine()
  rmSync(proofHome, { recursive: true, force: true })
}
