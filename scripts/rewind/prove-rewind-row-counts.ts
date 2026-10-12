#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'rewind-rows-home-'))

const { statsBetween } = await import('../../src/components/MessageSelector.tsx')

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
  prompt('p4', 'the current prompt'),
] as never[]

console.log('── the rewind list row counts what the turn changed ──')
const changeSet = statsBetween(messages, 'p1', 'p2')
check('a ChangeSet turn counts its three files and +6 -6 (RED on the base: "no code changes")', changeSet.files.length === 3 && changeSet.insertions === 6 && changeSet.deletions === 6, JSON.stringify(changeSet))
check('…naming the files the change set wrote', JSON.stringify([...changeSet.files].sort()) === JSON.stringify(['invoice.py', 'orders.py', 'report.py']), JSON.stringify(changeSet.files))
const preview = statsBetween(messages, 'p2', 'p3')
check('a ChangeSet preview wrote nothing and counts nothing', preview.files.length === 0 && preview.insertions === 0 && preview.deletions === 0, JSON.stringify(preview))
const created = statsBetween(messages, 'p3', 'p4')
check('a created three-line file counts three lines, not four (RED on the base: the newline-terminated file counted a phantom fourth line)', created.files.length === 2 && created.insertions === 4 && created.deletions === 1, JSON.stringify(created))

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
