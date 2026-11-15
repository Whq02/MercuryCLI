#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'rewind-rows-home-'))

const { statsBetween } = await import('../../src/components/MessageSelector.tsx')
const { isSqliteRowTarget } = await import('../../src/tools/FileWriteTool/structuredTargets.ts')

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const prompt = (uuid: string, text: string) => ({ type: 'user', uuid, message: { role: 'user', content: text } })
const toolResult = (uuid: string, toolUseResult: unknown) => ({
  type: 'user',
  uuid,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${uuid}`, content: 'ok' }] },
  toolUseResult,
})

const editPatch = [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-old line', '+new line'] }]
const changeSetApplied = {
  op: 'apply',
  result: 'Applied plan cs-1 — 3 file(s), 6 hunk(s), verified by reread.',
  outcome: 'succeeded',
  planId: 'cs-1',
  changeView: {
    state: 'applied',
    action: 'changeset',
    files: [
      { file: 'orders.py', hunks: [], changedLines: 4, added: 2, removed: 2 },
      { file: 'invoice.py', hunks: [], changedLines: 4, added: 2, removed: 2 },
      { file: 'report.py', hunks: [], changedLines: 4, added: 2, removed: 2 },
    ],
    hunkCount: 6,
    planMeta: { id: 'cs-1', digest12: 'abcdefabcdef', ageMs: 1, expiresInMs: 1000 },
    refs: [],
  },
}
const changeSetPreview = { ...changeSetApplied, op: 'preview', outcome: 'succeeded', changeView: { ...changeSetApplied.changeView, state: 'prepared' } }

const messages = [
  prompt('p1', 'rename get_total in three files with one ChangeSet'),
  toolResult('r1', changeSetApplied),
  prompt('p2', 'preview only'),
  toolResult('r2', changeSetPreview),
  prompt('p3', 'create the guide and fix crlf'),
  toolResult('r3', { type: 'create', filePath: '/w/docs/guide/intro.md', content: '# Intro\n\nThis guide explains how to get started.\n', structuredPatch: [] }),
  toolResult('r4', { filePath: '/w/crlf.txt', structuredPatch: editPatch }),
  prompt('p4', 'write two rows of a database'),
  toolResult('r5', { type: 'update', filePath: '/w/rows.sqlite:items/2', content: '{\n  "id": 2,\n  "value": "TWO"\n}\n', structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-  "value": "two"', '+  "value": "TWO"'] }] }),
  toolResult('r6', { type: 'create', filePath: 'C:\\src\\proj\\rows.sqlite:items/9', content: '{\n  "id": 9,\n  "value": "nine"\n}\n', structuredPatch: [] }),
  prompt('p5', 'a row and a file in one turn'),
  toolResult('r7', { type: 'create', filePath: '/w/rows.sqlite:items/id=10', content: '{\n  "id": 10\n}\n', structuredPatch: [] }),
  toolResult('r8', { filePath: '/w/notes.sqlite.md', structuredPatch: editPatch }),
  prompt('p6', 'a write that moves a row to a key the address grammar refuses'),
  toolResult('r9', { type: 'update', filePath: "/w/rows.sqlite:items/slug=o'reilly", content: '{\n  "slug": "o\'reilly"\n}\n', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-  "slug": "plain"', '+  "slug": "o\'reilly"'] }] }),
  prompt('p7', 'the current prompt'),
] as never[]

console.log('── the rewind list row counts what the turn changed ──')
const changeSet = statsBetween(messages, 'p1', 'p2')
check('a ChangeSet turn counts its three files and +6 -6 (RED on the base: "no code changes")', changeSet.files.length === 3 && changeSet.insertions === 6 && changeSet.deletions === 6, JSON.stringify(changeSet))
check('…naming the files the change set wrote', JSON.stringify([...changeSet.files].sort()) === JSON.stringify(['invoice.py', 'orders.py', 'report.py']), JSON.stringify(changeSet.files))
const preview = statsBetween(messages, 'p2', 'p3')
check('a ChangeSet preview wrote nothing and counts nothing', preview.files.length === 0 && preview.insertions === 0 && preview.deletions === 0, JSON.stringify(preview))
const created = statsBetween(messages, 'p3', 'p4')
check('a created three-line file counts three lines, not four (RED on the base: the newline-terminated file counted a phantom fourth line)', created.files.length === 2 && created.insertions === 4 && created.deletions === 1, JSON.stringify(created))
const rows = statsBetween(messages, 'p4', 'p5')
check('a turn that only wrote rows of a SQLite database counts no code change: a rewind restores no row, and the row was shown as a file named by its key', rows.files.length === 0 && rows.insertions === 0 && rows.deletions === 0, JSON.stringify(rows))
const mixed = statsBetween(messages, 'p5', 'p6')
check('a row and a file written in one turn count the file alone, a file whose name merely holds .sqlite among them', JSON.stringify(mixed.files) === JSON.stringify(['/w/notes.sqlite.md']) && mixed.insertions === 1 && mixed.deletions === 1, JSON.stringify(mixed))
const moved = statsBetween(messages, 'p6', 'p7')
check('a write that moved a row to a key holding a quote counts no code change either: the address the result carries is one the grammar would refuse to write to', moved.files.length === 0 && moved.insertions === 0 && moved.deletions === 0, JSON.stringify(moved))
const rowAddresses = ['/w/rows.sqlite:items/2', 'C:\\src\\proj\\rows.sqlite:items/id=10', "/w/rows.sqlite:items/slug=o'reilly", '/w/rows.db:items/name=this and that', '/w/rows.sqlite:items/3#delete']
const notRows = ['/w/rows.sqlite', '/w/rows.sqlite:items', '/w/notes.sqlite.md', '/w/archive.zip:inside.txt', '/w/x.db/file.ts', 'ssh://box/w/rows.txt', '/w/rows.sqlite:bad-table/2']
check('every address a row write reports reads as a row, and nothing a rewind restores does', rowAddresses.every(path => isSqliteRowTarget(path)) && notRows.every(path => !isSqliteRowTarget(path)), JSON.stringify({ rows: rowAddresses.map(path => isSqliteRowTarget(path)), others: notRows.map(path => isSqliteRowTarget(path)) }))

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
