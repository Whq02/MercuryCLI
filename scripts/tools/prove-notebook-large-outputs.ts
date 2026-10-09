#!/usr/bin/env bun
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const { readNotebook } = await import(join(SRC, 'utils/notebook.ts'))

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const scratch = mkdtempSync(join(tmpdir(), 'notebook-large-outputs-'))
const stream = (text: string) => ({ output_type: 'stream', name: 'stdout', text })
const picture = (bytes: number) => ({ output_type: 'display_data', data: { 'image/png': 'A'.repeat(bytes) } })
const code = (id: string, outputs: unknown[]) => ({ id, cell_type: 'code', source: [`print(${JSON.stringify(id)})`], execution_count: 1, outputs })
const notebook = {
  metadata: { language_info: { name: 'python' } },
  cells: [
    code('small', [stream('x'.repeat(4000)), stream('y'.repeat(6000))]),
    code('over', [stream('x'.repeat(4000)), stream('y'.repeat(6001))]),
    code('pictured', [stream('x'.repeat(5000)), picture(5001)]),
    code('holey', [stream('x'.repeat(9000)), { output_type: 'unknown_kind' }, stream('y'.repeat(1000))]),
  ],
}
const path = join(scratch, 'cells.ipynb')
writeFileSync(path, JSON.stringify(notebook))
try {
  const cells = await readNotebook(path)
  const outputs = (id: string) => cells.find((c: { cell_id: string }) => c.cell_id === id)?.outputs ?? []
  const placeholder = (rows: Array<{ text?: string }>) => rows.length === 1 && String(rows[0]?.text).startsWith('Outputs are too large to include.')
  check('outputs totalling exactly the threshold stay', outputs('small').length === 2 && !placeholder(outputs('small')))
  check('one character over the threshold replaces the outputs with the pointer', placeholder(outputs('over')), JSON.stringify(outputs('over')).slice(0, 120))
  check('image bytes count toward the total', placeholder(outputs('pictured')))
  check('an output of an unknown kind weighs nothing and leaves a hole', outputs('holey').length === 3 && outputs('holey')[1] === undefined && !placeholder(outputs('holey')), JSON.stringify(outputs('holey')).slice(0, 120))
  const named = await readNotebook(path, 'over')
  check('a cell read by id keeps its large outputs', named.length === 1 && named[0].outputs?.length === 2 && !placeholder(named[0].outputs))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(failures ? `FAIL notebook large outputs: ${failures} failures` : 'PASS notebook large outputs')
process.exit(failures ? 1 : 0)
