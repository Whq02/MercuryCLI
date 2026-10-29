import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import { installLiveFixture, proofHome, root, serverPath, stopFixtureEngine } from './fixture.ts'

const source = fileURLToPath(new URL('../../src/services/media/pipeline.ts', import.meta.url))
const arg = (name: string): string | undefined => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const project = join(proofHome, 'project')
const originalCwd = process.cwd()
let close = async (): Promise<void> => {}

function png(): Buffer {
  const raw = Buffer.alloc((64 * 3 + 1) * 64)
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) raw.set([x * 4, y * 4, 128], y * (64 * 3 + 1) + 1 + x * 3)
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(type, 4, 'latin1')
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(data, crc32(head.subarray(4))))
    return Buffer.concat([head, data, crc])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(64, 0); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

try {
  assert.ok(existsSync(source), 'The media pipeline road is absent')
  const { discoverMediaPipelines, readMediaPipelineDetails, readMediaPipelineRunRecord, mediaPipelineArguments, mediaPipelineDiscoveryContent } = await import(pathToFileURL(source).href)
  mkdirSync(join(project, 'art'), { recursive: true })
  mkdirSync(join(project, 'node_modules'), { recursive: true })
  writeFileSync(join(project, 'landscape.pipeline.json'), '{}')
  writeFileSync(join(project, 'art', 'portrait.pipeline.json'), '{}')
  writeFileSync(join(project, 'node_modules', 'hidden.pipeline.json'), '{}')
  writeFileSync(join(project, 'other.json'), '{}')
  symlinkSync(project, join(project, 'art', 'loop'), 'dir')
  const paths = [join(project, 'art', 'portrait.pipeline.json'), join(project, 'landscape.pipeline.json')]
  assert.deepEqual(await discoverMediaPipelines(project), paths)
  const server = 'ext:mercury-media:engine'
  const document = { version: 1, name: 'Landscape', steps: [
    { id: 'draw', kind: 'generate', inputs: { prompt: 'a landscape', model: 'image-one', seed: 7, width: 64, height: 64, count: 2 } },
    { id: 'small', kind: 'downsize', inputs: { image: { step: 'draw', output: 'image' }, factor: 2 } },
    { id: 'colours', kind: 'palette', inputs: { image: { step: 'small', output: 'image' }, palette: 2 } },
    { id: 'grid', kind: 'sheet', inputs: { images: { step: 'draw', output: 'images' }, columns: 2 } },
    { id: 'save', kind: 'output', inputs: { image: { step: 'grid', output: 'image' } } },
  ] }
  const pipelinePath = join(project, 'landscape.pipeline.json')
  writeFileSync(pipelinePath, JSON.stringify(document))
  assert.equal(await readMediaPipelineDetails({ pipeline: 'landscape.pipeline.json' }, project), `Pipeline: Landscape · step draw\nOutput: ${join(project, 'media')}`)
  await assert.rejects(readMediaPipelineDetails({ pipeline: document, step: 'absent' }, project), /step absent/)
  assert.deepEqual(mediaPipelineArguments(server, 'pipeline_run', { pipeline: document }, project), { pipeline: document, cwd: project })
  assert.deepEqual(mediaPipelineArguments('other', 'pipeline_run', { pipeline: document }, project), { pipeline: document })
  assert.equal(mediaPipelineArguments(server, 'pipeline_run', { pipeline: document, cwd: 7 }, project).cwd, 7)
  assert.deepEqual(JSON.parse((await mediaPipelineDiscoveryContent(server, 'pipeline_describe', {}, project))[0].text), { pipelines: paths })
  assert.deepEqual(await mediaPipelineDiscoveryContent(server, 'pipeline_describe', { pipeline: document }, project), [])

  installLiveFixture()
  const engine = arg('--engine')
  if (engine) cpSync(resolve(engine), dirname(serverPath), { recursive: true })
  const local = JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8'))
  local.models[0].recipe = 'sd1-checkpoint'
  local.models[0].slots = { model: 'image.gguf' }
  writeFileSync(join(root, 'catalog.json'), JSON.stringify(local))
  mkdirSync(join(root, 'models'), { recursive: true })
  writeFileSync(join(root, 'models/image.gguf'), Buffer.alloc(8))
  writeFileSync(join(root, 'config.json'), JSON.stringify({ imageModel: 'image-one', videoModel: 'video-one', outputs: join(proofHome, 'elsewhere') }))
  const binary = join(root, 'runtime/sd-server')
  writeFileSync(binary, readFileSync(binary, 'utf8').replace(/const png = '[^']+';/, `const png = '${png().toString('base64')}';`))
  process.chdir(project)
  Object.assign(globalThis, { MACRO: { VERSION: '1.0.0', IS_DEV: false } })
  const { setCwdState, setOriginalCwd, setProjectRoot } = await import('../../src/bootstrap/state.js')
  setCwdState(project); setOriginalCwd(project); setProjectRoot(project)
  const { connectToServer, fetchToolsForClient } = await import('../../src/services/mcp/client.js')
  const { mediaGenerationKind } = await import('../../src/services/media/generation.js')
  const connection = await connectToServer(server, { type: 'stdio', command: 'node', args: [serverPath], env: { PATH: process.env.PATH!, MEDIA_ROOT: root }, scope: 'dynamic' })
  assert.equal(connection.type, 'connected', JSON.stringify(connection))
  if (connection.type !== 'connected') throw new Error('Fixture media connection failed')
  close = () => connection.client.close()
  const tools = await fetchToolsForClient(connection)
  const pipelineNames = ['pipeline_validate', 'pipeline_describe', 'pipeline_run', 'pipeline_import_workflow', 'pipeline_export_workflow']
  for (const name of pipelineNames) assert.ok(tools.some(tool => tool.mcpInfo?.toolName === name), `Missing engine tool ${name}`)
  const runTool = tools.find(tool => tool.mcpInfo?.toolName === 'pipeline_run')!
  assert.equal(mediaGenerationKind(runTool), 'image')
  assert.equal(mediaGenerationKind({ mcpInfo: { serverName: 'other', toolName: 'pipeline_run' } }), undefined)
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
  const { createAssistantMessage } = await import('../../src/utils/messages/factories.js')
  const { decideToolPermission } = await import('../../src/utils/permissions/decision/engine.js')
  const permission = getEmptyToolPermissionContext()
  const context: any = { abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: permission }), setAppState: () => {}, options: {} }
  const decision = await decideToolPermission(runTool, { pipeline: pipelinePath }, context)
  assert.equal(decision.decision.behavior, 'ask')
  let callId = 0
  const call = async (name: string, input: Record<string, unknown> = {}) => {
    const tool = tools.find(tool => tool.mcpInfo?.toolName === name)!
    const id = `pipeline-proof-${++callId}`
    const message = createAssistantMessage({ content: [{ type: 'tool_use', id, name: tool.name, input }], isVirtual: true })
    const data = (await tool.call(input, { ...context, toolUseId: id }, async () => ({ behavior: 'allow', updatedInput: input }), message)).data
    return (typeof data === 'string' ? [{ type: 'text', text: data }] : data) as Array<{ type: string; text?: string }>
  }
  const facts = (content: Array<{ type: string; text?: string }>): any => JSON.parse(content.find(part => part.type === 'text')!.text!)
  const described = await call('pipeline_describe')
  assert.equal(facts(described).version, 1)
  assert.deepEqual(JSON.parse(described.at(-1)!.text!), { pipelines: paths })
  const valid = facts(await call('pipeline_validate', { pipeline: 'landscape.pipeline.json' }))
  assert.equal(valid.valid, true)
  const describedPipeline = facts(await call('pipeline_describe', { pipeline: 'landscape.pipeline.json' }))
  assert.deepEqual(describedPipeline.steps.map((row: { id: string }) => row.id), document.steps.map(row => row.id))
  const invalidDocument = { version: 1, name: 'Refused', steps: [{ id: 'unknown', kind: 'invented', inputs: {} }] }
  const invalid = facts(await call('pipeline_validate', { pipeline: invalidDocument }))
  assert.equal(invalid.valid, false)
  assert.ok(invalid.errors.some((error: { step: string }) => error.step === 'unknown'))
  await assert.rejects(call('pipeline_run', { pipeline: invalidDocument }), /unknown/)
  const dry = facts(await call('pipeline_run', { pipeline: 'landscape.pipeline.json', dry: true }))
  assert.equal(dry.dry, true)
  assert.equal(dry.valid, true)
  assert.equal(existsSync(join(root, 'engine-calls.jsonl')), false)
  assert.equal(existsSync(join(project, 'media')), false)
  const workflow = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'image.gguf' } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: 'a landscape', clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: 64, height: 64, batch_size: 1 } },
    '5': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0], seed: 7, steps: 2, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'landscape' } },
  }
  writeFileSync(join(project, 'workflow.json'), JSON.stringify(workflow))
  const imported = facts(await call('pipeline_import_workflow', { workflow: 'workflow.json', name: 'Imported', destination: 'imported.pipeline.json' }))
  assert.equal(imported.pipeline.name, 'Imported')
  assert.equal(imported.path, join(project, 'imported.pipeline.json'))
  assert.deepEqual(JSON.parse(readFileSync(imported.path, 'utf8')), imported.pipeline)
  await assert.rejects(call('pipeline_import_workflow', { workflow: 'workflow.json', destination: 'imported.pipeline.json' }), /exists/)
  const exported = facts(await call('pipeline_export_workflow', { pipeline: 'imported.pipeline.json', destination: 'export.json' }))
  assert.equal(exported.path, join(project, 'export.json'))
  assert.ok(existsSync(exported.path))
  await assert.rejects(call('pipeline_export_workflow', { pipeline: 'imported.pipeline.json', destination: 'export.json' }), /exists/)
  await assert.rejects(call('pipeline_export_workflow', { pipeline: 'landscape.pipeline.json', destination: 'refused.json' }), /small/)
  assert.equal(existsSync(join(root, 'engine-calls.jsonl')), false)

  const queued = facts(await call('pipeline_run', { pipeline: 'landscape.pipeline.json' }))
  assert.equal(typeof queued.jobId, 'string')
  assert.equal(queued.kind, 'image')
  assert.equal(queued.pipeline.name, 'Landscape')
  const jobs = facts(await call('media_jobs'))
  assert.ok(jobs.jobs.some((row: { jobId: string }) => row.jobId === queued.jobId))
  const content = await call('media_result', { job_id: queued.jobId, timeout: 30 })
  const result = facts(content)
  assert.equal(result.status, 'completed')
  assert.equal(result.pipeline.name, 'Landscape')
  assert.equal(result.pipeline.hash, valid.pipelineHash)
  assert.ok(content.some(part => part.type === 'image'))
  const record = await readMediaPipelineRunRecord(result.recordPath, project)
  assert.deepEqual(record.document, document)
  assert.equal(record.pipelineHash, valid.pipelineHash)
  assert.deepEqual(record.steps.map((row: { id: string }) => row.id), document.steps.map(row => row.id))
  for (const path of result.outputs) { assert.ok(path.startsWith(join(project, 'media') + '/')); assert.ok(existsSync(path)) }
  assert.deepEqual(result.steps, record.steps)
  const allPaths = result.steps.flatMap((step: { files?: Array<{ path: string }> }) => (step.files ?? []).map(file => file.path))
  for (const step of record.steps) for (const file of step.files ?? []) {
    assert.ok(allPaths.includes(file.path), `Missing output ${file.path}`)
    assert.ok(file.path.startsWith(join(project, 'media') + '/'))
    assert.ok(existsSync(file.path))
  }
  assert.equal(readFileSync(pipelinePath, 'utf8'), JSON.stringify(document))
  const calls = () => readFileSync(join(root, 'engine-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.route === 'img_gen')
  assert.deepEqual(calls().map(row => row.body.seed), [7, 8])
  const rerun = facts(await call('pipeline_run', { pipeline: 'landscape.pipeline.json', step: 'small', resume: result.recordPath, wait: true }))
  assert.equal(rerun.status, 'completed')
  assert.equal(calls().length, 2)
  const rerunRecord = await readMediaPipelineRunRecord(rerun.recordPath, project)
  assert.equal(rerunRecord.steps[0].status, 'reused')
  assert.equal(rerunRecord.steps[1].status, 'completed')
  assert.equal(await readMediaPipelineDetails({ pipeline: 'landscape.pipeline.json', step: 'small', resume: result.recordPath }, project), `Pipeline: Landscape · step small\nOutput: ${join(project, 'media')}`)
  const React = await import('react')
  const { enableConfigs } = await import('../../src/utils/config.js')
  enableConfigs()
  const { MediaPermissionRequest } = await import('../../src/components/permissions/MediaPermissionRequest.js')
  const { AppStoreContext, getDefaultAppState } = await import('../../src/state/AppState.js')
  const { createStore } = await import('../../src/state/store.js')
  const { mountOffscreen, waitFor } = await import('../lib/settingsPopupHarness.js')
  const input = { pipeline: pipelinePath, step: 'small', resume: result.recordPath }
  const card = React.createElement(MediaPermissionRequest, {
    kind: 'image', toolUseConfirm: { tool: runTool, input, cwd: project, toolUseID: 'pipeline-card', permissionResult: { behavior: 'ask' }, onAllow() {}, onReject() {}, onUserInteraction() {}, onAbort() {} },
    toolUseContext: context, onDone() {}, onReject() {}, verbose: false,
  } as never)
  const frame = await mountOffscreen(React.createElement(AppStoreContext.Provider, { value: createStore(getDefaultAppState()) }, card), 120, 28)
  try {
    assert.ok(await waitFor(() => frame.screen().includes('Pipeline: Landscape · step small'), 5000), frame.screen())
    assert.ok(frame.screen().includes('Local image'))
    const frames = arg('--frames')
    if (frames) {
      mkdirSync(frames, { recursive: true })
      const lines = frame.lines()
      writeFileSync(join(frames, 'pipeline-card.txt'), lines.join('\n'))
      const grid = Array.from({ length: 28 }, (_, y) => Array.from({ length: 120 }, (_, x) => {
        const style = frame.styleAt(x, y)
        return { c: [...(lines[y] ?? '')][x] ?? ' ', ...style, rev: style?.inverse }
      }))
      const path = join(frames, 'pipeline-card.json')
      writeFileSync(path, JSON.stringify({ grid, cols: 120, rows: 28 }))
      const { gridToPng } = await import('../ui/gridToPng.js')
      await gridToPng(path, join(frames, 'pipeline-card.png'))
    }
  } finally { frame.unmount() }
  const missing = { version: 1, name: 'Missing', steps: [{ id: 'source', kind: 'file', inputs: { path: 'absent.png' } }] }
  await assert.rejects(call('pipeline_run', { pipeline: missing, wait: true }), /source/)
  console.log('media pipeline: project discovery; all five tools through session permissions and MCP; dry and step refusals; ComfyUI import/export; async results, every output path and run records; partial rerun reuses the unchanged render')
} finally {
  await close()
  await stopFixtureEngine()
  process.chdir(originalCwd)
  rmSync(proofHome, { recursive: true, force: true })
}
