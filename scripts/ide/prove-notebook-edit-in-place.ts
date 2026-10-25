#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
process.chdir(ROOT)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'notebook-edit-')))

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const clip = (text: string, limit = 400): string => JSON.stringify(text.length > limit ? `${text.slice(0, limit)}…` : text)

const { NotebookEditTool } = await import('../../src/tools/NotebookEditTool/NotebookEditTool.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')

let appState = getDefaultAppState()
const readFileState = new Map<string, { content: string; timestamp: number; offset?: number; limit?: number }>()
const context = {
  options: { commands: [], verbose: false, engineModel: 'claude-sonnet-5', tools: [], mcpClients: [], mcpResources: {}, isNonInteractiveSession: true },
  abortController: new AbortController(),
  readFileState,
  getAppState: () => appState,
  setAppState: (update: (state: typeof appState) => typeof appState) => { appState = update(appState) },
  messages: [],
  updateFileHistoryState: () => undefined,
  updateAttributionState: () => undefined,
  toolUseId: 'notebook-edit',
} as never
const parent = { uuid: '00000000-0000-4000-8000-000000000001', type: 'assistant', message: { role: 'assistant', content: [] } } as never

type Input = { notebook_path: string; cell_id?: string; new_source: string; cell_type?: 'code' | 'markdown'; edit_mode?: 'replace' | 'insert' | 'delete' }
type Result = { before: string; after: string; result: string; data: Record<string, unknown> }
let counter = 0
async function edit(fileText: string, input: Omit<Input, 'notebook_path'>): Promise<Result> {
  const path = join(SCRATCH, `nb-${++counter}.ipynb`)
  writeFileSync(path, fileText)
  readFileState.set(path, { content: fileText, timestamp: statSync(path).mtimeMs })
  const validation = await NotebookEditTool.validateInput({ notebook_path: path, ...input } as never, context)
  if (validation.result === false) throw new Error(`validateInput refused: ${validation.message}`)
  const out = await NotebookEditTool.call({ notebook_path: path, ...input } as never, context, undefined as never, parent)
  const data = out.data as Record<string, unknown>
  const block = NotebookEditTool.mapToolResultToToolResultBlockParam(out.data as never, 'notebook-edit') as { content: string }
  return { before: fileText, after: readFileSync(path, 'utf8'), result: block.content, data }
}
const lines = (text: string): string[] => text.split('\n')
function changedLines(before: string, after: string): { changed: number[]; removed: number[]; added: number[] } {
  const a = lines(before)
  const b = lines(after)
  const changed: number[] = []
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) changed.push(i + 1)
  return { changed, removed: a.slice(n).map((_, i) => n + i + 1), added: b.slice(n).map((_, i) => n + i + 1) }
}
const sameExcept = (before: string, after: string, keep: Set<number>): boolean => {
  const a = lines(before)
  const b = lines(after)
  if (a.length !== b.length) return false
  return a.every((line, i) => keep.has(i + 1) || line === b[i])
}
const parse = (text: string): { cells: Array<Record<string, unknown>>; [k: string]: unknown } => JSON.parse(text)
const sourceText = (source: unknown): string => (Array.isArray(source) ? source.join('') : String(source))

console.log('============================================================')
console.log(' NotebookEdit — a one-cell edit touches the cell\'s own line(s) and nothing else')
console.log('============================================================')

const AIR = `{
 "cells": [
  {"cell_type": "code", "execution_count": null, "id": "c1", "metadata": {}, "outputs": [], "source": ["x = 2\\n", "y = 3"]},
  {"cell_type": "code", "execution_count": null, "id": "c2", "metadata": {}, "outputs": [], "source": ["print(x + y)"]}
 ],
 "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"}, "language_info": {"name": "python"}},
 "nbformat": 4,
 "nbformat_minor": 5
}
`

