import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client, StdioClientTransport } from '../../src/services/mcp/sdk.js'
import { mediaGenerationDetails } from '../../src/services/media/generation.js'
import { catalogue, installLiveFixture, proofHome, root, serverPath, stopFixtureEngine } from './fixture.ts'

const client = new Client({ name: 'media-image-input-proof', version: '1' })
try {
  const config = { imageModel: 'image-one', videoModel: 'video-one' }
  const input = { prompt: 'a blue dragon', reference_image: 'dragon.png', strength: 0.6, mask: 'mask.png' }
  assert.equal(mediaGenerationDetails('image', input, catalogue, config, proofHome), `image-one · default image\n1024×1024 · 9 steps\nOutput: ${join(proofHome, 'media')}\nReference: dragon.png · strength 0.6 · mask mask.png\nPrompt: a blue dragon`)
  assert.match(mediaGenerationDetails('image', { reference_image: 'dragon.png' }, catalogue, config, proofHome), /Reference: dragon.png · strength 0.75$/)
  assert.match(mediaGenerationDetails('image', { reference_image: 'dragon.png', strength: 0 }, catalogue, config, proofHome), /Reference: dragon.png · strength 0$/)
  assert.match(mediaGenerationDetails('video', { image: 'dragon.png' }, catalogue, config, proofHome), /Reference: dragon.png$/)
  assert.ok(!mediaGenerationDetails('image', {}, catalogue, config, proofHome).includes('Reference:'))
  installLiveFixture()
  mkdirSync(join(root, 'models'), { recursive: true })
  for (const file of catalogue.files) writeFileSync(join(root, 'models', file.path), Buffer.alloc(file.bytes))
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5r8AAAAASUVORK5CYII=', 'base64')
  writeFileSync(join(proofHome, 'dragon.png'), png)
  writeFileSync(join(proofHome, 'mask.png'), png)
  const transport = new StdioClientTransport({ command: 'node', args: [serverPath], cwd: proofHome, env: { PATH: process.env.PATH!, MEDIA_ROOT: root }, stderr: 'pipe' })
  await client.connect(transport)
  const tool = (await client.listTools()).tools.find(row => row.name === 'image_generate')!
  const schema = tool.inputSchema.properties as Record<string, { type?: string; minimum?: number; maximum?: number }>
  assert.deepEqual([schema.strength.minimum, schema.strength.maximum, schema.mask.type], [0, 1, 'string'])
  const call = (args: Record<string, unknown>) => client.callTool({ name: 'image_generate', arguments: { model: 'image-one', prompt: 'a blue dragon', width: 64, height: 64, wait: true, cwd: proofHome, ...args } })
  const invalid = await call({ reference_image: 'dragon.png', strength: 2 })
  assert.equal(invalid.isError, true)
  assert.ok(!existsSync(join(root, 'engine-calls.jsonl')))
  const result = await call(input)
  assert.equal(result.isError ?? false, false, JSON.stringify(result))
  const output = JSON.parse((result.content as Array<{ text: string }>)[0]!.text)
  assert.deepEqual([output.reference_image, output.strength, output.mask], [join(proofHome, 'dragon.png'), 0.6, join(proofHome, 'mask.png')])
  const calls = readFileSync(join(root, 'engine-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const body = calls.find(call => call.route === 'img_gen').body
  assert.deepEqual([body.init_image, body.strength, body.mask_image], [`data:image/png;base64,${png.toString('base64')}`, 0.6, `data:image/png;base64,${png.toString('base64')}`])
  assert.ok((result.content as Array<{ type: string }>).some(part => part.type === 'image'))
  assert.deepEqual(readFileSync(output.path), png)
  const roundTrip = await call({ reference_image: output.path })
  assert.equal(roundTrip.isError ?? false, false, JSON.stringify(roundTrip))
  assert.equal(JSON.parse((roundTrip.content as Array<{ text: string }>)[0]!.text).strength, 0.75)
  console.log('media image inputs: the existing Reference line carries strength and mask; the bundled MCP discovers and forwards both, refuses invalid strength before loading, and round-trips a PNG')
} finally {
  await client.close()
  await stopFixtureEngine()
  rmSync(proofHome, { recursive: true, force: true })
}
