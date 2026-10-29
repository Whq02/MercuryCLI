import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { Client, StdioClientTransport } from '../../src/services/mcp/sdk.js'
import { mediaAddPlan, mediaAddSource, mediaRows, pullMedia, runMediaSetup, type MediaProgress } from '../../src/services/media/setup.js'
import { readMediaCatalogue } from '../../src/services/media/catalogue.js'
import { installFixture, proofHome, root, serverPath } from './fixture.ts'

const client = new Client({ name: 'media-user-models-proof', version: '1' })
try {
  installFixture()
  cpSync(new URL('../../src/extensions/bundled/mercury-media/server/', import.meta.url), dirname(serverPath), { recursive: true })
  const tensors: Record<string, { dtype: string; shape: number[]; data_offsets: number[] }> = {}
  let offset = 0
  for (const [name, shape] of Object.entries({
    'model.diffusion_model.input_blocks.0.0.weight': [1, 4, 1, 1],
    'model.diffusion_model.middle_block.1.proj_in.weight': [1],
    'cond_stage_model.transformer.text_model.embeddings.token_embedding.weight': [1, 768],
    'first_stage_model.decoder.conv_out.weight': [1],
  })) {
    const bytes = shape.reduce((n, d) => n * d, 1) * 2
    tensors[name] = { dtype: 'F16', shape, data_offsets: [offset, offset + bytes] }
    offset += bytes
  }
  const header = Buffer.from(JSON.stringify(tensors))
  const prefix = Buffer.alloc(8)
  prefix.writeBigUInt64LE(BigInt(header.length))
  const weights = Buffer.concat([prefix, header, Buffer.alloc(offset)])
  const file = join(proofHome, 'my own checkpoint.safetensors')
  writeFileSync(file, weights)
  assert.equal(mediaAddSource(''), undefined)
  assert.equal(mediaAddSource(`add "${file}"`), file)
  assert.equal(mediaAddSource(`add ${file}`), file)
  assert.throws(() => mediaAddSource('add'))
  const transport = new StdioClientTransport({ command: 'node', args: [serverPath], cwd: proofHome, env: { ...process.env, MEDIA_ROOT: root } as Record<string, string>, stderr: 'pipe' })
  await client.connect(transport)
  const pid = transport.pid
  const listedBefore = await client.callTool({ name: 'media_models', arguments: {} })
  assert.equal(listedBefore.isError, undefined)
  assert.ok((await client.listTools()).tools.find(tool => tool.name === 'image_generate')!.inputSchema.properties!.loras)
  const progress: MediaProgress[] = []
  const run = (args: string[], report: (event: MediaProgress) => void, signal?: AbortSignal) => runMediaSetup(args, report, signal, { root, serverPath })
  const plan = await mediaAddPlan(file, root, run)
  assert.deepEqual(plan.args, ['add-model', file])
  assert.equal(plan.remote, false)
  assert.equal(plan.bytes, 0)
  assert.equal(plan.license, 'your own file')
  await run(plan.args, event => progress.push(event))
  assert.equal(progress.at(-1)!.event, 'done')
  const catalogue = await readMediaCatalogue({ root, serverPath })
  const model = catalogue.models.find(row => row.id.startsWith('user-'))!
  assert.equal(model.recipe, 'sd1-checkpoint')
  assert.equal(model.license, 'your own file')
  const rows = mediaRows(catalogue, root, { totalMemoryBytes: 32 * 1024 ** 3, usableMemoryBytes: 24 * 1024 ** 3 }, 8 * 1024 ** 3)
  const row = rows.find(row => row.model.id === model.id)!
  assert.equal(row.installed, true)
  assert.match(row.words, /^installed · .* disk · .* memory · .* s\/image · fits$/)
  assert.equal(row.bytes, weights.length)
  const recorded = catalogue.files.find(item => item.path === model.slots.model)!
  assert.equal(recorded.sha256, createHash('sha256').update(weights).digest('hex'))
  const listed = await client.callTool({ name: 'media_models', arguments: {} })
  assert.equal(listed.isError, undefined)
  const data = JSON.parse((listed.content as Array<{ text: string }>)[0]!.text)
  assert.equal(data.models.find((item: { model: string }) => item.model === model.id).installed, true)
  assert.equal(transport.pid, pid)
  assert.equal((await client.callTool({ name: 'media_set_default', arguments: { kind: 'image', model: model.id } })).isError, undefined)
  const url = 'https://huggingface.co/fixture/model/resolve/main/model.safetensors'
  let downloads = 0
  const remote = await mediaAddPlan(url, root, async (args, report) => { assert.deepEqual(args, ['inspect-model', url]); report({ event: 'done', model: { name: 'model.safetensors', bytes: 1234, remote: true } }) })
  assert.equal(remote.bytes, 1234)
  assert.equal(await pullMedia(remote, async () => false, async () => { downloads++ }, () => {}), false)
  assert.equal(downloads, 0)
  assert.equal(await pullMedia(remote, async () => true, async args => { assert.deepEqual(args, ['add-model', url]); downloads++ }, () => {}), true)
  assert.equal(downloads, 1)
  const installed = join(root, 'models', model.slots.model!)
  const corrupt = readFileSync(installed)
  corrupt[corrupt.length - 1] = 1
  writeFileSync(installed, corrupt)
  await assert.rejects(run(['add-model', file], () => {}), /SHA-256/)
  console.log('media own files: add arguments, persistent row, unchanged row words, live SDK discovery/default, download consent, hash refusal')
} finally {
  await client.close()
  rmSync(proofHome, { recursive: true, force: true })
}
