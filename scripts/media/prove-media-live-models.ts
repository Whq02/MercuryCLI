import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Client, StdioClientTransport } from '../../src/services/mcp/sdk.js'
import { installLiveFixture, proofHome, root, serverPath, stopFixtureEngine } from './fixture.ts'
import type { LocalJSXCommandContext } from '../../src/types/command.js'

process.chdir(proofHome)
Object.assign(globalThis, { MACRO: { VERSION: '1.0.0', IS_DEV: false } })
const { setCwdState, setOriginalCwd, setProjectRoot } = await import('../../src/bootstrap/state.js')
setCwdState(proofHome)
setOriginalCwd(proofHome)
setProjectRoot(proofHome)
const { updateSettingsForSource } = await import('../../src/utils/settings/settings.js')
const { imageSetupIo } = await import('../../src/commands/imagesetup/imagesetup.js')
const { mediaPullPlan, pullMedia } = await import('../../src/services/media/setup.js')
const { mediaConfigModule } = await import('../../src/services/media/settings.js')
const io = imageSetupIo({ setAppState: () => { throw new Error('An already-enabled model install must not reconnect') } } as unknown as LocalJSXCommandContext)
const client = new Client({ name: 'media-live-models-proof', version: '1.0.0' })
const transport = new StdioClientTransport({ command: 'node', args: [serverPath], cwd: proofHome, env: { ...process.env, MEDIA_ROOT: root } as Record<string, string>, stderr: 'pipe' })
const readModels = async (): Promise<Array<{ model: string; installed: boolean; default: boolean }>> => {
  const result = await client.callTool({ name: 'media_models', arguments: {} })
  assert.equal(result.isError ?? false, false, JSON.stringify(result))
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text).models
}
try {
  installLiveFixture()
  assert.equal(updateSettingsForSource('userSettings', { media: { root, serverPath, enabled: true } }).error, null)
  const config = await mediaConfigModule()
  await config.writeMediaConfig(root, { imageModel: 'image-one', outputs: join(root, 'outputs') })
  await client.connect(transport)
  const pid = transport.pid
  assert.ok(pid)
  const tools = await client.listTools()
  assert.equal((await readModels()).find(model => model.model === 'image-one')!.installed, false)
  for (const id of ['image-one', 'image-two']) {
    const plan = mediaPullPlan(await io.read(), id)
    assert.equal(await pullMedia(plan, async () => true, io.pull, () => {}), true)
    assert.equal((await readModels()).find(model => model.model === id)!.installed, true, `${id} is visible on the next call`)
    assert.equal(transport.pid, pid)
  }
  assert.equal(existsSync(join(root, 'engine-calls.jsonl')), false)
  const generate = async (model?: string): Promise<string> => {
    const result = await client.callTool({ name: 'image_generate', arguments: { prompt: 'fixture', width: 64, height: 64, wait: true, ...(model ? { model } : {}) } })
    assert.equal(result.isError ?? false, false, JSON.stringify(result))
    const data = JSON.parse((result.content as Array<{ text: string }>)[0]!.text)
    assert.equal(data.status, 'completed')
    assert.ok(existsSync(data.path))
    assert.ok((result.content as Array<{ type: string }>).some(part => part.type === 'image'))
    assert.equal(transport.pid, pid)
    return data.model
  }
  assert.equal(await generate(), 'image-one')
  assert.equal(await generate('image-two'), 'image-two')
  assert.equal((await config.readMediaConfig(root)).imageModel, 'image-one')
  await io.setDefault('image', 'image-two')
  assert.equal((await readModels()).find(model => model.model === 'image-two')!.default, true)
  assert.equal(await generate(), 'image-two')
  assert.equal(await generate('image-one'), 'image-one')
  assert.equal((await config.readMediaConfig(root)).imageModel, 'image-two')
  assert.deepEqual(await client.listTools(), tools)
  const calls = readFileSync(join(root, 'engine-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(calls.filter(call => call.route === 'img_gen').length, 4)
  assert.deepEqual(calls.filter(call => call.route === 'models/load').map(call => call.body.models.diffusion_model), ['image.gguf', 'other.gguf', 'image.gguf'])
  console.log('media live models: next call sees each installed model; omitted uses slot, named overrides without saving; setup default change applies on the same MCP client; four fixture PNGs')
} finally {
  await client.close()
  await stopFixtureEngine()
  rmSync(proofHome, { recursive: true, force: true })
}
