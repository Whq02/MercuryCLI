#!/usr/bin/env bun

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-journal-view')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.js')
const setJournal = (on: boolean | null): void => {
  writeFileSync(join(HOME, 'settings.json'), JSON.stringify(on === null ? {} : { memory: { journal: on } }))
  resetSettingsCache()
}
const { mnemeProjectKey } = await import('../../src/mneme/paths.js')
const { appendJournalEntry, journalPath, readJournal } = await import('../../src/mneme/journal.js')
const { humanStamp, journalHeading, journalRow, wrapText } = await import('../../src/components/memory/memoryCentreLayout.js')
const { journalRowLabel, journalPage } = await import('../../src/components/memory/MemoryCentreView.js')

const key = mnemeProjectKey()
const realNow = Date.now

async function mountMemory(): Promise<{ m: Mounted; close: () => void }> {
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
const rowOf = (m: Mounted, needle: string | RegExp): string => m.lines().find(l => (typeof needle === 'string' ? l.includes(needle) : needle.test(l))) ?? ''
async function selectRow(m: Mounted, needle: string | RegExp): Promise<string> {
  for (let step = 0; step < 12 && !rowOf(m, needle).includes('❯'); step++) {
    m.push(KEY.up)
    await settle(40)
  }
  for (let step = 0; step < 12 && !rowOf(m, needle).includes('❯'); step++) {
    m.push(KEY.down)
    await settle(40)
  }
  return rowOf(m, needle)
}
const JOURNAL_ROW = /\sjournal\s+(\d+ entr(y|ies)|none|—)\s/

section('§1 the cells of the row, the heading and the page')
{
  const empty = journalRow({ enabled: true, entries: [] })
  check('an empty journal counts none, reads on, and its detail says the model writes one at a session end', empty.count === 'none' && empty.state === 'on' && empty.detail === 'the model writes one, in its own words, when a session ends' && empty.action === null, JSON.stringify(empty))
  const off = journalRow({ enabled: false, entries: [] })
  check('the row reads off and names the setting when the journal is off', off.state === 'off' && off.detail === 'memory.journal in /config turns it on' && off.count === '—', JSON.stringify(off))
  const two = journalRow({ enabled: true, entries: [{ at: '2026-10-11T02:15:30.250Z', text: 'a' }, { at: '2026-10-11T03:00:00.000Z', text: 'b' }] })
  check('the row counts the entries, dates the newest in the human form and offers them', two.count === '2 entries' && two.newest === humanStamp('2026-10-11T03:00:00.000Z') && two.action === 'read the entries', JSON.stringify(two))
  check('the heading says newest first and whose words these are', journalHeading(2) === "2 entries, newest first · the model's own words")
  check('a list row is the human date and the first line', journalRowLabel({ at: '2026-10-11T03:00:00.000Z', text: 'first line\nsecond' }) === `${humanStamp('2026-10-11T03:00:00.000Z')}  first line`)
  const page = journalPage({ at: '2026-10-11T03:00:00.000Z', text: 'one two three four five six' }, 9)
  check('the page names the time twice — human in the title, the clock in the meta — and wraps the words at the width without losing any', page.title === `journal · ${humanStamp('2026-10-11T03:00:00.000Z')}` && page.meta.startsWith("written 2026-10-11 03:00 UTC · the model's own words · ") && page.lines.map(l => l.text).join('|') === 'one two|three|four five|six', JSON.stringify(page))
  check('long text wraps at the width without losing words', wrapText('one two three four five six', 9).join('|') === 'one two|three|four five|six')
}

section('§2 memory.journal on, no journal yet: the row stands, as information')
setJournal(true)
{
  const { m, close } = await mountMemory()
  const painted = await waitFor(() => m.lines().some(l => JOURNAL_ROW.test(l)), 6000)
  check('the overview painted with the journal row', painted)
  await settle(150)
  const row = rowOf(m, JOURNAL_ROW)
  check('the row counts none and reads on', /\sjournal\s+none\s+—\s+on\s/.test(row), row.trim())
  await selectRow(m, JOURNAL_ROW)
  check('its detail says the model writes one at a session end; the footer offers nothing to open', m.lines().some(l => l.includes('the model writes one, in its own words, when a session ends')) && !m.lines().some(l => l.includes('↵ read the entries')))
  close()
  m.unmount()
}

section('§3 two entries written at the clock; /memory lists them newest first and ↵ opens one')
const T1 = Date.UTC(2026, 9, 11, 2, 15, 30, 250)
const T2 = Date.UTC(2026, 9, 11, 3, 40, 0, 0)
Date.now = () => T1
appendJournalEntry(key, 'I set up the journal view. The operator wanted the rows short and plain.\n\nI got the first heading wrong and said so.')
Date.now = () => T2
appendJournalEntry(key, 'Second session. The operator asked for the entry to open on ↵; I had put it behind a key and corrected that.')
Date.now = realNow
check('two entries stand in the home', readJournal(key).length === 2 && journalPath(key).startsWith(HOME), journalPath(key))
const newestStamp = humanStamp(new Date(T2).toISOString())
const olderStamp = humanStamp(new Date(T1).toISOString())
{
  const { m, close } = await mountMemory()
  await waitFor(() => m.lines().some(l => JOURNAL_ROW.test(l)), 6000)
  await settle(150)
  let row = rowOf(m, JOURNAL_ROW)
  check('the row counts two entries and dates the newest', new RegExp(`\\sjournal\\s+2 entries\\s+${newestStamp}\\s+on\\s`).test(row), row.trim())
  row = await selectRow(m, JOURNAL_ROW)
  check('the journal row is selectable and the footer offers the entries', row.includes('❯') && m.lines().some(l => l.includes('↵ read the entries')), row.trim())
  m.push(KEY.enter)
  const listed = await waitFor(() => m.lines().some(l => l.includes('memory › journal')) && m.lines().some(l => l.includes(`${newestStamp}  Second session.`)), 6000)
  check('↵ lists the entries under the breadcrumb', listed, m.lines().filter(l => l.trim()).slice(0, 12).join(' | '))
  await settle(150)
  const lines = m.lines()
  const newest = lines.findIndex(l => l.includes(`${newestStamp}  Second session.`))
  const older = lines.findIndex(l => l.includes(`${olderStamp}  I set up the journal view.`))
  check('the newest entry stands first', newest >= 0 && older > newest, `${newest} / ${older}`)
  check('the breadcrumb says newest first and whose words these are', lines.some(l => l.includes("memory › journal · 2 entries, newest first · the model's own words")))
  check('the legend says the journal is kept in the home, never pushed or synced', lines.some(l => l.includes('kept in the Mercury home, never pushed or synced')))
  check('the footer offers ↵ to read the entry', lines.some(l => l.includes('↵ read the entry')))
  const selected = rowOf(m, `${newestStamp}  Second session.`)
  check('the newest entry is selected on entry', selected.includes('❯'), selected.trim())
  m.push(KEY.enter)
  const opened = await waitFor(() => m.lines().some(l => l.includes('corrected that.')), 6000)
  const body = m.lines().map(l => l.replace(/^\s*│\s*|\s*│\s*$/g, '').trim()).join(' ')
  check('↵ opens the entry: the whole text, wrapped', opened && body.includes('The operator asked for the entry to open on ↵; I had put it behind a key and corrected that.'), m.lines().filter(l => l.trim()).slice(0, 12).join(' | '))
  await settle(100)
  check('the open entry names its time, whose words these are and the file', m.lines().some(l => l.includes(`journal · ${newestStamp}`)) && m.lines().some(l => l.includes("written 2026-10-11 03:40 UTC · the model's own words · ")), rowOf(m, 'written').trim())
  check('the footer offers esc back', m.lines().some(l => l.includes('esc back')))
  m.push('c')
  await settle(80)
  check('a letter while the entry is open changes nothing (no correction, no search)', !m.lines().some(l => l.includes('correcting')) && !m.lines().some(l => l.includes('/ c')))
  m.push(KEY.esc)
  const backToList = await waitFor(() => m.lines().some(l => l.includes(`${newestStamp}  Second session.`)) && !m.lines().some(l => l.includes('corrected that.')), 4000)
  check('esc returns to the list', backToList)
  m.push(KEY.esc)
  const backToOverview = await waitFor(() => m.lines().some(l => /\sjournal\s+2 entries\s/.test(l)), 4000)
  check('esc again returns to the overview', backToOverview)
  close()
  m.unmount()
}

section('§4 nothing set (the journal is off by default): the row says so and offers nothing to open')
setJournal(null)
{
  const { m, close } = await mountMemory()
  await waitFor(() => m.lines().some(l => JOURNAL_ROW.test(l)), 6000)
  await settle(150)
  const row = rowOf(m, JOURNAL_ROW)
  check('the row reads off', /\sjournal\s+—\s+—\s+off\s/.test(row), row.trim())
  await selectRow(m, JOURNAL_ROW)
  check('its detail names the setting and the footer offers nothing to open', m.lines().some(l => l.includes('memory.journal in /config turns it on')) && !m.lines().some(l => l.includes('↵ read the entries')))
  close()
  m.unmount()
}
setJournal(null)

await releaseScratchHome(HOME)
console.log(`\nprove-journal-view: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
