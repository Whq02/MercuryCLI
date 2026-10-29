import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client, StdioClientTransport } from '../../src/services/mcp/sdk.js'
import { installLiveFixture, proofHome, root, serverPath, stopFixtureEngine } from './fixture.ts'

function embedding(width: number): Buffer {
  const text = Buffer.from(JSON.stringify({ emb_params: { dtype: 'F16', shape: [1, width], data_offsets: [0, width * 2] } }))
  const size = Buffer.alloc(8)
  size.writeBigUInt64LE(BigInt(text.length))
  return Buffer.concat([size, text, Buffer.alloc(width * 2)])
}
process.chdir(proofHome)
const client = new Client({ name: 'media-embedding-proof', version: '1.0.0' })
try {
  installLiveFixture()
  mkdirSync(join(root, 'models'), { recursive: true })
  writeFileSync(join(root, 'models/image.gguf'), Buffer.alloc(8))
  const local = JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8'))
  local.models[0].recipe = 'sd1-checkpoint'
  local.models[0].slots = { model: 'image.gguf' }
  writeFileSync(join(root, 'catalog.json'), JSON.stringify(local))
  writeFileSync(join(proofHome, 'style.safetensors'), embedding(768))
  writeFileSync(join(proofHome, 'other.safetensors'), embedding(1024))
  await client.connect(new StdioClientTransport({ command: 'node', args: [serverPath], cwd: proofHome, env: { ...process.env, MEDIA_ROOT: root, MEDIA_OUTPUT_DIR: join(root, 'outputs') } as Record<string, string>, stderr: 'pipe' }))
  const tools = await client.listTools(), schema = tools.tools.find(tool => tool.name === 'image_generate')!.inputSchema
  assert.ok(schema.properties?.embeddings)
  const generate = (args: Record<string, unknown>) => client.callTool({ name: 'image_generate', arguments: { model: 'image-one', prompt: 'fixture', width: 64, height: 64, cwd: proofHome, wait: true, seed: 123, ...args } })
  const wrongFamily = await generate({ embeddings: [{ path: 'other.safetensors' }] })
  assert.equal(wrongFamily.isError, true)
  assert.match((wrongFamily.content as Array<{ text: string }>)[0]!.text, /sd2.*sd1/)
  assert.equal((await generate({ embeddings: [{ path: 'style.safetensors', token: '../escape' }] })).isError, true)
  assert.equal(existsSync(join(root, 'engine-calls.jsonl')), false)
  const generated = await generate({ embeddings: [{ path: 'style.safetensors' }] })
  assert.equal(generated.isError ?? false, false, JSON.stringify(generated))
  const result = JSON.parse((generated.content as Array<{ text: string }>)[0]!.text)
  assert.equal(result.prompt, 'fixture, style')
  assert.equal(result.embeddings[0].family, 'sd1')
  assert.equal(result.embeddings[0].token, 'style')
  const record = JSON.parse(readFileSync(join(root, 'run/engines.json'), 'utf8')).image
  const directory = record.args[record.args.indexOf('--embd-dir') + 1]
  assert.deepEqual(readdirSync(directory), ['style.safetensors'])
  assert.deepEqual(readFileSync(join(directory, 'style.safetensors')), embedding(768))
  const plain = await generate({ embeddings: [] })
  assert.equal(plain.isError ?? false, false, JSON.stringify(plain))
  assert.equal(JSON.parse(readFileSync(join(root, 'run/engines.json'), 'utf8')).image.args.includes('--embd-dir'), false)
  assert.equal(JSON.parse((plain.content as Array<{ text: string }>)[0]!.text).embeddings, undefined)
  assert.deepEqual(await client.listTools(), tools)
  console.log('media embeddings: discovered SDK input, family refusal, exact staged vectors, token application and clean following request')
} finally {
  await client.close()
  await stopFixtureEngine()
  rmSync(proofHome, { recursive: true, force: true })
}
