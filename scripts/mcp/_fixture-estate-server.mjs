#!/usr/bin/env node
// The awkward stdio MCP server for scripts/mcp/prove-mcp-tool-estate.ts:
// newline-delimited JSON-RPC, no dependencies, no network, exits when stdin
// closes. Every tool is a shape the estate must carry faithfully — names with
// dots, dashes and non-ASCII, a schema with optional/nullable/enum/anyOf/
// array-of-object inputs, an over-long description, an error result, an
// image, an embedded resource, structured output, a slow call, a call that
// kills the server, a form elicitation, a destructive-hinted tool, and a
// name whose qualified form outgrows the 64-character wire grammar.
import { createInterface } from 'node:readline'

const send = obj => process.stdout.write(JSON.stringify(obj) + '\n')
const rl = createInterface({ input: process.stdin })

// A 1×1 transparent PNG.
const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const LONG_DESCRIPTION = `An awkward tool. ${'Its description runs on and on. '.repeat(120)}END-OF-DESCRIPTION`

const TOOLS = [
  {
    name: 'plain.echo',
    description: 'Echo the text back (a dotted name).',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'awkward-schema-tool',
    description: LONG_DESCRIPTION,
    annotations: { title: 'Awkward', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['fast', 'slow', 'weird'] },
        count: { type: ['integer', 'null'], description: 'nullable' },
        label: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
            required: ['id'],
          },
        },
        choice: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      },
      required: ['mode'],
      additionalProperties: false,
    },
  },
  {
    name: 'boom',
    description: 'Always fails.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'picture',
    description: 'Returns an image and a caption.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'resource_out',
    description: 'Returns an embedded resource.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'slow',
    description: 'Sleeps for ms milliseconds.',
    inputSchema: { type: 'object', properties: { ms: { type: 'integer' } } },
  },
  {
    name: 'structured',
    description: 'Returns structured content.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
  },
  {
    name: 'crash',
    description: 'Kills the server mid-call.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'a_tool_whose_name_is_deliberately_far_too_long_for_the_openai_wire_grammar',
    description: 'Its qualified name outgrows the 64-character function-name grammar.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  },
  {
    name: 'unicode_名前',
    description: 'A non-ASCII name.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  },
  {
    name: 'ask',
    description: 'Asks the client a form question and reports the answer.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'destructive_op',
    description: 'A destructive-hinted tool.',
    annotations: { destructiveHint: true, readOnlyHint: false },
    inputSchema: { type: 'object', properties: {} },
  },
]

let nextRequestId = 1000
const pending = new Map()

function request(method, params) {
  const id = nextRequestId++
  return new Promise(resolve => {
    pending.set(id, resolve)
    send({ jsonrpc: '2.0', id, method, params })
  })
}

const text = (t, extra = {}) => ({ content: [{ type: 'text', text: t }], ...extra })

async function callTool(name, args) {
  switch (name) {
    case 'plain.echo':
      return text(`echo:${args?.text ?? ''}`)
    case 'awkward-schema-tool':
      return text(JSON.stringify(args ?? {}))
    case 'boom':
      return { content: [{ type: 'text', text: 'boom failed: the fixture always fails here' }], isError: true }
    case 'picture':
      return { content: [{ type: 'image', data: PNG_1x1, mimeType: 'image/png' }, { type: 'text', text: 'a picture' }] }
    case 'resource_out':
      return { content: [{ type: 'resource', resource: { uri: 'fixture://doc', mimeType: 'text/plain', text: 'resource body' } }] }
    case 'slow': {
      const ms = typeof args?.ms === 'number' ? args.ms : 30_000
      await new Promise(resolve => setTimeout(resolve, ms))
      return text(`slept ${ms}`)
    }
    case 'structured':
      return { content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } }
    case 'crash':
      process.exit(3)
    // eslint-disable-next-line no-fallthrough
    case 'a_tool_whose_name_is_deliberately_far_too_long_for_the_openai_wire_grammar':
      return text(`long:${args?.text ?? ''}`)
    case 'unicode_名前':
      return text(`unicode:${args?.text ?? ''}`)
    case 'ask': {
      const answer = await request('elicitation/create', {
        message: 'What is your favourite colour?',
        requestedSchema: { type: 'object', properties: { colour: { type: 'string' } }, required: ['colour'] },
      })
      return text(`answer:${JSON.stringify(answer)}`)
    }
    case 'destructive_op':
      return text('destroyed nothing')
    default:
      return { content: [{ type: 'text', text: `no such tool ${name}` }], isError: true }
  }
}

rl.on('line', line => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  // A response to one of OUR requests (elicitation).
  if (msg.method === undefined && msg.id !== undefined && pending.has(msg.id)) {
    const resolve = pending.get(msg.id)
    pending.delete(msg.id)
    resolve(msg.error ? { error: msg.error } : msg.result)
    return
  }
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'estate-fixture', version: '1.0.0' },
      },
    })
    return
  }
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } })
    return
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params ?? {}
    callTool(name, args).then(
      result => send({ jsonrpc: '2.0', id: msg.id, result }),
      error => send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(error?.message ?? error) } }),
    )
    return
  }
  if (msg.method === 'ping') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} })
    return
  }
  if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, result: { prompts: [], resources: [] } })
  }
})

rl.on('close', () => process.exit(0))
