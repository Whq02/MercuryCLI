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
check('the prompt says readiness is an array of condition objects with a worked example', /readiness: an array of condition objects, e\.g\. \[\{kind:"tcp",port:3000\}\]/.test(prompt), prompt.slice(0, 600))
const schema = ServiceTool.inputSchema as { shape: Record<string, { description?: string }> }
const readiness = schema.shape.readiness?.description ?? ''
check('the schema field says array and shows the bracketed shape', /an array of condition objects/.test(readiness) && readiness.includes('[{"kind":"tcp","port":3000}]'), readiness)
const parsed = (ServiceTool.inputSchema as { safeParse(v: unknown): { success: boolean } }).safeParse({ op: 'start', name: 'web', command: 'node', args: [], readiness: { kind: 'tcp', port: 3000 } })
check('a bare condition object (not an array) is still refused by the schema', parsed.success === false)

console.log(failures === 0 ? 'PASS: the Service readiness words say array' : `FAIL: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