section('§1 the Air\'s notebook (hand-formatted: one line per cell): replace one cell')
{
  const r = await edit(AIR, { cell_id: 'c2', edit_mode: 'replace', new_source: 'print(x * y)' })
  const delta = changedLines(r.before, r.after)
  console.log(`        changed lines ${JSON.stringify(delta)}; line 4 now ${clip(lines(r.after)[3] ?? '')}`)
  check('the file still parses and the edit landed', parse(r.after).cells[1]?.source !== undefined && JSON.stringify(parse(r.after).cells[1]?.source) === JSON.stringify(['print(x * y)']), clip(r.after))
  check("the diff touches only the cell's line", delta.changed.length === 1 && delta.changed[0] === 4 && delta.removed.length === 0 && delta.added.length === 0, JSON.stringify(delta))
  check('the list stays a list, on its one line, with the file\'s own separators', (lines(r.after)[3] ?? '').endsWith('"source": ["print(x * y)"]}'), clip(lines(r.after)[3] ?? ''))
  check('cell 1, the metadata and the trailing newline are byte-identical', sameExcept(r.before, r.after, new Set([4])) && r.after.endsWith('}\n'), clip(r.after))
  check('the model reads the same words as before', r.result === 'Updated cell c2 with print(x * y)', r.result)
  check('updated_file in the payload is what landed on disk', r.data.updated_file === r.after)
}

section('§2 the Air\'s notebook: a two-line source into the one-line list, mirroring its ", " separator')
{
  const r = await edit(AIR, { cell_id: 'c1', edit_mode: 'replace', new_source: 'x = 20\ny = 3' })
  const delta = changedLines(r.before, r.after)
  check('only line 3 changed', delta.changed.length === 1 && delta.changed[0] === 3 && delta.removed.length === 0 && delta.added.length === 0, JSON.stringify(delta))
  check('the source is the two-element list nbformat writes, on the one line', (lines(r.after)[2] ?? '').endsWith('"source": ["x = 20\\n", "y = 3"]},'), clip(lines(r.after)[2] ?? ''))
  check('parsed: the two lines joined read the new source', sourceText(parse(r.after).cells[0]?.source) === 'x = 20\ny = 3')
}

section('§3 the Air\'s notebook: insert and delete splice one cell line')
{
  const ins = await edit(AIR, { cell_id: 'c1', edit_mode: 'insert', cell_type: 'markdown', new_source: '# Title' })
  const after = lines(ins.after)
  const delta = changedLines(ins.before, ins.after)
  console.log(`        inserted line ${clip(after[3] ?? '')}`)
  const beforeLines = lines(ins.before)
  check('an insert after c1 adds exactly one line, after c1\'s line', after.length === beforeLines.length + 1 && after.slice(0, 3).join('\n') === beforeLines.slice(0, 3).join('\n') && after.slice(4).join('\n') === beforeLines.slice(3).join('\n'), JSON.stringify({ delta, after }))
  check('the new cell is one line in the sibling\'s layout (": " and ", ") with the id a 4.5 notebook gets', /^  \{"cell_type": "markdown", "id": "[a-z0-9]+", "source": \["# Title"\], "metadata": \{\}\},$/.test(after[3] ?? ''), clip(after[3] ?? ''))
  check('parsed: three cells, the markdown one second', parse(ins.after).cells.length === 3 && parse(ins.after).cells[1]?.cell_type === 'markdown' && sourceText(parse(ins.after).cells[1]?.source) === '# Title')
  check('the model reads the insert words', /^Inserted cell [a-z0-9]+ with # Title$/.test(ins.result), ins.result)
  const del = await edit(AIR, { cell_id: 'c2', edit_mode: 'delete', new_source: '' })
  const left = lines(del.after)
  check('a delete of c2 removes its line; c1\'s line loses the comma that joined them; nothing else moves', left.length === lines(del.before).length - 1 && left[2] === (lines(del.before)[2] ?? '').replace(/,$/, '') && left.slice(3).join('\n') === lines(del.before).slice(4).join('\n') && left.slice(0, 2).join('\n') === lines(del.before).slice(0, 2).join('\n'), clip(del.after))
  check('parsed: one cell left, c1 untouched', parse(del.after).cells.length === 1 && parse(del.after).cells[0]?.id === 'c1')
}

const nb = {
  cells: [
    { cell_type: 'markdown', id: 'm1', metadata: {}, source: ['# Notes\n', 'Some words.'] },
    { cell_type: 'code', execution_count: 3, id: 'k1', metadata: { tags: ['keep'] }, outputs: [{ name: 'stdout', output_type: 'stream', text: ['5\n'] }], source: ['x = 2\n', 'y = 3\n', 'print(x + y)'] },
    { cell_type: 'code', execution_count: null, id: 'k2', metadata: {}, outputs: [], source: [] },
  ],
  metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }, language_info: { name: 'python', version: '3.12.1' } },
  nbformat: 4,
  nbformat_minor: 5,
}
const JUPYTER = `${JSON.stringify(nb, null, 1)}\n`

