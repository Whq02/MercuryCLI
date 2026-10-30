import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { installLiveFixture, proofHome, root, serverPath, stopFixtureEngine } from './fixture.ts'

const arg = (name: string): string | undefined => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const project = join(proofHome, 'project')
const originalCwd = process.cwd()
const forwarded: Array<{ name: string; arguments: Record<string, unknown> }> = []
let gateway: { port: number; close(): Promise<void> } | undefined
let proxy: Server | undefined
let close = async (): Promise<void> => {}

try {
  installLiveFixture({ sizedImages: true })
  const engine = arg('--engine')
  if (engine) cpSync(resolve(engine), dirname(serverPath), { recursive: true })
  const local = JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8'))
  local.models[0].recipe = 'sd1-checkpoint'
  local.models[0].slots = { model: 'image.gguf' }
  writeFileSync(join(root, 'catalog.json'), JSON.stringify(local))
  mkdirSync(join(root, 'models'), { recursive: true })
  writeFileSync(join(root, 'models/image.gguf'), Buffer.alloc(8))
  writeFileSync(join(root, 'config.json'), JSON.stringify({ imageModel: 'image-one', videoModel: 'video-one' }))
  mkdirSync(project)
  writeFileSync(join(project, 'reference.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5r8AAAAASUVORK5CYII=', 'base64'))
  const document = { version: 1, name: 'Remote landscape', steps: [
    { id: 'source', kind: 'file', inputs: { path: 'reference.png' } },
    { id: 'draw', kind: 'edit', inputs: { prompt: 'a landscape', reference_image: { step: 'source', output: 'image' }, seed: 7, width: 64, height: 64 } },
    { id: 'small', kind: 'downsize', inputs: { image: { step: 'draw', output: 'image' }, factor: 2 } },
    { id: 'save', kind: 'output', inputs: { image: { step: 'small', output: 'image' } } },
  ] }
  const path = join(project, 'landscape.pipeline.json')
  writeFileSync(path, JSON.stringify(document))
  process.env.MEDIA_ROOT = root
  const module = await import(pathToFileURL(join(dirname(serverPath), 'remote-server.js')).href) as { startRemoteServer(options: { root: string; token: string }): Promise<NonNullable<typeof gateway>> }
  const token = 'a'.repeat(64)
  gateway = await module.startRemoteServer({ root, token })
  const upstream = `http://127.0.0.1:${gateway.port}`
  proxy = createServer((req, res) => { void (async () => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks)
    if (req.url === '/mcp' && body.length) {
      const message = JSON.parse(body.toString()) as { method?: string; params?: { name: string; arguments: Record<string, unknown> } }
      if (message.method === 'tools/call' && message.params) forwarded.push(message.params)
    }
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(req.headers)) if (!['host', 'connection', 'content-length', 'transfer-encoding'].includes(key) && typeof value === 'string') headers[key] = value
    const response = await new Promise<IncomingMessage>((done, reject) => {
      const request = httpRequest(upstream + req.url, { method: req.method, headers: { ...headers, 'content-length': String(body.length) } }, done)
      request.once('error', reject); request.end(body)
    })
    res.writeHead(response.statusCode!, response.headers)
    await pipeline(response, res)
  })().catch(error => { res.destroy(error as Error) }) })
  await new Promise<void>(done => proxy!.listen(0, '127.0.0.1', done))
  const address = proxy.address()
  assert.ok(address && typeof address === 'object')
  const id = 'pipeline-fixture'
  Object.assign(globalThis, { MACRO: { VERSION: '1.0.0', IS_DEV: false } })
  process.chdir(project)
  const { setCwdState, setOriginalCwd, setProjectRoot } = await import('../../src/bootstrap/state.js')
  setCwdState(project); setOriginalCwd(project); setProjectRoot(project)
  const { writeHostRecord } = await import('../../src/services/host/store.js')
  const record = { id, name: 'fixture GPU', recipe: 'fixture', price: 1, startedAt: new Date().toISOString(), status: 'RUNNING', jobState: 'ready' as const, target: { host: 'gpu.example' } }
  writeHostRecord(record)
  const { mediaHostStatePath, readMediaHostSnapshot } = await import('../../src/services/media/host.js')
  const state = mediaHostStatePath(id)
  mkdirSync(dirname(state), { recursive: true })
  writeFileSync(state, JSON.stringify({ id, name: 'Runpod pod pipeline-fixture', token, port: 30080, url: `http://127.0.0.1:${address.port}` }))
  const settings = { enabled: true, root: join(proofHome, 'client'), serverPath, host: id }
  const { updateSettingsForSource } = await import('../../src/utils/settings/settings.js')
  assert.equal(updateSettingsForSource('userSettings', { media: settings }).error, null)
  const { computeActiveSet, publishActiveSet } = await import('../../src/extensions/active.js')
  const { clearExtensionMcpServerCache, getExtensionMcpServers } = await import('../../src/extensions/load/servers.js')
  publishActiveSet(computeActiveSet({ cwd: project, sessionPaths: [] })); clearExtensionMcpServerCache()
  const server = 'ext:mercury-media:engine'
  const config = getExtensionMcpServers()[server]
  assert.ok(config && config.type === 'stdio')
  assert.equal(config.args?.[0], join(dirname(serverPath), 'remote-client.js'))
  assert.equal(config.env?.MEDIA_REMOTE_ID, id)
  const { connectToServer, fetchToolsForClient } = await import('../../src/services/mcp/client.js')
  const connection = await connectToServer(server, config)
  assert.equal(connection.type, 'connected', JSON.stringify(connection))
  if (connection.type !== 'connected') throw new Error('Fixture media connection failed')
  close = () => connection.client.close()
  const tools = await fetchToolsForClient(connection)
  for (const name of ['pipeline_validate', 'pipeline_describe', 'pipeline_run', 'pipeline_import_workflow', 'pipeline_export_workflow']) assert.ok(tools.some(tool => tool.mcpInfo?.toolName === name), name)
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
  const { createAssistantMessage } = await import('../../src/utils/messages/factories.js')
  const { decideToolPermission } = await import('../../src/utils/permissions/decision/engine.js')
  const permission = getEmptyToolPermissionContext()
  const context: any = { abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: permission }), setAppState: () => {}, options: {} }
  const runTool = tools.find(tool => tool.mcpInfo?.toolName === 'pipeline_run')!
  assert.equal((await decideToolPermission(runTool, { pipeline: path }, context)).decision.behavior, 'ask')
  let serial = 0
  const call = async (name: string, input: Record<string, unknown> = {}) => {
    const tool = tools.find(tool => tool.mcpInfo?.toolName === name)!
    const id = `remote-pipeline-${++serial}`
    const message = createAssistantMessage({ content: [{ type: 'tool_use', id, name: tool.name, input }], isVirtual: true })
    const result = (await tool.call(input, { ...context, toolUseId: id }, async () => ({ behavior: 'allow', updatedInput: input }), message)).data
    const content = (typeof result === 'string' ? [{ type: 'text', text: result }] : result) as Array<{ type: string; text?: string }>
    return { content, data: JSON.parse(content.find(part => part.type === 'text')!.text!) as any }
  }
  const valid = (await call('pipeline_validate', { pipeline: 'landscape.pipeline.json' })).data
  assert.equal(valid.valid, true)
  assert.ok(forwarded.length)
  assert.ok(!JSON.stringify(forwarded).includes(project), 'Pipeline forwarded local paths or cwd to the host')
  const described = (await call('pipeline_describe', { pipeline: path })).data
  assert.equal(described.pipelineHash, valid.pipelineHash)
  const inventory = await call('pipeline_describe')
  assert.deepEqual(JSON.parse(inventory.content.at(-1)!.text!).pipelines, [path])
  const dry = (await call('pipeline_run', { pipeline: path, dry: true })).data
  assert.equal(dry.dry, true)
  assert.deepEqual(readdirSync(join(root, 'remote-inputs')), [])
  assert.equal(existsSync(join(project, 'media')), false)
  assert.equal(existsSync(join(root, 'engine-calls.jsonl')), false)
  const queued = (await call('pipeline_run', { pipeline: path })).data
  const result = (await call('media_result', { job_id: queued.jobId, timeout: 30 })).data
  assert.equal(result.remote, 'Runpod pod pipeline-fixture')
  assert.equal(result.recordPath, queued.pipeline.recordPath)
  const { readMediaPipelineRunRecord, readMediaPipelineDetails } = await import('../../src/services/media/pipeline.js')
  const run = await readMediaPipelineRunRecord(result.recordPath, project)
  assert.equal(run.remote, result.remote)
  assert.deepEqual(run.document, document)
  assert.deepEqual(run.steps, result.steps)
  assert.equal(run.pipeline.path, path)
  assert.equal(run.pipelineHash, valid.pipelineHash)
  for (const row of run.steps) for (const file of row.files ?? []) {
    assert.ok(file.path.startsWith(join(project, 'media') + '/'))
    assert.equal(createHash('sha256').update(readFileSync(file.path)).digest('hex'), file.sha256)
  }
  assert.equal(readFileSync(result.path).readUInt32BE(16), 32)
  const calls = () => readFileSync(join(root, 'engine-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.route === 'img_gen')
  assert.equal(calls().length, 1)
  const rerun = (await call('pipeline_run', { pipeline: path, step: 'small', resume: result.recordPath, wait: true })).data
  assert.deepEqual(rerun.steps.map((row: { status: string }) => row.status), ['reused', 'reused', 'completed', 'completed'])
  assert.equal(calls().length, 1)
  assert.equal(rerun.steps[1].reusedFrom, result.recordPath)
  const exportable = { version: 1, name: 'Workflow', steps: [{ id: 'draw', kind: 'generate', inputs: { prompt: 'a landscape', seed: 8, width: 64, height: 64, cfg: 7 } }] }
  const exported = (await call('pipeline_export_workflow', { pipeline: exportable, destination: 'workflow.json' })).data
  assert.equal(exported.path, join(project, 'workflow.json'))
  const imported = (await call('pipeline_import_workflow', { workflow: 'workflow.json', destination: 'imported.pipeline.json' })).data
  assert.equal(imported.path, join(project, 'imported.pipeline.json'))
  assert.deepEqual(JSON.parse(readFileSync(imported.path, 'utf8')), imported.pipeline)
  await assert.rejects(call('pipeline_export_workflow', { pipeline: exportable, destination: 'workflow.json' }), /exists/)
  await assert.rejects(call('pipeline_run', { pipeline: { version: 1, name: 'Bad', steps: [{ id: 'absent', kind: 'file', inputs: { path: 'absent.png' } }] } }), /absent/)
  assert.ok(!JSON.stringify(forwarded).includes(project), 'A later pipeline call forwarded local paths')
  assert.equal(readFileSync(path, 'utf8'), JSON.stringify(document))
  await readMediaHostSnapshot(settings)
  const detail = await readMediaPipelineDetails({ pipeline: path, step: 'small' }, project)
  assert.ok(detail.includes('Runpod pod pipeline-fixture'), detail)
  const { readMediaGenerationDetails } = await import('../../src/services/media/generation.js')
  assert.ok((await readMediaGenerationDetails('image', { prompt: 'fixture' }, project)).includes('Runpod pod pipeline-fixture'))
  const React = await import('react')
  const { enableConfigs } = await import('../../src/utils/config.js')
  enableConfigs()
  const { MediaPermissionRequest } = await import('../../src/components/permissions/MediaPermissionRequest.js')
  const { AppStoreContext, getDefaultAppState } = await import('../../src/state/AppState.js')
  const { createStore } = await import('../../src/state/store.js')
  const { mountOffscreen, waitFor } = await import('../lib/settingsPopupHarness.js')
  const card = React.createElement(MediaPermissionRequest, {
    kind: 'image', toolUseConfirm: { tool: runTool, input: { pipeline: path, step: 'small' }, cwd: project, toolUseID: 'remote-card', permissionResult: { behavior: 'ask' }, onAllow() {}, onReject() {}, onUserInteraction() {}, onAbort() {} },
    toolUseContext: context, onDone() {}, onReject() {}, verbose: false,
  } as never)
  const frame = await mountOffscreen(React.createElement(AppStoreContext.Provider, { value: createStore(getDefaultAppState()) }, card), 120, 28)
  try {
    assert.ok(await waitFor(() => frame.screen().includes('Runpod pod pipeline-fixture'), 5000), frame.screen())
    assert.ok(frame.screen().includes('Local image'))
    assert.ok(frame.screen().includes('Pipeline: Remote landscape · step small'))
    const frames = arg('--frames')
    if (frames) {
      mkdirSync(frames, { recursive: true })
      const lines = frame.lines()
      writeFileSync(join(frames, 'pipeline-remote-card.txt'), lines.join('\n'))
      const grid = Array.from({ length: 28 }, (_, y) => Array.from({ length: 120 }, (_, x) => { const style = frame.styleAt(x, y); return { c: [...(lines[y] ?? '')][x] ?? ' ', ...style, rev: style?.inverse } }))
      const gridPath = join(frames, 'pipeline-remote-card.json')
      writeFileSync(gridPath, JSON.stringify({ grid, cols: 120, rows: 28 }))
      const { gridToPng } = await import('../ui/gridToPng.js')
      await gridToPng(gridPath, join(frames, 'pipeline-remote-card.png'))
    }
  } finally { frame.unmount() }
  writeHostRecord({ ...record, status: 'EXITED', jobState: 'stopped' })
  await assert.rejects(call('pipeline_validate', { pipeline: path }), /Stopped/)
  console.log('remote media pipeline: selected host through extension and session permissions; no local paths on the wire; dry mode; all five tools; async results and hashed local records; partial reuse; machine detail; stopped-host refusal')
} finally {
  await close()
  if (proxy) { proxy.closeAllConnections(); await new Promise<void>(done => proxy!.close(() => done())) }
  await gateway?.close()
  await stopFixtureEngine()
  delete process.env.MEDIA_ROOT
  process.chdir(originalCwd)
  rmSync(proofHome, { recursive: true, force: true })
}
