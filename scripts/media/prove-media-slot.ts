import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Client, StdioClientTransport } from '../../src/services/mcp/sdk.ts'
import { mediaGenerationDetails, mediaGenerationKind } from '../../src/services/media/generation.js'
import { MEDIA_SERVER_NAME } from '../../src/services/media/settings.js'
import { catalogue, proofHome } from './fixture.ts'

const root = join(proofHome, 'storage')
const bundled = resolve(import.meta.dir, '../../src/extensions/bundled/mercury-media/server')
const client = new Client({ name: 'media-slot-proof', version: '1.0.0' })
try {
  const config = { imageModel: 'image-two', videoModel: 'video-one' }
  assert.match(mediaGenerationDetails('image', {}, catalogue, config, proofHome), /^image-two · default image\n1024×1024 · 4 steps/)
  assert.match(mediaGenerationDetails('image', { model: 'image-one', width: 512, height: 256, steps: 7 }, catalogue, config, proofHome), /^image-one\n512×256 · 7 steps/)
  assert.match(mediaGenerationDetails('video', {}, catalogue, config, proofHome), /^video-one · default video\n1280×704 · 20 steps/)
  assert.equal(mediaGenerationKind({ mcpInfo: { serverName: MEDIA_SERVER_NAME, toolName: 'image_generate' } }), 'image')
  assert.equal(mediaGenerationKind({ mcpInfo: { serverName: 'another-server', toolName: 'image_generate' } }), undefined)
  const reader = await import(pathToFileURL(join(bundled, 'config.js')).href)
  await reader.writeMediaConfig(root, { imageModel: 'flux2-klein-4b', videoModel: 'wan22-ti2v-5b' })
  await client.connect(new StdioClientTransport({ command: 'node', args: [join(bundled, 'server.js')], env: { ...process.env, MEDIA_ROOT: root } as Record<string, string>, stderr: 'pipe' }))
  const { tools } = await client.listTools()
  for (const name of ['image_generate', 'video_generate']) {
    const tool = tools.find(tool => tool.name === name)!
    assert.ok(tool)
    assert.match(tool.description ?? '', /omit model to use the default/i)
    assert.match(tool.description ?? '', /name a model only when the user asks for a specific one/i)
    assert.equal(tool.inputSchema.required?.includes('model') ?? false, false)
    assert.equal((tool.inputSchema.properties?.model as { default?: unknown })?.default, undefined)
  }
  const list = await client.callTool({ name: 'media_models', arguments: {} })
  assert.equal(list.isError ?? false, false)
  const listed = JSON.parse((list.content as Array<{ text: string }>)[0]!.text)
  assert.equal(listed.models.find((row: { model: string }) => row.model === 'flux2-klein-4b').default, true)
  const named = await client.callTool({ name: 'image_generate', arguments: { prompt: 'fixture', model: 'not-a-model' } })
  assert.equal(named.isError, true)
  assert.match(JSON.stringify(named), /Unknown model/)
  const omitted = await client.callTool({ name: 'image_generate', arguments: { prompt: 'fixture', reference_image: join(root, 'absent.png') } })
  assert.equal(omitted.isError, true)
  assert.doesNotMatch(JSON.stringify(omitted), /Unknown model|does not support reference/)
  const changed = await client.callTool({ name: 'media_set_default', arguments: { kind: 'image', model: 'z-image-turbo' } })
  assert.equal(changed.isError ?? false, false)
  assert.equal((await reader.readMediaConfig(root)).imageModel, 'z-image-turbo')
  const nonEditing = await client.callTool({ name: 'image_generate', arguments: { prompt: 'fixture', reference_image: join(root, 'absent.png') } })
  assert.match(JSON.stringify(nonEditing), /does not support reference/)
  const explicitEditing = await client.callTool({ name: 'image_generate', arguments: { prompt: 'fixture', model: 'flux2-klein-4b', reference_image: join(root, 'absent.png') } })
  assert.doesNotMatch(JSON.stringify(explicitEditing), /does not support reference/)
  const { connectToServer, fetchToolsForClient } = await import('../../src/services/mcp/client.ts')
  const connection = await connectToServer(MEDIA_SERVER_NAME, { type: 'stdio', command: 'node', args: [join(bundled, 'server.js')], env: { MEDIA_ROOT: root }, scope: 'dynamic' })
  assert.equal(connection.type, 'connected')
  if (connection.type === 'connected') {
    try {
      const discovered = await fetchToolsForClient(connection)
      const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
      const { decideToolPermission } = await import('../../src/utils/permissions/decision/engine.ts')
      const permission = getEmptyToolPermissionContext()
      const context: any = { abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: permission }), options: {} }
      for (const kind of ['image', 'video'] as const) {
        const tool = discovered.find(tool => mediaGenerationKind(tool) === kind)!
        assert.ok(tool)
        const { decision } = await decideToolPermission(tool, { prompt: 'fixture' }, context)
        assert.equal(decision.behavior, 'ask')
      }
    } finally { await connection.client.close() }
  }
  console.log('media slots: omitted uses slot; named overrides; descriptions; shared defaults; both generators ask through normal MCP permissions')
} finally { await client.close(); rmSync(proofHome, { recursive: true, force: true }) }
