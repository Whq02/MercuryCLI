#!/usr/bin/env bun

import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-lineage-view')

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { openEntry, closeEntry } = await import('../../src/mneme/ledger.js')
const { mnemeProjectKey } = await import('../../src/mneme/paths.js')
const { humanStamp, lineageRow, lineageRows, lineageHeading, pageLines } = await import('../../src/components/memory/memoryCentreLayout.js')
const { notePage } = await import('../../src/components/memory/MemoryCentreView.js')
const { getSessionId } = await import('../../src/bootstrap/state.js')

const key = mnemeProjectKey()
const me = String(getSessionId())

async function mountCentre(): Promise<{ m: Mounted; close: () => void }> {
  const React = await import('react')
  const { Box } = await import('../../src/ink.js')
  const { AppStateProvider } = await import('../../src/state/AppState.js')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
  const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.js')
  const store = await import('../../src/utils/cockpit/settingsPopup.js')
  const { memoryPopupRequest } = await import('../../src/commands/memory/memory.js')
  const element = React.createElement(
    AppStateProvider as never,
    {},
    React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: 120, height: 40 }, React.createElement(SettingsPopupSlot, { overlay: true }))),
  )
  const m = await mountOffscreen(element, 120, 40)
  store.openSettingsPopup(memoryPopupRequest('centre', () => {}))
  return { m, close: () => store.closeSettingsPopup() }
}

async function selectRow(m: Mounted, words: string | RegExp): Promise<string> {
  const find = (): string => m.lines().find(l => (typeof words === 'string' ? l.includes(words) : words.test(l))) ?? ''
  for (let step = 0; step < 12; step++) {
    const row = find()
    if (row.includes('❯')) return row
    m.push(KEY.down)
    await settle(40)
  }
  return find()
}

section('§1 the row cells: a first session says so; a later session names its ordinal, the count and whether the last session left a note')
{
  const first = lineageRow([], me)
  check('no record: the row counts a first session, no record before it', first.count === 'first session' && first.state === 'first' && first.detail.includes('no record before it'), JSON.stringify(first))
  const entries = [
    { ordinal: 1, sessionId: 'a', startedAt: '2026-10-10T10:00:00.000Z', endedAt: '2026-10-10T11:00:00.000Z', engines: [{ model: 'm', at: '2026-10-10T10:00:00.000Z' }], rulings: [], retained: [], corrected: [], files: [], outcome: 'closed', handoff: { text: 'the first note', at: '2026-10-10T11:00:00.000Z' } },
    { ordinal: 2, sessionId: 'b', startedAt: '2026-10-10T12:00:00.000Z', endedAt: '2026-10-10T13:00:00.000Z', engines: [{ model: 'm', at: '2026-10-10T12:00:00.000Z' }], rulings: [], retained: [], corrected: [], files: [], outcome: 'closed', handoff: null },
  ]
  const row = lineageRow(entries, me)
  check('two sessions before, the last without a note: the count names the ordinal and the sessions before, the newest is the last end, the state says no note, the detail names the last note that exists', row.count === 'session 3 · 2 before' && row.newest === humanStamp('2026-10-10T13:00:00.000Z') && row.state === 'no note' && row.detail === '2 sessions before this one · last note from session 1', JSON.stringify(row))
  const noted = lineageRow([entries[0]!], me)
  check('the last session noted: the state reads noted', noted.state === 'noted' && noted.count === 'session 2 · 1 before', JSON.stringify(noted))
  const table = lineageRows(entries, me)
  check('the table lists the sessions newest first with the engine, the dates and the note column', table.map(r => r.cells[0]).join(',') === '2,1' && table[0]!.cells[4] === 'no' && table[1]!.cells[4] === 'yes' && table[1]!.cells[1] === 'm' && table[1]!.cells[2] === humanStamp('2026-10-10T10:00:00.000Z'), JSON.stringify(table.map(r => r.cells)))
  check('the table heading counts the sessions before this one', lineageHeading(entries, me) === '2 sessions before this one, newest first' && lineageHeading([], me).startsWith('first session of this work'))
  const page = notePage(table[1]!, 70)
  check('a session\'s note page names the session, its dates, its engine and when the note was left, the note wrapped whole', page.title === 'session 1 — the note it left' && page.meta.includes('· m · note left') && page.lines.map(l => l.text).join(' ') === 'the first note', JSON.stringify(page))
  const wrapped = pageLines('Session 3 of this work; 2 sessions before it.\n\n' + 'word '.repeat(40).trim(), 70)
  check('the page lines keep the blank line and wrap long lines whole-word at the width', wrapped[0]!.text === 'Session 3 of this work; 2 sessions before it.' && wrapped[1]!.kind === 'blank' && wrapped.every(r => r.text.length <= 70) && wrapped.slice(2).map(r => r.text).join(' ') === 'word '.repeat(40).trim(), JSON.stringify(wrapped))
}

