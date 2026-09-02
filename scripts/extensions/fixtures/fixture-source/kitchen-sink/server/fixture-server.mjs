#!/usr/bin/env node
// The proof suite's MCP server: stdio, two tools (one read-only, one that
// "mutates"), protocol-correct, no dependencies. Runs as its own process.
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (line.trim()) handle(JSON.parse(line))
  }
})
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}
function handle(msg) {
  if (msg.method === 'initialize') {
    reply(msg.id, {
      protocolVersion: msg.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'fixture', version: '1.0.0' },
    })
  } else if (msg.method === 'tools/list') {
    reply(msg.id, {
      tools: [
        { name: 'fixture_read', description: 'Read the fixture value', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
        { name: 'fixture_write', description: 'Write the fixture value', inputSchema: { type: 'object', properties: { value: { type: 'string' } } } },
      ],
    })
  } else if (msg.method === 'tools/call') {
    const name = msg.params.name
    const token = process.env.FIXTURE_TOKEN ?? ''
    const root = process.env.MERCURY_EXTENSION_ROOT ?? ''
    reply(msg.id, { content: [{ type: 'text', text: `${name} ok token=${token} root=${root}` }] })
  } else if (msg.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not found' } }) + '\n')
  }
}
