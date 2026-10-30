#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'mcp-null-optionals-'))
process.env.NODE_ENV = 'test'

const { withoutNullOptionals } = await import('../../src/services/mcp/client.ts')

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

console.log(`\n${failures === 0 ? '✅ null optionals never reach an MCP server — PROVEN' : `❌ ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
