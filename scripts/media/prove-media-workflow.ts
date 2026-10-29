import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { Client, StdioClientTransport } from '../../src/services/mcp/sdk.js'
import { installLiveFixture, proofHome, root, serverPath, stopFixtureEngine } from './fixture.ts'

process.chdir(proofHome)
Object.assign(globalThis, { MACRO: { VERSION: '1.0.0', IS_DEV: false } })
const { setCwdState, setOriginalCwd, setProjectRoot } = await import('../../src/bootstrap/state.js')
setCwdState(proofHome)
setOriginalCwd(proofHome)
setProjectRoot(proofHome)
const { updateSettingsForSource } = await import('../../src/utils/settings/settings.js')
const { readMediaCatalogue } = await import('../../src/services/media/catalogue.js')
const { readMediaGenerationDetails, readMediaWorkflowRequest } = await import('../../src/services/media/generation.js')

function png(width: number, height: number, channels: number, paint: (x: number, y: number) => number[]): Buffer {
  const raw = Buffer.alloc((width * channels + 1) * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set(paint(x, y), y * (width * channels + 1) + 1 + x * channels)
  const chunk = (type: string, data: Buffer) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(type, 4, 'latin1'); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(data, crc32(head.subarray(4)))); return Buffer.concat([head, data, crc]) }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = channels === 4 ? 6 : 2
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
function safetensors(tensors: Record<string, number[]>): Buffer {
  const header: Record<string, unknown> = {}
  let offset = 0
  for (const [name, shape] of Object.entries(tensors)) { const bytes = shape.reduce((n, d) => n * d, 1) * 2; header[name] = { dtype: 'F16', shape, data_offsets: [offset, offset + bytes] }; offset += bytes }
  const json = Buffer.from(JSON.stringify(header)); const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(json.length))
  return Buffer.concat([length, json, Buffer.alloc(offset)])
}
const inside = (x: number, y: number) => x >= 24 && x < 40 && y >= 24 && y < 40
const client = new Client({ name: 'media-workflow-proof', version: '1.0.0' })
try {
  installLiveFixture()
  const dir = join(proofHome, 'workflows')
  cpSync(new URL('./fixtures/workflows/', import.meta.url), dir, { recursive: true })
  writeFileSync(join(dir, 'style.safetensors'), safetensors({ 'lora_unet_input_blocks_1_1_transformer_blocks_0_attn2_to_k.lora_down.weight': [1, 768], 'lora_unet_input_blocks_1_1_transformer_blocks_0_attn2_to_k.lora_up.weight': [1, 1] }))
  writeFileSync(join(dir, 'easynegative.safetensors'), safetensors({ emb_params: [2, 768] }))
  writeFileSync(join(dir, 'sketch.png'), png(64, 64, 3, (x, y) => [x * 4, y * 4, 128]))
  writeFileSync(join(dir, 'depth.png'), png(64, 64, 3, (x, y) => [x * 4, y * 4, 128]))
  writeFileSync(join(dir, 'wall.png'), png(64, 64, 4, (x, y) => [200, 100, 50, inside(x, y) ? 0 : 255]))
  writeFileSync(join(dir, 'paint.png'), png(64, 64, 3, (x, y) => [inside(x, y) ? 255 : 0, 0, 0]))
  const local = JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8'))
  local.models[0].recipe = 'sd1-checkpoint'
  local.models[0].slots = { model: 'image.gguf' }
  local.files[0].origin = '/elsewhere/fixture.safetensors'
  for (const kind of ['canny', 'depth']) {
    local.models.push({ id: `controlnet-sd1-${kind}`, kind: 'image', recipe: 'sd1-controlnet', license: 'Fixture', control: { family: 'sd1', kind }, steps: 2, multiple: 64, slots: { control_net: `sd1-${kind}.gguf` } })
    local.files.push({ path: `sd1-${kind}.gguf`, bytes: 3 })
  }
  const bundled = JSON.parse(readFileSync(join(dirname(serverPath), 'catalog.json'), 'utf8'))
  const upscalers = bundled.models.filter((row: { upscaler?: unknown }) => row.upscaler)
  for (const row of upscalers) local.files.push({ path: row.slots.upscale_model, bytes: 3, sha256: createHash('sha256').update('map').digest('hex') })
  writeFileSync(join(root, 'catalog.json'), JSON.stringify(local))
  mkdirSync(join(root, 'models/upscalers'), { recursive: true })
  writeFileSync(join(root, 'models/image.gguf'), Buffer.alloc(8))
  for (const kind of ['canny', 'depth']) writeFileSync(join(root, `models/sd1-${kind}.gguf`), 'map')
  for (const row of upscalers) writeFileSync(join(root, 'models', row.slots.upscale_model), 'map')
  assert.equal(updateSettingsForSource('userSettings', { media: { root, serverPath, enabled: true } }).error, null)
  const catalogue = await readMediaCatalogue({ root, serverPath })
  const request = await readMediaWorkflowRequest({ workflow: 'workflows/txt2img-ui.json', dry: true, seed: 7 }, catalogue, proofHome)
  assert.deepEqual(request, {
    model: 'image-one', prompt: 'a lighthouse on a cliff at dusk, (detailed:1.1)', negative_prompt: 'easynegative, blurry', width: 512, height: 448, seed: 7, steps: 20, cfg: 7, sampler: 'dpm++2m', scheduler: 'karras', clip_skip: 2,
    loras: [{ path: join(dir, 'style.safetensors'), weight: 0.8 }], embeddings: [{ path: join(dir, 'easynegative.safetensors'), token: 'easynegative' }],
    control: { image: join(dir, 'sketch.png'), kind: 'canny', strength: 0.75 }, upscaler: 'realesrgan-x4plus', upscale: 4, workflow: join(dir, 'txt2img-ui.json'), dry: true
  })
  const card = await readMediaGenerationDetails('image', { workflow: join(dir, 'txt2img-ui.json'), dry: true }, proofHome)
  assert.deepEqual(card.split('\n'), ['image-one', '512×448 · 20 steps · saved at 2048×1792', `Output: ${join(proofHome, 'media')}`, `Workflow: ${join(dir, 'txt2img-ui.json')} · dry run`, 'Prompt: a lighthouse on a cliff at dusk, (detailed:1.1)'])
  const inpaintCard = await readMediaGenerationDetails('image', { workflow: join(dir, 'inpaint-api.json'), cwd: dir }, proofHome)
  assert.deepEqual(inpaintCard.split('\n'), ['image-one', '64×64 · 12 steps', `Output: ${join(dir, 'media')}`, `Workflow: ${join(dir, 'inpaint-api.json')}`, `Reference: ${join(dir, 'wall.png')} · strength 1 · mask ${join(dir, 'wall.png')}`, 'Prompt: a red door'])
  await assert.rejects(readMediaGenerationDetails('image', { workflow: join(dir, 'unsupported-api.json') }, proofHome), (error: Error) => /node 40 \(FaceDetailer\) is not supported by the local runtime/.test(error.message) && /node 30 \(VAELoader\)/.test(error.message) && /sampler dpmpp_3m_sde/.test(error.message))
  assert.equal(await readMediaGenerationDetails('image', { prompt: 'plain', model: 'image-one' }, proofHome), `image-one\n1024×1024 · 9 steps\nOutput: ${join(proofHome, 'media')}\nPrompt: plain`)
  await client.connect(new StdioClientTransport({ command: 'node', args: [serverPath], cwd: proofHome, env: { ...process.env, MEDIA_ROOT: root, MEDIA_OUTPUT_DIR: join(root, 'outputs') } as Record<string, string>, stderr: 'pipe' }))
  const tools = await client.listTools()
  const schema = tools.tools.find(tool => tool.name === 'image_generate')!.inputSchema
  for (const key of ['workflow', 'dry', 'export_workflow', 'cfg', 'clip_skip']) assert.ok(schema.properties?.[key], key)
  assert.ok(!(schema.required as string[] | undefined)?.includes('prompt'))
  const generate = (args: Record<string, unknown>) => client.callTool({ name: 'image_generate', arguments: { wait: true, cwd: proofHome, ...args } })
  const text = (result: Awaited<ReturnType<typeof generate>>) => (result.content as Array<{ text: string }>)[0]!.text
  const refused = await generate({ workflow: join(dir, 'unsupported-api.json') })
  assert.equal(refused.isError, true)
  assert.match(text(refused), /node 40 \(FaceDetailer\)[\s\S]*node 30 \(VAELoader\)/)
  assert.equal(existsSync(join(root, 'engine-calls.jsonl')), false)
  const dry = await generate({ workflow: join(dir, 'txt2img-ui.json'), dry: true })
  assert.equal(dry.isError ?? false, false, JSON.stringify(dry))
  const planned = JSON.parse(text(dry))
  assert.equal(planned.dry, true)
  const { workflow: _workflow, dry: _dry, ...expected } = request
  assert.deepEqual(planned.request, { ...expected, seed: 123456789 })
  assert.deepEqual(planned.workflow.mapping.map((entry: { node: string }) => entry.node), ['3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '15', '16', '17', '18', '19'])
  assert.deepEqual(planned.workflow.skipped, [{ node: '21', type: 'Note', note: 'an annotation' }])
  assert.equal(existsSync(join(root, 'engine-calls.jsonl')), false)
  const exported = join(dir, 'inpaint.export.json')
  const generated = await generate({ workflow: join(dir, 'inpaint-api.json'), export_workflow: exported })
  assert.equal(generated.isError ?? false, false, JSON.stringify(generated))
  const result = JSON.parse(text(generated))
  assert.equal(result.status, 'completed')
  assert.deepEqual([result.width, result.height, result.seed, result.steps, result.cfg, result.strength, result.reference_image, result.control.kind, result.loras[0].weight, result.export], [64, 64, 7, 12, 5.5, 1, join(dir, 'wall.png'), 'depth', 0.6, exported])
  assert.match(result.mask, /run\/workflow-masks\/[a-f0-9]{64}\.png$/)
  assert.equal(result.workflow.format, 'api')
  assert.equal(result.workflow.mapping.find((entry: { node: string }) => entry.node === '14').note, 'the mask is the transparent area of wall.png, grown by 6 pixels')
  assert.ok((generated.content as Array<{ type: string }>).some(part => part.type === 'image'))
  const calls = readFileSync(join(root, 'engine-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const render = calls.find(call => call.route === 'img_gen').body
  assert.deepEqual([render.width, render.height, render.seed, render.strength, render.control_strength, render.lora.length, render.lora[0].multiplier], [64, 64, 7, 1, 0.5, 1, 0.6])
  assert.deepEqual(render.sample_params, { sample_steps: 12, sample_method: 'euler_a', scheduler: 'discrete', guidance: { txt_cfg: 5.5 }, custom_sigmas: [] })
  assert.match(render.init_image, /^data:image\/png;base64,/)
  assert.match(render.mask_image, /^data:image\/png;base64,/)
  assert.equal(calls.find(call => call.route === 'models/load').body.models.control_net, 'sd1-depth.gguf')
  const again = await generate({ workflow: exported, dry: true })
  assert.equal(again.isError ?? false, false, JSON.stringify(again))
  const reimported = JSON.parse(text(again))
  const first = await generate({ workflow: join(dir, 'inpaint-api.json'), dry: true })
  assert.deepEqual(reimported.request, JSON.parse(text(first)).request)
  assert.deepEqual(Object.values(JSON.parse(readFileSync(exported, 'utf8'))).map((node: any) => node.class_type), ['CheckpointLoaderSimple', 'LoraLoader', 'CLIPTextEncode', 'CLIPTextEncode', 'LoadImage', 'VAEEncode', 'LoadImageMask', 'SetLatentNoiseMask', 'ControlNetLoader', 'LoadImage', 'ControlNetApplyAdvanced', 'KSampler', 'VAEDecode', 'SaveImage'])
  assert.deepEqual(await client.listTools(), tools)
  console.log('media ComfyUI workflows: UI and API exports map onto one request; the card names the workflow, model, size, reference and prompt; refusals list every unsupported node; dry mode starts no engine; a real render carries the mask, LoRA, ControlNet and sampling through the bundled engine; the export imports back to the same request')
} finally {
  await client.close()
  await stopFixtureEngine()
  rmSync(proofHome, { recursive: true, force: true })
}
