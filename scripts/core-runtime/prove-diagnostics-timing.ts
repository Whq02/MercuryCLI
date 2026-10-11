#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'diagnostics-timing-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { withDiagnosticsTiming } = await import('../../src/utils/diagLogs.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const rejection = async (run: () => Promise<unknown>): Promise<unknown> => run().then(() => undefined, error => error)

console.log('the timed bracket')
const answer = { rows: 3 }
check('the operation\'s result is answered by identity', (await withDiagnosticsTiming('proof_op', async () => answer)) === answer)
const seen: unknown[] = []
await withDiagnosticsTiming('proof_op', async () => answer, result => { seen.push(result); return { rows: result.rows } })
check('the data reader is asked once, with the result', seen.length === 1 && seen[0] === answer)
let settled = false
const late = await withDiagnosticsTiming('proof_op', () => new Promise<string>(resolve => setTimeout(() => { settled = true; resolve('late') }, 20)))
check('the operation is awaited to its end', settled && late === 'late')

console.log('the failures')
const boom = new Error('boom')
check('a rejection is rethrown as the same error', (await rejection(() => withDiagnosticsTiming('proof_op', () => Promise.reject(boom)))) === boom)
check('a synchronous throw of the operation is rethrown as the same error', (await rejection(() => withDiagnosticsTiming('proof_op', () => { throw boom }))) === boom)
const readerBoom = new Error('reader')
check('a throw of the data reader is rethrown as the same error', (await rejection(() => withDiagnosticsTiming('proof_op', async () => 1, () => { throw readerBoom }))) === readerBoom)

console.log(failures ? `FAIL diagnostics timing: ${failures} failures` : 'PASS diagnostics timing')
process.exit(failures ? 1 : 0)
