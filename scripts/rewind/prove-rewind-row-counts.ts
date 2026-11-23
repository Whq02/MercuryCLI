#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'bun:test'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'rewind-rows-home-'))

const SRC = join(import.meta.dir, '..', '..', 'src')
const realShellToolUtils = await import(join(SRC, 'tools', 'kit', 'shellTools.ts'))
let psToolOffered = true
mock.module(join(SRC, 'tools', 'kit', 'shellTools.js'), () => ({
  ...realShellToolUtils,
  isPowerShellToolEnabled: () => psToolOffered,
}))

const { statsBetween } = await import('../../src/screen/rewind-picker/RewindPicker.tsx')
const { isSqliteRowTarget } = await import('../../src/tools/write/structuredTargets.ts')

let failures = 0
let checks = 0
let rowCountsHint = 'change statsBetween in src/screen/rewind-picker/stats.ts or isSqliteRowTarget in src/tools/write/structuredTargets.ts'
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  const shown = !ok ? `${detail}${detail ? ' | ' : ''}${rowCountsHint}` : detail
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && shown ? ` — ${shown}` : ''}`)
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
rowCountsHint = 'the list row text and the confirm card text are built in src/screen/rewind-picker/views.tsx and the shell-command counts in src/screen/rewind-picker/stats.ts'
{
  const React = await import('react')
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync: mkTmp, readFileSync, rmSync, writeFileSync } = await import('node:fs')
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
  enableConfigs()
  const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.tsx')
  const { MessageSelector } = await import('../../src/screen/rewind-picker/RewindPicker.tsx')
  const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/engine/connector/focusedConnector.ts')
  const { noSessionConnector } = await import('../../src/engine/connector/noSessionConnector.ts')
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

  const psReadOnlyMsgs = [
    userMsg('u-ps-ro-1', 'read a.txt through powershell'),
    assistantTool('a-ps-ro-1', 'PowerShell', { command: 'Get-Content a.txt' }),
    toolResult('tr-ps-ro-1', { stdout: 'hello\n', stderr: '' }),
  ] as never[]

  const psRemoveMsgs = [
    userMsg('u-ps-rm-1', 'remove a.txt through powershell'),
    assistantTool('a-ps-rm-1', 'PowerShell', { command: 'Remove-Item a.txt' }),
    toolResult('tr-ps-rm-1', { stdout: '', stderr: '' }),
  ] as never[]

  const psRedirectMsgs = [
    userMsg('u-ps-redir-1', 'redirect get-content through powershell'),
    assistantTool('a-ps-redir-1', 'PowerShell', { command: 'Get-Content a.txt > out.txt' }),
    toolResult('tr-ps-redir-1', { stdout: '', stderr: '' }),
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
            onRestore: async () => ({ outcome: 'applied' as const, mode: 'both' as const, code: { filesChanged: [], insertions: 0, deletions: 0 } }),
            onSummarize: () => {},
            onClose: () => {},
          }),
        ),
        120,
        24,
      )
      if (preselect !== undefined) {
        await waitFor(() => {
          const screen = m.screen()
          return screen.includes('Restore ') && !screen.includes('Asking the session what a restore would touch')
        }, 2000)
        await new Promise(r => setTimeout(r, 120))
      } else {
        await waitFor(() => m.screen().includes('Rewind'), 2000)
        await new Promise(r => setTimeout(r, 150))
      }
      const screen = m.screen()
      m.unmount()
      return screen
    } finally {
      releaseFocusedSessionConnector()
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

    const psRoList = await mountSelector(psReadOnlyMsgs, undefined, ['u-ps-ro-1'])
    const psRoCard = await mountSelector(psReadOnlyMsgs, psReadOnlyMsgs[0], ['u-ps-ro-1'])
    check(
      'read-only PowerShell command lists "no code changes" and confirm card says "The files already match this point."',
      psRoList.includes('no code changes') &&
        !psRoList.includes('shell command ran') &&
        psRoCard.includes('The files already match this point.') &&
        !psRoCard.includes('shell commands ran after this point'),
      `list=${psRoList.slice(0, 250)} card=${psRoCard.slice(0, 250)}`,
    )

    const psRmList = await mountSelector(psRemoveMsgs, undefined, ['u-ps-rm-1'])
    const psRedirList = await mountSelector(psRedirectMsgs, undefined, ['u-ps-redir-1'])
    const psRedirCard = await mountSelector(psRedirectMsgs, psRedirectMsgs[0], ['u-ps-redir-1'])
    check(
      'Remove-Item and redirected PowerShell commands still report shell changes are not put back',
      !psRmList.includes('no code changes') &&
        psRmList.includes('1 shell command ran — changes it made are not put back') &&
        !psRedirList.includes('no code changes') &&
        psRedirList.includes('1 shell command ran — changes it made are not put back') &&
        !psRedirCard.includes('The files already match this point.') &&
        psRedirCard.includes('No Edit or Write changes to restore; shell commands ran after this point and what they changed is not put back.'),
      `rm=${psRmList.slice(0, 200)} redir=${psRedirList.slice(0, 200)}`,
    )

    for (const [id, cmd] of [
      ['group-rm', 'Get-Content (Remove-Item y.txt -PassThru)'],
      ['array-rm', 'Get-Content @(Remove-Item y.txt)'],
      ['group-new', 'Test-Path (New-Item x.txt -ItemType File)'],
      ['bg-rm', 'Get-Content a.txt & Remove-Item b.txt'],
    ] as const) {
      const msgs = [
        userMsg(`u-ps-${id}`, `run ${cmd}`),
        assistantTool(`a-ps-${id}`, 'PowerShell', { command: cmd }),
        toolResult(`tr-ps-${id}`, { stdout: '', stderr: '' }),
      ] as never[]
      const list = await mountSelector(msgs, undefined, [`u-ps-${id}`])
      const card = await mountSelector(msgs, msgs[0], [`u-ps-${id}`])
      check(
        `PowerShell command with nested or background execution (${cmd}) reports shell changes are not put back on list and card`,
        !list.includes('no code changes') &&
          list.includes('1 shell command ran — changes it made are not put back') &&
          !card.includes('The files already match this point.') &&
          card.includes('No Edit or Write changes to restore; shell commands ran after this point and what they changed is not put back.'),
        `list=${list.slice(0, 200)} card=${card.slice(0, 200)}`,
      )
    }

    for (const [id, cmd] of [
      ['pipe', 'Get-ChildItem -Recurse | Select-String foo'],
      ['merge-err', 'Get-Content a.txt 2>&1'],
    ] as const) {
      const msgs = [
        userMsg(`u-ps-ctl-${id}`, `run ${cmd}`),
        assistantTool(`a-ps-ctl-${id}`, 'PowerShell', { command: cmd }),
        toolResult(`tr-ps-ctl-${id}`, { stdout: '', stderr: '' }),
      ] as never[]
      const list = await mountSelector(msgs, undefined, [`u-ps-ctl-${id}`])
      const card = await mountSelector(msgs, msgs[0], [`u-ps-ctl-${id}`])
      check(
        `control: read-only PowerShell command (${cmd}) still lists "no code changes" and matches card`,
        list.includes('no code changes') &&
          !list.includes('shell command ran') &&
          card.includes('The files already match this point.') &&
          !card.includes('shell commands ran after this point'),
        `list=${list.slice(0, 200)} card=${card.slice(0, 200)}`,
      )
    }

    for (const [id, cmd] of [
      ['null-err', 'Get-Content a.txt 2>$null'],
      ['null-out', 'Get-Content a.txt > $null'],
      ['null-all', 'Get-Content a.txt *>$null'],
    ] as const) {
      const msgs = [
        userMsg(`u-ps-${id}`, `run ${cmd}`),
        assistantTool(`a-ps-${id}`, 'PowerShell', { command: cmd }),
        toolResult(`tr-ps-${id}`, { stdout: '', stderr: '' }),
      ] as never[]
      const list = await mountSelector(msgs, undefined, [`u-ps-${id}`])
      const card = await mountSelector(msgs, msgs[0], [`u-ps-${id}`])
      check(
        `PowerShell read redirected to $null (${cmd}) reads "no code changes" and matches card`,
        list.includes('no code changes') &&
          !list.includes('shell command ran') &&
          card.includes('The files already match this point.') &&
          !card.includes('shell commands ran after this point'),
        `list=${list.slice(0, 200)} card=${card.slice(0, 200)}`,
      )
    }

    for (const [id, cmd] of [
      ['null-then-rm', 'Get-Content a.txt 2>$null; Remove-Item b.txt'],
      ['nullx', 'Get-Content a.txt > $nullx'],
      ['comment-quote-rm', "Get-Content a.txt # don't\nRemove-Item b.txt # isn't"],
      ['ext-cmd', 'Get-Content.cmd a.txt'],
      ['ext-exe', 'cat.exe a.txt'],
    ] as const) {
      const msgs = [
        userMsg(`u-ps-${id}`, `run ${cmd}`),
        assistantTool(`a-ps-${id}`, 'PowerShell', { command: cmd }),
        toolResult(`tr-ps-${id}`, { stdout: '', stderr: '' }),
      ] as never[]
      const list = await mountSelector(msgs, undefined, [`u-ps-${id}`])
      const card = await mountSelector(msgs, msgs[0], [`u-ps-${id}`])
      check(
        `PowerShell command (${cmd}) still reports shell changes are not put back on list and card`,
        !list.includes('no code changes') &&
          list.includes('1 shell command ran — changes it made are not put back') &&
          !card.includes('The files already match this point.') &&
          card.includes('No Edit or Write changes to restore; shell commands ran after this point and what they changed is not put back.'),
        `list=${list.slice(0, 200)} card=${card.slice(0, 200)}`,
      )
    }

    psToolOffered = false
    try {
      const psUnlistedList = await mountSelector(psReadOnlyMsgs, undefined, ['u-ps-ro-1'])
      const psUnlistedCard = await mountSelector(psReadOnlyMsgs, psReadOnlyMsgs[0], ['u-ps-ro-1'])
      check(
        'when PowerShell tool is not offered by getAllBaseTools, a PowerShell call counts as a shell change',
        !psUnlistedList.includes('no code changes') &&
          psUnlistedList.includes('1 shell command ran — changes it made are not put back') &&
          !psUnlistedCard.includes('The files already match this point.') &&
          psUnlistedCard.includes('No Edit or Write changes to restore; shell commands ran after this point and what they changed is not put back.'),
        `list=${psUnlistedList.slice(0, 200)} card=${psUnlistedCard.slice(0, 200)}`,
      )
    } finally {
      psToolOffered = true
    }

    const { BashTool } = await import('../../src/tools/shell/BashTool.tsx')
    const mixedMsgs = [
      userMsg('u-pre-ro', 'check directory via bash'),
      assistantTool('a-pre-ro', 'Bash', { command: 'pwd' }),
      toolResult('tr-pre-ro', { stdout: workDir, stderr: '' }),
      userMsg('u-pre-mut', 'append y via bash'),
      assistantTool('a-pre-mut', 'Bash', { command: `echo y >> ${JSON.stringify(targetFile)}` }),
      toolResult('tr-pre-mut', { stdout: '', stderr: '' }),
    ] as never[]
    const facts = { capture: 'on' as const, restorable: new Set(['u-pre-ro', 'u-pre-mut']), files: [] }
    const baseConn = noSessionConnector()
    const conn = Object.assign(Object.create(Object.getPrototypeOf(baseConn)), baseConn, {
      checkpointFacts: () => facts,
      subscribeCheckpoints: () => () => {},
      rewind: async () => ({ outcome: 'applied' as const, mode: 'code' as const, code: { filesChanged: [], insertions: 0, deletions: 0 } }),
    })
    const origPrepare = BashTool.prepare
    const origIsReadOnly = BashTool.isReadOnly
    let releasePrepare!: () => void
    const holdPrepare = new Promise<void>(resolve => {
      releasePrepare = resolve
    })
    let isReadOnlyCalls = 0
    BashTool.prepare = async input => {
      await holdPrepare
      await origPrepare?.(input)
    }
    BashTool.isReadOnly = input => {
      isReadOnlyCalls += 1
      return origIsReadOnly(input)
    }
    setFocusedSessionConnector(conn)
    try {
      const m = await mountOffscreen(
        React.createElement(
          ThemeProvider,
          { initialState: 'dark' },
          React.createElement(MessageSelector, {
            messages: mixedMsgs,
            onPreRestore: () => {},
            onRestore: async () => ({ outcome: 'applied' as const, mode: 'both' as const, code: { filesChanged: [], insertions: 0, deletions: 0 } }),
            onSummarize: () => {},
            onClose: () => {},
          }),
        ),
        120,
        24,
      )
      await waitFor(() => m.screen().includes('check directory via bash'), 2000)
      const beforePass = m.screen()
      const callsBeforeSettle = isReadOnlyCalls
      releasePrepare()
      await waitFor(() => m.screen().includes('1 shell command ran — changes it made are not put back'), 2000)
      const afterPass = m.screen()
      const callsAfterSettle = isReadOnlyCalls
      m.push('\x1b[A')
      await new Promise(r => setTimeout(r, 80))
      m.push('\x1b[B')
      await new Promise(r => setTimeout(r, 80))
      const callsAfterNav = isReadOnlyCalls
      m.unmount()
      const beforeNoShellGuess = !beforePass.includes('shell command ran') && beforePass.includes('no code changes')
      const roIdx = afterPass.indexOf('check directory via bash')
      const mutIdx = afterPass.indexOf('append y via bash')
      const roSlice = roIdx >= 0 && mutIdx > roIdx ? afterPass.slice(roIdx, mutIdx) : ''
      const mutSlice = mutIdx >= 0 ? afterPass.slice(mutIdx) : ''
      check(
        'before the async shell-check pass finishes, the list reads "no code changes" and never guesses shell mutations for a read-only turn',
        beforeNoShellGuess && callsBeforeSettle === 0,
        `callsBeforeSettle=${callsBeforeSettle} screen=${beforePass.slice(0, 400)}`,
      )
      check(
        'after the pass finishes, the read-only turn still reads "no code changes" while the mutating turn reads the shell sentence',
        roSlice.includes('no code changes') &&
          !roSlice.includes('shell command ran') &&
          mutSlice.includes('1 shell command ran — changes it made are not put back') &&
          !mutSlice.includes('no code changes'),
        afterPass.slice(0, 500),
      )
      check(
        'subsequent paints and keypress navigation do not re-run isReadOnly',
        callsAfterSettle === 2 && callsAfterNav === callsAfterSettle,
        `callsAfterSettle=${callsAfterSettle} callsAfterNav=${callsAfterNav}`,
      )
    } finally {
      releasePrepare()
      BashTool.prepare = origPrepare
      BashTool.isReadOnly = origIsReadOnly
      releaseFocusedSessionConnector()
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
