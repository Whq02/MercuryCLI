#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'mcp-null-optionals-'))
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { withoutNullOptionals, connectToServer, fetchToolsForClient, callMCPToolWithUrlElicitationRetry, clearServerCache } = await import('../../src/services/mcp/client.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

console.log('an MCP call drops the null a model wrote for an optional field the server cannot take')
const schema = {
  type: 'object',
  properties: {
    prompt: { type: 'string' },
    reference_image: { type: 'string' },
    seed: { type: ['integer', 'null'] },
    mask: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    size: { type: 'string', nullable: true },
  },
  required: ['prompt'],
}
const args = { prompt: 'a castle', reference_image: null, seed: null, mask: null, size: null, downsize: null, model: 'z-image-turbo' }
const out = withoutNullOptionals(args, schema)
check('an optional string field sent as null is dropped (reference_image)', !('reference_image' in out))
check('a field the schema declares nullable through a type array keeps its null (seed)', 'seed' in out && out.seed === null)
check('a field the schema declares nullable through anyOf keeps its null (mask)', 'mask' in out && out.mask === null)
check('a field marked nullable keeps its null (size)', 'size' in out && out.size === null)
check('a null for a field the schema does not know is dropped too (downsize)', !('downsize' in out))
check('every non-null argument rides unchanged', out.prompt === 'a castle' && out.model === 'z-image-turbo')
check('a required field sent as null is kept for the server to refuse by name', 'prompt' in withoutNullOptionals({ prompt: null }, schema))
const same = { prompt: 'a castle', model: 'x' }
check('arguments without a null come back as the same object', withoutNullOptionals(same, schema) === same)
check('with no schema at all a null is treated as absent', !('reference_image' in withoutNullOptionals({ prompt: 'p', reference_image: null }, undefined)))

console.log('\nthe rule holds at every depth, not only at the top level')
const nested = {
  type: 'object',
  properties: {
    prompt: { type: 'string' },
    opts: { type: 'object', properties: { seed: { type: 'integer' }, style: { type: 'string' }, tint: { type: ['string', 'null'] } }, required: ['style'] },
    layers: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, mask: { type: 'string' } }, required: ['name'] } },
    either: { anyOf: [{ type: 'object', properties: { depth: { type: 'integer' } } }, { type: 'null' }] },
  },
  required: ['prompt'],
}
const deep = withoutNullOptionals(
  { prompt: 'p', opts: { seed: null, style: null, tint: null, extra: null }, layers: [{ name: 'a', mask: null }, { name: null }], either: { depth: null }, loose: { inner: null } },
  nested,
) as Record<string, any>
check('an optional null inside a nested object is dropped (opts.seed)', !('seed' in deep.opts))
check('a required null inside a nested object is kept for the server to refuse by name (opts.style)', 'style' in deep.opts && deep.opts.style === null)
check('a nullable field inside a nested object keeps its null (opts.tint)', 'tint' in deep.opts && deep.opts.tint === null)
check('a null for a nested field the schema does not know is dropped (opts.extra)', !('extra' in deep.opts))
check('an optional null inside an array item is dropped (layers[0].mask)', !('mask' in deep.layers[0]) && deep.layers[0].name === 'a')
check('a required null inside an array item is kept (layers[1].name)', deep.layers.length === 2 && deep.layers[1].name === null)
check('an object behind anyOf is walked with its object branch (either.depth)', !('depth' in deep.either))
check('an object the schema does not describe drops its nulls too (loose.inner)', !('inner' in deep.loose))
const unchangedDeep = { prompt: 'p', opts: { seed: 1 }, layers: [{ name: 'a' }] }
check('nested arguments without a null come back as the same object', withoutNullOptionals(unchangedDeep, nested) === unchangedDeep)
check('an array of scalars rides unchanged', JSON.stringify(withoutNullOptionals({ prompt: 'p', tags: ['a', null] }, { properties: { tags: { type: 'array', items: { type: 'string' } } } }).tags) === '["a",null]')

console.log('\nend to end: a strict server never sees the nested null')
const config: import('../../src/services/mcp/types.ts').ScopedMcpServerConfig = { type: 'stdio', scope: 'dynamic', command: process.execPath, args: [join(import.meta.dir, '_fixture-strict-args-server.mjs')] }
const connection = await connectToServer('strict-args', config)
try {
  check('the strict fixture connects', connection.type === 'connected')
  if (connection.type === 'connected') {
    const tools = await fetchToolsForClient(connection)
    const gen = tools.find(tool => (tool as { mcpInfo?: { toolName: string } }).mcpInfo?.toolName === 'gen') as { inputJSONSchema?: unknown } | undefined
    check('the gen tool was listed with its schema', gen !== undefined && gen.inputJSONSchema !== undefined)
    const call = (args: Record<string, unknown>) =>
      callMCPToolWithUrlElicitationRetry({ client: connection, tool: 'gen', args, toolDefinition: { name: 'gen', inputSchema: gen?.inputJSONSchema } as never, signal: new AbortController().signal })
        .then(result => `ok ${JSON.stringify(result.content)}`, (error: Error) => `refused: ${error.message}`)
    const top = await call({ prompt: 'castle', ref: null })
    check('a top-level null optional is accepted', top.startsWith('ok'), top)
    const inner = await call({ prompt: 'castle', opts: { seed: null, style: 'oil' }, layers: [{ name: 'sky', mask: null }] })
    check('a nested null optional is accepted — the server never saw it', inner.startsWith('ok') && !inner.includes('null'), inner)
  }
} finally {
  await clearServerCache('strict-args', config)
}

console.log(`\n${failures === 0 ? '✅ null optionals never reach an MCP server — PROVEN' : `❌ ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