section('§4 a Jupyter-written notebook (indent 1, one source line per list element): the cell\'s lines move, the rest stands')
{
  const r = await edit(JUPYTER, { cell_id: 'k1', edit_mode: 'replace', new_source: 'x = 2\ny = 3\nz = 4\nprint(x + y + z)' })
  const before = lines(r.before)
  const after = lines(r.after)
  const k1Start = before.findIndex(l => l.includes('"id": "k1"'))
  const k1Open = before.slice(0, k1Start).lastIndexOf('  {')
  const k1Close = before.findIndex((l, i) => i > k1Start && l === '  },')
  console.log(`        k1 occupies lines ${k1Open + 1}–${k1Close + 1} of ${before.length}; the file is now ${after.length} lines`)
  check('the line count moved by the source\'s one extra line and the nine-line outputs block collapsing to one', after.length === before.length + 1 - 8, `before ${before.length} after ${after.length}`)
  check('every line before the k1 cell is byte-identical', before.slice(0, k1Open).join('\n') === after.slice(0, k1Open).join('\n'))
  check('every line after the k1 cell is byte-identical (the tail shifted as one block)', before.slice(k1Close + 1).join('\n') === after.slice(after.length - (before.length - k1Close - 1)).join('\n'))
  const cell = parse(r.after).cells[1] as Record<string, unknown>
  check('the source is a per-line list at the file\'s own indent, the outputs cleared and the count reset in place', JSON.stringify(cell.source) === JSON.stringify(['x = 2\n', 'y = 3\n', 'z = 4\n', 'print(x + y + z)']) && cell.execution_count === null && JSON.stringify(cell.outputs) === '[]' && after.some(l => l === '    "z = 4\\n",'), clip(r.after.slice(0, 600)))
  check('the metadata tags of the cell survive', JSON.stringify((cell.metadata as Record<string, unknown>).tags) === '["keep"]')
  check('the trailing newline is kept', r.after.endsWith('}\n'))
}

section('§5 a Jupyter-written notebook: insert lands as a multi-line cell at the sibling\'s indent')
{
  const r = await edit(JUPYTER, { cell_id: 'm1', edit_mode: 'insert', cell_type: 'code', new_source: 'import os' })
  const before = lines(r.before)
  const after = lines(r.after)
  const m1Close = before.findIndex(l => l === '  },')
  check('the lines before the insertion point and after it are byte-identical', before.slice(0, m1Close + 1).join('\n') === after.slice(0, m1Close + 1).join('\n') && before.slice(m1Close + 1).join('\n') === after.slice(after.length - (before.length - m1Close - 1)).join('\n'))
  const inserted = after.slice(m1Close + 1, after.length - (before.length - m1Close - 1))
  console.log(`        inserted block:\n${inserted.map(l => `        │ ${l}`).join('\n')}`)
  check('the inserted block is one cell at the sibling\'s indent (2 spaces, properties at 3)', inserted[0] === '  {' && inserted.at(-1) === '  },' && inserted.slice(1, -1).every(l => l.startsWith('   ')), JSON.stringify(inserted))
  check('the new cell\'s source is a list like its siblings', JSON.stringify(parse(r.after).cells[1]?.source) === '["import os"]' && parse(r.after).cells[1]?.cell_type === 'code')
}

