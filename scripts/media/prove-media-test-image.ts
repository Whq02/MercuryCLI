import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { generateMediaTestImage } from '../../src/services/media/generation.js'
import { MEDIA_SERVER_NAME } from '../../src/services/media/settings.js'
import { proofHome } from './fixture.ts'

try {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jH3kAAAAASUVORK5CYII=', 'base64')
  let calls = 0
  let asks = 0
  let starts = 0
  const tool: any = { name: 'fixture', mcpInfo: { serverName: MEDIA_SERVER_NAME, toolName: 'image_generate' }, call: async (input: any) => {
    calls++
    assert.equal(input.model, 'image-one')
    assert.equal(input.width, 256)
    assert.equal(input.height, 256)
    assert.equal(input.wait, true)
    return { data: [{ type: 'text', text: JSON.stringify({ path: join(proofHome, 'test.png') }) }, { type: 'image', mimeType: 'image/png', data: png.toString('base64') }] }
  } }
  const context: any = { options: { tools: [tool] }, canUseTool: async () => { asks++; return { behavior: 'deny' } } }
  await assert.rejects(generateMediaTestImage('image-one', context, new AbortController()), /cancelled/)
  assert.equal(calls, 0)
  assert.equal(asks, 1)
  context.canUseTool = async () => { asks++; return { behavior: 'allow' } }
  const result = await generateMediaTestImage('image-one', context, new AbortController(), () => starts++)
  assert.equal(calls, 1)
  assert.equal(asks, 2)
  assert.equal(starts, 1)
  assert.ok(result.png.equals(png))
  assert.equal(result.path, join(proofHome, 'test.png'))
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(generateMediaTestImage('image-one', context, controller))
  assert.equal(calls, 1)
  console.log('media test image: permission denial prevents generation; allowed call returns inline PNG and path; cancellation prevents a call')
} finally { rmSync(proofHome, { recursive: true, force: true }) }
