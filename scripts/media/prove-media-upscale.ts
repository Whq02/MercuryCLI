import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { Client, StdioClientTransport } from '../../src/services/mcp/sdk.js'
import { parseMediaCatalogue } from '../../src/services/media/catalogue.js'
import { mediaGenerationDetails } from '../../src/services/media/generation.js'
import { mediaPullPlan, mediaRows, pullMedia, type MediaSnapshot } from '../../src/services/media/setup.js'
import { installLiveFixture, proofHome, root, serverPath, stopFixtureEngine } from './fixture.ts'

process.chdir(proofHome)
Object.assign(globalThis, { MACRO: { VERSION: '1.0.0', IS_DEV: false } })
const { setCwdState, setOriginalCwd, setProjectRoot } = await import('../../src/bootstrap/state.js')
setCwdState(proofHome)
setOriginalCwd(proofHome)
setProjectRoot(proofHome)
const { updateSettingsForSource } = await import('../../src/utils/settings/settings.js')
const { saveMediaSettings } = await import('../../src/services/media/settings.js')
const client = new Client({ name: 'media-upscale-proof', version: '1.0.0' })
try {
  installLiveFixture({ sizedImages: true })
  const bundled = parseMediaCatalogue(JSON.parse(readFileSync(join(dirname(serverPath), 'catalog.json'), 'utf8')))
  const upscalers = bundled.models.filter(model => model.upscaler)
  assert.equal(upscalers.length, 2)
  const machine = { totalMemoryBytes: 64 * 1024 ** 3, usableMemoryBytes: 48 * 1024 ** 3 }
  const rows = mediaRows(bundled, root, machine, 64 * 1024 ** 3)
  const snapshot: MediaSnapshot = { root, catalogue: bundled, rows, config: {}, runtimeInstalled: true, freeBytes: 64 * 1024 ** 3, ...machine }
  for (const model of upscalers) {
    const plan = mediaPullPlan(snapshot, model.id)
    assert.deepEqual(plan.args, ['pull-model', model.id])
    assert.ok(plan.bytes > 17_000_000)
    assert.equal(plan.license, 'BSD-3-Clause')
    assert.match(plan.source, /^https:\/\/github.com\/xinntao\/Real-ESRGAN\/releases\/download\//)
    let ran = false
    assert.equal(await pullMedia(plan, async () => false, async () => { ran = true }, () => {}), false)
    assert.equal(ran, false)
    assert.equal(await pullMedia(plan, async () => true, async args => { assert.deepEqual(args, plan.args); ran = true }, () => {}), true)
    assert.equal(ran, true)
    assert.throws(() => mediaGenerationDetails('image', { model: model.id }, bundled, {}, proofHome), /Choose the image model/)
  }
  const local = JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8'))
  for (const row of upscalers) local.files.push({ path: row.slots.upscale_model, bytes: 3, sha256: createHash('sha256').update('map').digest('hex') })
  writeFileSync(join(root, 'catalog.json'), JSON.stringify(local))
  mkdirSync(join(root, 'models/upscalers'), { recursive: true })
  writeFileSync(join(root, 'models/image.gguf'), Buffer.alloc(8))
  writeFileSync(join(root, 'models/encoder.gguf'), Buffer.alloc(2))
  assert.equal(updateSettingsForSource('userSettings', { media: { root, serverPath, enabled: true } }).error, null)
  await assert.rejects(saveMediaSettings({ imageModel: upscalers[0]!.id }), /Choose a image model/)
  await client.connect(new StdioClientTransport({ command: 'node', args: [serverPath], cwd: proofHome, env: { ...process.env, MEDIA_ROOT: root, MEDIA_OUTPUT_DIR: join(root, 'outputs') } as Record<string, string>, stderr: 'pipe' }))
  const tools = await client.listTools(), schema = tools.tools.find(tool => tool.name === 'image_generate')!.inputSchema
  assert.ok(schema.properties?.upscale)
  const generate = (args: Record<string, unknown>) => client.callTool({ name: 'image_generate', arguments: { model: 'image-one', prompt: 'fixture', width: 64, height: 64, wait: true, seed: 123, ...args } })
  const missing = await generate({ upscale: 4 })
  assert.equal(missing.isError, true)
  assert.match((missing.content as Array<{ text: string }>)[0]!.text, /\/imagesetup.*realesrgan/)
  assert.equal(existsSync(join(root, 'engine-calls.jsonl')), false)
  for (const row of upscalers) writeFileSync(join(root, 'models', row.slots.upscale_model!), 'map')
  const generated = await generate({ upscale: 4, downsize: 4, palette: 2 })
  assert.equal(generated.isError ?? false, false, JSON.stringify(generated))
  const result = JSON.parse((generated.content as Array<{ text: string }>)[0]!.text)
  assert.deepEqual([result.upscale, result.width, result.height], [4, 64, 64])
  assert.equal(result.upscaler, 'realesrgan-x4plus-anime-6b')
  const image = readFileSync(result.path)
  assert.deepEqual([image.readUInt32BE(16), image.readUInt32BE(20)], [64, 64])
  const calls = readFileSync(join(root, 'engine-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const request = calls.find(call => call.route === 'upscale').body
  const input = Buffer.from(request.image.split(',')[1], 'base64')
  assert.deepEqual([input.readUInt32BE(16), input.readUInt32BE(20), request.repeats], [16, 16, 1])
  assert.equal((await generate({ upscale: 3 })).isError, true)
  assert.deepEqual(await client.listTools(), tools)
  console.log('media upscalers: pinned pull rows, consent, default exclusion, SDK inputs, missing weights and post-render dimensions')
} finally {
  await client.close()
  await stopFixtureEngine()
  rmSync(proofHome, { recursive: true, force: true })
}