section('§6 a 2-space notebook with string sources: string stays string, indent 2 is kept whichever road writes')
{
  const twoSpace = `${JSON.stringify({ ...nb, cells: nb.cells.map(c => ({ ...c, source: (c.source as string[]).join('') })) }, null, 2)}\n`
  const r = await edit(twoSpace, { cell_id: 'k2', edit_mode: 'replace', new_source: 'print("hi")' })
  const delta = changedLines(r.before, r.after)
  check('one line changed', delta.changed.length === 1 && delta.removed.length === 0 && delta.added.length === 0, JSON.stringify(delta))
  check('the source stays a string', parse(r.after).cells[2]?.source === 'print("hi")')
  const bare = `${JSON.stringify({ ...nb, cells: [{ cell_type: 'code', id: 'b1', metadata: {}, source: 'a = 1' }] }, null, 2)}\n`
  const f = await edit(bare, { cell_id: 'b1', edit_mode: 'replace', new_source: 'a = 2' })
  console.log(`        the cell without outputs/execution_count keys takes the whole-file road: ${clip(f.after, 200)}`)
  check('a code cell lacking the keys the reset writes falls back to a whole-file write at the file\'s own indent (2), string source, trailing newline kept', (lines(f.after)[1] ?? '').startsWith('  "cells"') && parse(f.after).cells[0]?.source === 'a = 2' && parse(f.after).cells[0]?.execution_count === null && f.after.endsWith('}\n'), clip(f.after, 300))
}

section('§7 a compact single-line notebook and a CRLF notebook')
{
  const compactText = JSON.stringify(nb)
  const r = await edit(compactText, { cell_id: 'k2', edit_mode: 'replace', new_source: 'print(1)' })
  check('a single-line notebook stays a single line with no newline added', !r.after.includes('\n') && JSON.stringify(parse(r.after).cells[2]?.source) === '["print(1)"]', clip(r.after, 200))
  const crlf = JUPYTER.replace(/\n/g, '\r\n')
  const c = await edit(crlf, { cell_id: 'k2', edit_mode: 'replace', new_source: 'print(2)' })
  check('a CRLF notebook keeps CRLF on every line', !/[^\r]\n/.test(c.after) && c.after.endsWith('\r\n'), clip(c.after.slice(-80)))
  const deltaCrlf = changedLines(c.before.replace(/\r\n/g, '\n'), c.after.replace(/\r\n/g, '\n'))
  check('…and the edit touches the cell\'s source lines only', deltaCrlf.changed.length === 1 && deltaCrlf.removed.length === 0 && deltaCrlf.added.length === 0 && JSON.stringify(parse(c.after).cells[2]?.source) === '["print(2)"]', JSON.stringify(deltaCrlf))
}

