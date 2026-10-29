import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Client, StdioClientTransport } from '../../src/services/mcp/sdk.js'
import { mediaCheckpointFile, mediaModelJoined, parseMediaCatalogue } from '../../src/services/media/catalogue.js'
import { mediaPullPlan, mediaRows, type MediaSnapshot } from '../../src/services/media/setup.js'
import { installLiveFixture, proofHome, root, serverPath, stopFixtureEngine } from './fixture.ts'

process.chdir(proofHome)
Object.assign(globalThis, { MACRO: { VERSION: '1.0.0', IS_DEV: false } })
const { setCwdState, setOriginalCwd, setProjectRoot } = await import('../../src/bootstrap/state.js')
setCwdState(proofHome)
setOriginalCwd(proofHome)
setProjectRoot(proofHome)
const { updateSettingsForSource } = await import('../../src/utils/settings/settings.js')
const { saveMediaSettings } = await import('../../src/services/media/settings.js')
const client = new Client({ name: 'media-controlnet-proof', version: '1.0.0' })
try {
  installLiveFixture()
  const bundled = parseMediaCatalogue(JSON.parse(readFileSync(join(dirname(serverPath), 'catalog.json'), 'utf8')))
  const controls = bundled.models.filter(model => model.control)
  assert.equal(controls.length, 6)
  const machine = { totalMemoryBytes: 64 * 1024 ** 3, usableMemoryBytes: 48 * 1024 ** 3 }
  const rows = mediaRows(bundled, root, machine, 64 * 1024 ** 3)
  const snapshot: MediaSnapshot = { root, catalogue: bundled, rows, config: {}, runtimeInstalled: true, freeBytes: 64 * 1024 ** 3, ...machine }
  for (const model of controls) {
    const plan = mediaPullPlan(snapshot, model.id)
    assert.deepEqual(plan.args, ['pull-model', model.id])
    assert.ok(plan.bytes > 700_000_000)
    assert.equal(plan.license, model.license)
    assert.match(plan.source, /huggingface.co\//)
    assert.equal(mediaModelJoined(bundled, model), true)
    assert.equal(mediaCheckpointFile(model).path, `controlnet/${model.id}.safetensors`)
  }
  const local = JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8'))
  local.models[0].recipe = 'sd1-checkpoint'
  local.models[0].slots = { model: 'image.gguf' }
  local.models.push({ id: 'controlnet-sd1-canny', kind: 'image', recipe: 'sd1-controlnet', license: 'Fixture', control: { family: 'sd1', kind: 'canny' }, steps: 2, multiple: 64, slots: { control_net: 'control.gguf' } })
  local.files.push({ path: 'control.gguf', bytes: 3 })
  writeFileSync(join(root, 'catalog.json'), JSON.stringify(local))
  mkdirSync(join(root, 'models'), { recursive: true })
  writeFileSync(join(root, 'models/image.gguf'), Buffer.alloc(8))
  const image = join(root, 'drawing.png')
  writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5r8AAAAASUVORK5CYII=', 'base64'))
  assert.equal(updateSettingsForSource('userSettings', { media: { root, serverPath, enabled: true } }).error, null)
  await assert.rejects(saveMediaSettings({ imageModel: 'controlnet-sd1-canny' }), /Choose a image model/)
  const transport = new StdioClientTransport({ command: 'node', args: [serverPath], cwd: proofHome, env: { ...process.env, MEDIA_ROOT: root, MEDIA_OUTPUT_DIR: join(root, 'outputs') } as Record<string, string>, stderr: 'pipe' })
  await client.connect(transport)
  const tools = await client.listTools()
  const schema = tools.tools.find(tool => tool.name === 'image_generate')!.inputSchema
  for (const key of ['control', 'count', 'sheet', 'palette']) assert.ok(schema.properties?.[key], key)
  const generate = (args: Record<string, unknown>) => client.callTool({ name: 'image_generate', arguments: { model: 'image-one', prompt: 'fixture', width: 64, height: 64, wait: true, seed: 123, ...args } })
  const missing = await generate({ control: { image, kind: 'canny' } })
  assert.equal(missing.isError, true)
  assert.match((missing.content as Array<{ text: string }>)[0]!.text, /controlnet-sd1-canny/)
  assert.equal(existsSync(join(root, 'engine-calls.jsonl')), false)
  writeFileSync(join(root, 'models/control.gguf'), 'map')
  const generated = await generate({ control: { image, kind: 'canny', strength: 0.75 }, count: 4, sheet: { columns: 2 }, palette: 2 })
  assert.equal(generated.isError ?? false, false, JSON.stringify(generated))
  const result = JSON.parse((generated.content as Array<{ text: string }>)[0]!.text)
  assert.equal(result.status, 'completed')
  assert.equal(result.count, 4)
  assert.deepEqual(result.seeds, [123, 124, 125, 126])
  assert.equal(result.control.model, 'controlnet-sd1-canny')
  assert.equal(result.images.length, 4)
  assert.ok(result.images.every((frame: { path: string; seed: number }, index: number) => existsSync(frame.path) && frame.seed === 123 + index))
  const sheet = readFileSync(result.path)
  assert.equal(sheet.readUInt32BE(16), 2)
  assert.equal(sheet.readUInt32BE(20), 2)
  assert.ok(sheet.includes(Buffer.from('mercury.seeds\0[123,124,125,126]')))
  assert.ok((generated.content as Array<{ type: string }>).some(part => part.type === 'image'))
  const calls = readFileSync(join(root, 'engine-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const renderCalls = calls.filter(call => call.route === 'img_gen')
  assert.deepEqual(renderCalls.map(call => call.body.seed), [123, 124, 125, 126])
  assert.ok(renderCalls.every(call => call.body.control_strength === 0.75 && call.body.batch_count === 1))
  assert.equal(calls.find(call => call.route === 'models/load').body.models.control_net, 'control.gguf')
  assert.equal((await generate({ palette: 257 })).isError, true)
  assert.equal((await generate({ count: 2, sheet: { columns: 3 } })).isError, true)
  assert.deepEqual(await client.listTools(), tools)
  console.log('media ControlNet: six pinned pull rows; controls cannot become image defaults; missing row refusal; discovered inputs reach the bundled engine; four sequential seeds, palette and PNG sheet')
} finally {
  await client.close()
  await stopFixtureEngine()
  rmSync(proofHome, { recursive: true, force: true })
}
