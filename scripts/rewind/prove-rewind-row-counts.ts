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

console.log('\n── rewind list and card after shell commands ──')
{
  const React = await import('react')
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync: mkTmp, readFileSync, rmSync, writeFileSync } = await import('node:fs')
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
  const { MessageSelector } = await import('../../src/components/MessageSelector.tsx')
  const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.ts')
  const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
  const { mountOffscreen, waitFor } = await import('../lib/settingsPopupHarness.ts')

  const workDir = mkTmp(join(tmpdir(), 'rewind-shell-'))
  const targetFile = join(workDir, 'note.txt')
  writeFileSync(targetFile, 'before\n', 'utf8')
  const shellCmd = `echo x >> ${JSON.stringify(targetFile)}`
  execFileSync('/bin/sh', ['-c', shellCmd])

  const userMsg = (uuid: string, text: string) => ({
    type: 'user',
    uuid,
    timestamp: new Date(1_700_000_000_000).toISOString(),
    message: { role: 'user', content: text },
  })
  const assistantTool = (uuid: string, name: string, input: Record<string, unknown>) => ({
    type: 'assistant',
    uuid,
    timestamp: new Date(1_700_000_001_000).toISOString(),
    message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${uuid}`, name, input }] },
  })

  const shellMutateMsgs = [
    userMsg('u-mut-1', 'append x through bash'),
    assistantTool('a-mut-1', 'Bash', { command: shellCmd }),
    toolResult('tr-mut-1', { stdout: '', stderr: '' }),
  ] as never[]

  const shellReadOnlyMsgs = [
    userMsg('u-ro-1', 'read the note through bash'),
    assistantTool('a-ro-1', 'Bash', { command: `cat ${JSON.stringify(targetFile)}` }),
    toolResult('tr-ro-1', { stdout: 'before\nx\n', stderr: '' }),
  ] as never[]

  const plainMsgs = [
    userMsg('u-plain-1', 'just answer in words'),
    {
      type: 'assistant',
      uuid: 'a-plain-1',
      timestamp: new Date(1_700_000_001_000).toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    },
  ] as never[]

  const psMutateMsgs = [
    userMsg('u-ps-1', 'write through powershell'),
    assistantTool('a-ps-1', 'PowerShell', { command: 'Set-Content note.txt hi' }),
    toolResult('tr-ps-1', { stdout: '', stderr: '' }),
  ] as never[]

  const mountSelector = async (msgs: never[], preselect?: never, restorableIds: string[] = []): Promise<string> => {
    const facts = { capture: 'on' as const, restorable: new Set(restorableIds), files: [] }
    const base = noSessionConnector()
    const conn = Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
      checkpointFacts: () => facts,
      subscribeCheckpoints: () => () => {},
      rewind: async () => ({ outcome: 'applied' as const, mode: 'code' as const, code: { filesChanged: [], insertions: 0, deletions: 0 } }),
    })
    setFocusedSessionConnector(conn)
    try {
      const m = await mountOffscreen(
        React.createElement(
          ThemeProvider,
          { initialState: 'dark' },
          React.createElement(MessageSelector, {
            messages: msgs,
            ...(preselect !== undefined ? { preselectedMessage: preselect } : {}),
            onPreRestore: () => {},
            onRestore: async () => ({ outcome: 'applied', mode: 'both', code: { filesChanged: [], insertions: 0, deletions: 0 } }),
            onSummarize: () => {},
            onClose: () => {},
          }),
        ),
        120,
        24,
      )
      if (preselect !== undefined) {
        await waitFor(() => !m.screen().includes('Asking the session what a restore would touch'), 2000)
        await new Promise(r => setTimeout(r, 120))
      } else {
        await waitFor(() => m.screen().includes('Rewind'), 2000)
        await new Promise(r => setTimeout(r, 150))
      }
      const screen = m.screen()
      m.unmount()
      return screen
    } finally {
      releaseFocusedSessionConnector(conn)
    }
  }

  try {
    const mutList = await mountSelector(shellMutateMsgs, undefined, ['u-mut-1'])
    const mutCard = await mountSelector(shellMutateMsgs, shellMutateMsgs[0], ['u-mut-1'])
    check(
      'rewind list row after mutating Bash command does not say "no code changes" and states shell changes are not put back',
      !mutList.includes('no code changes') && mutList.includes('1 shell command ran — changes it made are not put back'),
      mutList.slice(0, 500),
    )
    check(
      'rewind confirm card after mutating Bash command does not say "The files already match this point." and states shell changes are not put back',
      !mutCard.includes('The files already match this point.') &&
        mutCard.includes('No Edit or Write changes to restore; shell commands ran after this point and what they changed is not put back.'),
      mutCard.slice(0, 600),
    )
    check('the file written by Bash still holds the shell change on disk', readFileSync(targetFile, 'utf8') === 'before\nx\n')

    const roList = await mountSelector(shellReadOnlyMsgs, undefined, ['u-ro-1'])
    const roCard = await mountSelector(shellReadOnlyMsgs, shellReadOnlyMsgs[0], ['u-ro-1'])
    check('control: read-only Bash command still lists "no code changes"', roList.includes('no code changes'), roList.slice(0, 500))
    check('control: read-only Bash command confirm card still says "The files already match this point."', roCard.includes('The files already match this point.'), roCard.slice(0, 600))

    const plainList = await mountSelector(plainMsgs, undefined, ['u-plain-1'])
    const plainCard = await mountSelector(plainMsgs, plainMsgs[0], ['u-plain-1'])
    check('control: turn with no shell command still lists "no code changes"', plainList.includes('no code changes'), plainList.slice(0, 500))
    check('control: turn with no shell command confirm card still says "The files already match this point."', plainCard.includes('The files already match this point.'), plainCard.slice(0, 600))

    const psList = await mountSelector(psMutateMsgs, undefined, ['u-ps-1'])
    const psCard = await mountSelector(psMutateMsgs, psMutateMsgs[0], ['u-ps-1'])
    check(
      'rewind list and card after mutating PowerShell command state shell changes are not put back',
      !psList.includes('no code changes') &&
        psList.includes('1 shell command ran — changes it made are not put back') &&
        !psCard.includes('The files already match this point.') &&
        psCard.includes('No Edit or Write changes to restore; shell commands ran after this point and what they changed is not put back.'),
      `list=${psList.slice(0, 250)} card=${psCard.slice(0, 250)}`,
    )
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
