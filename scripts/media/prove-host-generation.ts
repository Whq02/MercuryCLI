import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Client, StdioClientTransport } from '../../src/services/mcp/sdk.js'
import { catalogue, installLiveFixture, proofHome, root, serverPath, stopFixtureEngine } from './fixture.ts'
import { mediaHostStatePath, connectMediaHost } from '../../src/services/media/host.js'
import { writeHostRecord } from '../../src/services/host/store.js'
import { mediaConfigModule, mediaRoot } from '../../src/services/media/settings.js'
import { hostIdleVerdict, HOST_IDLE_LIMIT_MS } from '../../src/services/host/idle.js'

const client = new Client({ name: 'media-host-proof', version: '1' })
let gateway: { port: number; close(): Promise<void> } | undefined
try {
  installLiveFixture()
  mkdirSync(join(root, 'models'), { recursive: true })
  for (const file of catalogue.files) writeFileSync(join(root, 'models', file.path), Buffer.alloc(file.bytes))
  process.env.MEDIA_ROOT = root
  const module = await import(pathToFileURL(join(dirname(serverPath), 'remote-server.js')).href) as { startRemoteServer(options: { root: string; token: string }): Promise<NonNullable<typeof gateway>> }
  const token = 'a'.repeat(64)
  gateway = await module.startRemoteServer({ root, token })
  const now = Date.now()
  const record = { id: 'fixture-rental', name: 'fixture GPU', recipe: 'fixture', price: 1, startedAt: new Date(now - 3 * HOST_IDLE_LIMIT_MS).toISOString(), advancedAt: now - 3 * HOST_IDLE_LIMIT_MS, status: 'RUNNING', jobState: 'ready' as const, target: { host: 'gpu.example' } }
  writeHostRecord(record)
  const state = mediaHostStatePath(record.id)
  mkdirSync(dirname(state), { recursive: true })
  writeFileSync(state, JSON.stringify({ id: record.id, name: 'Runpod pod fixture-rental', token, port: 30080, url: `http://127.0.0.1:${gateway.port}` }))
  assert.equal((await connectMediaHost(record.id, new AbortController().signal)).url, `http://127.0.0.1:${gateway.port}`)
  const localRoot = join(proofHome, 'client')
  const project = join(proofHome, 'project')
  mkdirSync(project)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5r8AAAAASUVORK5CYII=', 'base64')
  writeFileSync(join(project, 'reference.png'), png)
  await client.connect(new StdioClientTransport({ command: 'node', args: [join(dirname(serverPath), 'remote-client.js')], cwd: project, env: { PATH: process.env.PATH!, MEDIA_ROOT: localRoot, MEDIA_REMOTE_STATE: state, MEDIA_REMOTE_ACTIVITY: join(dirname(state), 'activity.json') }, stderr: 'pipe' }))
  const tools = (await client.listTools()).tools
  assert.ok(tools.some(row => row.name === 'image_generate'))
  assert.ok(tools.some(row => row.name === 'video_generate'))
  const result = await client.callTool({ name: 'image_generate', arguments: { model: 'image-one', prompt: 'fixture', reference_image: 'reference.png', mask: 'reference.png', width: 64, height: 64, wait: true, cwd: project } })
  assert.equal(result.isError ?? false, false, JSON.stringify(result))
  const output = result.structuredContent as { path: string; remote: string; jobId: string }
  assert.ok(output.path.startsWith(join(project, 'media')))
  assert.equal(output.remote, 'Runpod pod fixture-rental')
  assert.deepEqual(readFileSync(output.path), png)
  assert.ok((result.content as Array<{ type: string }>).some(part => part.type === 'image'))
  assert.equal(hostIdleVerdict(record, Date.now(), { lastTurnAt: () => undefined }), undefined)
  const retrieved = await client.callTool({ name: 'media_result', arguments: { job_id: output.jobId } })
  assert.equal((retrieved.structuredContent as { path: string }).path, output.path)
  await client.callTool({ name: 'media_set_default', arguments: { kind: 'image', model: 'image-two' } })
  const settings = { root, serverPath, host: record.id }
  const config = await mediaConfigModule(settings)
  assert.equal((await config.readMediaConfig(mediaRoot(settings))).imageModel, 'image-two')
  await config.writeMediaConfig(mediaRoot(settings), { imageModel: 'image-one' })
  assert.equal((await config.readMediaConfig(mediaRoot(settings))).imageModel, 'image-one')
  writeHostRecord({ ...record, status: 'EXITED', jobState: 'stopped' })
  await assert.rejects(connectMediaHost(record.id, new AbortController().signal), /Stopped · compute ended; disk storage still bills until Terminate\./)
  await gateway.close()
  gateway = undefined
  const failed = await client.callTool({ name: 'media_status', arguments: {} })
  assert.equal(failed.isError, true)
  assert.match((failed.content as Array<{ text: string }>)[0]!.text, /The SSH tunnel did not answer on local port/)
  console.log('media host generation: fixture behind loopback tunnel, tool discovery, image and mask uploads, local result and repeat retrieval, activity and stopped/lost-host words')
} finally {
  await client.close()
  await gateway?.close()
  await stopFixtureEngine()
  delete process.env.MEDIA_ROOT
  rmSync(proofHome, { recursive: true, force: true })
}