section('§8 call() refuses an unknown or out-of-range cell_id itself — validation skipped (a //-shaped path) or stale, cell 0 is never the fallback')
{
  type Refusal = { data: Record<string, unknown>; effect: { outcome: string }; after: string; result: string }
  async function callOnly(fileText: string, pathOf: (path: string) => string, input: Omit<Input, 'notebook_path'>): Promise<Refusal> {
    const path = join(SCRATCH, `nb-${++counter}.ipynb`)
    writeFileSync(path, fileText)
    const spelled = pathOf(path)
    const validation = await NotebookEditTool.validateInput({ notebook_path: spelled, ...input } as never, context)
    if (validation.result === false) throw new Error(`validateInput refused: ${validation.message}`)
    const out = await NotebookEditTool.call({ notebook_path: spelled, ...input } as never, context, undefined as never, parent)
    const block = NotebookEditTool.mapToolResultToToolResultBlockParam(out.data as never, 'notebook-edit') as { content: string }
    return { data: out.data as Record<string, unknown>, effect: out.effect as { outcome: string }, after: readFileSync(path, 'utf8'), result: block.content }
  }
  const unc = (path: string): string => `/${path}`
  if (process.platform !== 'win32') {
    const del = await callOnly(AIR, unc, { cell_id: 'nope', edit_mode: 'delete', new_source: '' })
    check('delete of an unknown id through a //-shaped path (validation skipped) leaves the notebook byte-identical', del.after === AIR && parse(del.after).cells.length === 2, clip(del.after))
    check('…and answers the validation refusal, never "Deleted cell nope"', del.data.error === 'Cell with ID "nope" not found in notebook.' && del.effect.outcome === 'failed' && !/^Deleted/.test(del.result), JSON.stringify({ error: del.data.error, result: del.result }))
    const rep = await callOnly(AIR, unc, { cell_id: 'cell-7', edit_mode: 'replace', new_source: 'print(0)' })
    check('replace at an out-of-range index leaves the notebook byte-identical and names the index', rep.after === AIR && rep.data.error === 'Cell index 7 is out of range for this notebook.' && rep.effect.outcome === 'failed', JSON.stringify(rep.data.error))
    const missing = await callOnly(AIR, unc, { edit_mode: 'replace', new_source: 'print(0)' })
    check('replace with no cell_id leaves the notebook byte-identical and says the id is required', missing.after === AIR && missing.data.error === 'cell_id is required for edit_mode=replace and edit_mode=delete.', JSON.stringify(missing.data.error))
    const byIndex = await callOnly(AIR, unc, { cell_id: 'cell-1', edit_mode: 'replace', new_source: 'print(9)' })
    check('control: a valid positional id still edits that cell through the same road', sourceText(parse(byIndex.after).cells[1]?.source) === 'print(9)' && byIndex.data.error === '' && byIndex.effect.outcome === 'succeeded', clip(byIndex.after))
  }
  const path = join(SCRATCH, `nb-${++counter}.ipynb`)
  writeFileSync(path, AIR)
  const stale = await NotebookEditTool.call({ notebook_path: path, cell_id: 'gone', edit_mode: 'delete', new_source: '' } as never, context, undefined as never, parent)
  check('a cell id that vanished after validation (call() alone) deletes nothing', readFileSync(path, 'utf8') === AIR && (stale.data as Record<string, unknown>).error === 'Cell with ID "gone" not found in notebook.', clip(readFileSync(path, 'utf8')))
}

section('§9 a cell_type change carries the nbformat-4 fields of its new type')
{
  const toCode = await edit(JUPYTER, { cell_id: 'm1', edit_mode: 'replace', cell_type: 'code', new_source: 'x = 1' })
  const codeCell = parse(toCode.after).cells[0] as Record<string, unknown>
  check('markdown → code gains outputs [] and execution_count null', codeCell.cell_type === 'code' && JSON.stringify(codeCell.outputs) === '[]' && codeCell.execution_count === null && sourceText(codeCell.source) === 'x = 1', JSON.stringify(codeCell))
  const toMarkdown = await edit(JUPYTER, { cell_id: 'k1', edit_mode: 'replace', cell_type: 'markdown', new_source: '# Was code' })
  const mdCell = parse(toMarkdown.after).cells[1] as Record<string, unknown>
  check('code → markdown drops outputs and execution_count (nbformat forbids them on a markdown cell)', mdCell.cell_type === 'markdown' && !('outputs' in mdCell) && !('execution_count' in mdCell) && sourceText(mdCell.source) === '# Was code', JSON.stringify(mdCell))
  check('…and keeps the cell metadata', JSON.stringify((mdCell.metadata as Record<string, unknown>).tags) === '["keep"]')
}

rmSync(SCRATCH, { recursive: true, force: true })
rmSync(process.env.MERCURY_CONFIG_DIR as string, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL NOTEBOOK-EDIT PROOFS PASS' : `\n${failures} NOTEBOOK-EDIT PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
