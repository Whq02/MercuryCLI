#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'service-words-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = join(import.meta.dir, '..', '..')
const { ServiceTool } = await import(join(ROOT, 'src/tools/ServiceTool/ServiceTool.ts'))

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const prompt = await ServiceTool.prompt({} as never)
check('the description names process observations without a second schema or sibling tool', prompt.includes('current state and cursored output') && !/Operations:|Bash|Inspect|readiness:/.test(prompt) && Buffer.byteLength(prompt) <= 250, prompt)
const schema = ServiceTool.inputSchema as { shape: Record<string, { description?: string }> }
const readiness = schema.shape.readiness?.description ?? ''
check('the readiness field names each condition with its default, without worked examples or a copied union', readiness === 'start: readiness conditions — log regex · tcp port (host 127.0.0.1) · http url (GET, status 200) · file path · stable ms (the process alive that long).', readiness)
const { zodToJsonSchema } = await import('../../src/utils/zodToJsonSchema.ts')
const field = (zodToJsonSchema(ServiceTool.inputSchema) as any).properties.readiness
check('the schema itself owns the readiness array and five variants', field.type === 'array' && field.maxItems === 8 && field.items.anyOf.length === 5)
const parsed = (ServiceTool.inputSchema as { safeParse(v: unknown): { success: boolean } }).safeParse({ op: 'start', name: 'web', command: 'node', args: [], readiness: { kind: 'tcp', port: 3000 } })
check('a bare condition object (not an array) is still refused by the schema', parsed.success === false)

console.log(failures === 0 ? 'PASS: the Service readiness words say array' : `FAIL: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
