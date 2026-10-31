import { proofHome } from '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '../../src/services/mcp/sdk.js'
import { LazyStdioClientTransport, type McpBootstrapManifest } from '../../src/services/mcp/lazyStdio.js'
import { removeScratch } from '../lib/removeScratch.ts'

const manifest: McpBootstrapManifest = {
  serverInfo: { name: 'lazy-fixture', version: '1' },
  capabilities: { tools: { listChanged: true }, resources: { listChanged: true } },
  instructions: 'fixture instructions',
  tools: [{ name: 'status', inputSchema: { type: 'object', properties: {} } }],
}
const fixture = join(proofHome, 'server.mjs')
const starts = join(proofHome, 'starts')
writeFileSync(fixture, `import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
appendFileSync(process.argv[2], process.pid + '\\n')
const manifest = JSON.parse(process.argv[3])
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    if (process.argv[4] === 'stall') return
    if (process.argv[4] === 'fail') { send({ id: message.id, error: { code: -32603, message: 'fixture initialize failed' } }); return }
    const { tools, ...rest } = manifest
    send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, ...rest } })
  } else if (message.method === 'tools/list') send({ id: message.id, result: { tools: [...manifest.tools, { name: 'attached', inputSchema: { type: 'object' } }] } })
  else if (message.method === 'resources/list') send({ id: message.id, result: { resources: [{ uri: 'fixture://active', name: 'active' }] } })
  else if (message.method === 'tools/call') {
    send({ method: 'notifications/tools/list_changed' })
    send({ id: message.id, result: { content: [{ type: 'text', text: 'ready' }] } })
  }
})
`)
const connections: Array<{ client: Client; transport: LazyStdioClientTransport }> = []
const open = async (mode = '', timeout = 1000) => {
  const changed = Promise.withResolvers<void>()
  const client = new Client({ name: 'lazy-proof', version: '1' }, { versionNegotiation: { mode: 'legacy' }, listChanged: { tools: { autoRefresh: false, onChanged: () => changed.resolve() } } })
  const transport = new LazyStdioClientTransport({ command: 'node', args: [fixture, starts, JSON.stringify(manifest), mode], stderr: 'pipe' }, manifest, timeout)
  connections.push({ client, transport })
  await client.connect(transport)
  return { client, transport, changed: changed.promise }
}
try {
  const { client, transport, changed } = await open()
  assert.equal(transport.pid, null)
  assert.deepEqual((await client.listTools()).tools, manifest.tools)
  assert.equal(client.getInstructions(), manifest.instructions)
  assert.deepEqual((await client.listResources()).resources, [])
  const call = () => client.callTool({ name: 'status', arguments: {} })
  await Promise.all([call(), call()])
  const pid = transport.pid
  assert.ok(pid)
  await call()
  assert.equal(transport.pid, pid)
  assert.equal(readFileSync(starts, 'utf8').trim().split('\n').length, 1)
  await Promise.race([changed, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('list_changed missing')), 2000); timer.unref() })])
  assert.equal((await client.listTools()).tools.length, 2)
  assert.equal((await client.listResources()).resources[0]?.uri, 'fixture://active')
  await client.close()
  assert.equal(transport.pid, null)
  const cold = await open()
  await cold.client.close()
  assert.equal(cold.transport.pid, null)
  await assert.rejects(cold.transport.send({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'status' } }), /closed/)
  assert.equal(readFileSync(starts, 'utf8').trim().split('\n').length, 1)
  for (const mode of ['fail', 'stall']) {
    const row = await open(mode, 150)
    await assert.rejects(row.client.callTool({ name: 'status' }))
    await row.client.close()
    assert.equal(row.transport.pid, null)
  }
  console.log('lazy stdio: concurrent first use starts once; later calls reuse; live tools/resources and notifications pass through; cold close and failed initialization leave no child')
} finally {
  for (const { client } of connections) await client.close().catch(() => {})
  removeScratch(proofHome)
}
