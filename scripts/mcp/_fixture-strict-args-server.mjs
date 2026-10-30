#!/usr/bin/env node
import { createInterface } from 'node:readline'

const tools = [
  {
    name: 'gen',
    description: 'strict about its argument types',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        ref: { type: 'string' },
        opts: { type: 'object', properties: { seed: { type: 'integer' }, style: { type: 'string' } } },
        layers: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, mask: { type: 'string' } }, required: ['name'] } },
      },
      required: ['prompt'],
    },
  },
]
const send = o => process.stdout.write(JSON.stringify(o) + '\n')
const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)
const expect = (bad, path, value, type) => {
  if (typeOf(value) !== type) bad.push(`${path}: expected ${type}, received ${typeOf(value)}`)
}
createInterface({ input: process.stdin }).on('line', line => {
  let m
  try {
    m = JSON.parse(line)
  } catch {
    return
  }
  if (m.id === undefined) return
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'strict', version: '1' } } })
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools } })
  if (m.method === 'tools/call') {
    const a = m.params.arguments ?? {}
    const bad = []
    expect(bad, 'prompt', a.prompt, 'string')
    if ('ref' in a) expect(bad, 'ref', a.ref, 'string')
    if ('opts' in a) {
      expect(bad, 'opts', a.opts, 'object')
      if (typeOf(a.opts) === 'object') {
        if ('seed' in a.opts) expect(bad, 'opts.seed', a.opts.seed, 'number')
        if ('style' in a.opts) expect(bad, 'opts.style', a.opts.style, 'string')
      }
    }
    if ('layers' in a) {
      expect(bad, 'layers', a.layers, 'array')
      if (Array.isArray(a.layers)) a.layers.forEach((layer, i) => {
        expect(bad, `layers.${i}.name`, layer?.name, 'string')
        if (layer && 'mask' in layer) expect(bad, `layers.${i}.mask`, layer.mask, 'string')
      })
    }
    if (bad.length) return send({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: `Invalid arguments: ${bad.join('; ')}` }] } })
    return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `ok ${JSON.stringify(a)}` }] } })
  }
  if (m.method === 'ping') return send({ jsonrpc: '2.0', id: m.id, result: {} })
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } })
})