section('§2 the overview row, the table and the note page in /memory, from a ledger in the scratch home')
{
  openEntry(key, { sessionId: 'earlier', model: 'claude-fable-5-1' })
  closeEntry(key, 'earlier', { outcome: 'closed', handoff: 'The work is the memory centre.\nStill to do: the lineage row.' })
  openEntry(key, { sessionId: me, model: 'claude-fable-5-1' })
  const { m, close } = await mountCentre()
  const painted = await waitFor(() => m.lines().some(l => /\slineage\s+session 2 · 1 before\s/.test(l)), 6000)
  check('the overview paints the lineage row with the ordinal and the count as a cell', painted, m.lines().filter(l => l.trim()).slice(0, 12).join(' | '))
  await settle(120)
  const row = m.lines().find(l => /\slineage\s+session 2/.test(l)) ?? ''
  check('the row dates the last session and reads noted', /session 2 · 1 before\s+\d\d [A-Z][a-z]{2} \d\d:\d\d\s+noted/.test(row), row.trim())
  const selected = await selectRow(m, 'session 2 · 1 before')
  check('the row is selectable; its detail names the last note by its session; the footer offers the sessions', selected.includes('❯') && m.lines().some(l => l.includes('1 session before this one · last note from session 1')) && m.lines().some(l => l.includes('↵ open the sessions')), selected.trim())
  m.push(KEY.enter)
  const opened = await waitFor(() => m.lines().some(l => l.includes('memory › lineage · 1 session before this one, newest first')) && m.lines().some(l => /session\s+engine\s+started\s+ended\s+note/.test(l)), 6000)
  check('↵ opens the lineage as a table under its breadcrumb, with the five columns', opened, m.lines().filter(l => l.trim()).slice(0, 14).join(' | '))
  await settle(100)
  const rows = m.lines().filter(l => /\s[12]( \(this\))?\s+claude-fable-5-1\s+\d\d [A-Z][a-z]{2} \d\d:\d\d/.test(l))
  check('two session rows, this one first and open, the earlier one closed with a note', rows.length === 2 && rows[0]!.includes('2 (this)') && /\sopen\s+no\s/.test(rows[0]!) && /\syes\s/.test(rows[1]!), rows.join(' | '))
  const noted = await selectRow(m, /\s1\s+claude-fable-5-1\s/)
  check('the noted session takes the cursor and the footer offers its note', noted.includes('❯') && m.lines().some(l => l.includes('↵ read the note · esc back')), noted.trim())
  m.push(KEY.enter)
  const page = await waitFor(() => m.lines().some(l => l.includes('memory › lineage › session 1')) && m.lines().some(l => l.includes('The work is the memory centre.')), 6000)
  check('↵ opens the session\'s note as a page, the note in it word for word', page && m.lines().some(l => l.includes('Still to do: the lineage row.')), m.lines().filter(l => l.trim()).slice(0, 14).join(' | '))
  await settle(100)
  check('the page says whose note it is, when it was left and by which engine', m.lines().some(l => l.includes('session 1 — the note it left')) && m.lines().some(l => l.includes('claude-fable-5-1 · note left')))
  check('the footer offers esc back', m.lines().some(l => l.includes('esc back')))
  m.push(KEY.esc)
  const backToTable = await waitFor(() => m.lines().some(l => l.includes('memory › lineage ·')) && !m.lines().some(l => l.includes('The work is the memory centre.')), 4000)
  check('esc returns to the table', backToTable)
  m.push(KEY.esc)
  const back = await waitFor(() => m.lines().some(l => /\slineage\s+session 2 · 1 before\s/.test(l)) && m.lines().some(l => l.includes('facts and decisions')), 4000)
  check('esc again returns to the overview', back)
  close()
  m.unmount()
}

await releaseScratchHome(HOME)
console.log(failures === 0 ? `\n✅ LINEAGE VIEW GREEN (${checks} checks)` : `\n❌ LINEAGE VIEW RED (${failures} of ${checks} checks failed)`)
process.exit(failures === 0 ? 0 : 1)
