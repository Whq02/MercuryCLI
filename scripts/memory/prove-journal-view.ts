#!/usr/bin/env bun
// gate-watch: src/components/memory/MemoryCentreView.tsx src/mneme/journal.ts src/mneme/paths.ts src/mneme/ledger.ts
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
const { mnemeProjectKey } = await import('../../src/mneme/paths.js')
const { appendJournalEntry, journalPath, readJournal } = await import('../../src/mneme/journal.js')
const { journalRowWords, journalListHeading, wrapJournalText } = await import('../../src/components/memory/MemoryCentreView.js')

const key = mnemeProjectKey()
const realNow = Date.now

async function mountMemory(): Promise<Mounted> {
  const React = await import('react')
  const { Box } = await import('../../src/ink.js')
  const { AppStateProvider } = await import('../../src/state/AppState.js')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
  const { MemoryCentreView } = await import('../../src/components/memory/MemoryCentreView.js')
  const element = React.createElement(
    AppStateProvider as never,
    {},
    React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: 120, height: 40 }, React.createElement(MemoryCentreView as never, { onClose: () => {} }))),
  )
  return mountOffscreen(element, 120, 40)
}
const rowOf = (m: Mounted, needle: string): string => m.lines().find(l => l.includes(needle)) ?? ''
async function selectRow(m: Mounted, needle: string): Promise<string> {
  for (let step = 0; step < 12 && !rowOf(m, needle).includes('▸'); step++) {
    m.push(KEY.up)
    await settle(40)
  }
  for (let step = 0; step < 12 && !rowOf(m, needle).includes('▸'); step++) {
    m.push(KEY.down)
    await settle(40)
  }
  return rowOf(m, needle)
}

section('§1 the words of the row and the heading')
check('an empty journal says the model writes one at a session end', journalRowWords([], true) === 'journal: no entry yet — the model writes one, in its own words, when a session ends')
check('the row says off and names the setting when the journal is off', journalRowWords([], false) === 'journal: off — memory.journal in /config')
check('the row counts the entries and dates the last', journalRowWords([{ at: '2026-10-11T02:15:30.250Z', text: 'a' }, { at: '2026-10-11T03:00:00.000Z', text: 'b' }], true) === 'journal: 2 entries · last 2026-10-11 03:00 — ↵ read it')
check('the heading says newest first and whose words these are', journalListHeading(2) === "2 entries, newest first · the model's own words · ↵ opens one")
check('long text wraps at the width without losing words', wrapJournalText('one two three four five six', 9).join('|') === 'one two|three|four five|six')

section('§2 /memory with no journal yet: the row stands, as information')
{
  const m = await mountMemory()
  const painted = await waitFor(() => m.lines().some(l => l.includes('journal:')), 6000)
  check('the overview painted with the journal row', painted)
  await settle(150)
  const row = rowOf(m, 'journal:')
  check('the row says no entry yet', row.includes('journal: no entry yet'), row.trim())
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
{
  const m = await mountMemory()
  await waitFor(() => m.lines().some(l => l.includes('journal:')), 6000)
  await settle(150)
  let row = rowOf(m, 'journal:')
  check('the row counts two entries and dates the newest', row.includes('journal: 2 entries · last 2026-10-11 03:40 — ↵ read it'), row.trim())
  row = await selectRow(m, 'journal:')
  check('the journal row is selectable', row.includes('▸'), row.trim())
  m.push(KEY.enter)
  const listed = await waitFor(() => m.lines().some(l => l.includes('Journal')) && m.lines().some(l => l.includes('2026-10-11 03:40 · Second session.')), 6000)
  check('↵ lists the entries', listed, m.lines().filter(l => l.trim()).slice(0, 12).join(' | '))
  await settle(150)
  const lines = m.lines()
  const newest = lines.findIndex(l => l.includes('2026-10-11 03:40 · Second session.'))
  const older = lines.findIndex(l => l.includes('2026-10-11 02:15 · I set up the journal view.'))
  check('the newest entry stands first', newest >= 0 && older > newest, `${newest} / ${older}`)
  check('the heading says newest first', lines.some(l => l.includes('2 entries, newest first · the model\'s own words')))
  check('the view says the journal is kept in the home, never pushed or synced', lines.some(l => l.includes('kept in the Mercury home, never pushed or synced')))
  check('the footer offers ↵ to read the entry', lines.some(l => l.includes('↵ read the entry')))
  const selected = await selectRow(m, '2026-10-11 03:40 · Second session.')
  check('an entry row is selectable', selected.includes('▸'), selected.trim())
  m.push(KEY.enter)
  const opened = await waitFor(() => m.lines().some(l => l.includes('corrected that.')), 6000)
  const body = m.lines().map(l => l.replace(/^│\s*|\s*│$/g, '').trim()).join(' ')
  check('↵ opens the entry: the whole text, wrapped', opened && body.includes('The operator asked for the entry to open on ↵; I had put it behind a key and corrected that.'), m.lines().filter(l => l.trim()).slice(0, 12).join(' | '))
  await settle(100)
  check('the open entry names its time, whose words these are and the file', m.lines().some(l => l.includes('journal · 2026-10-11 03:40 · the model\'s own words · ')), rowOf(m, 'journal ·').trim())
  check('the footer offers esc back', m.lines().some(l => l.includes('esc back')))
  m.push('c')
  await settle(80)
  check('a letter while the entry is open changes nothing (no correction, no search)', !m.lines().some(l => l.includes('correcting')) && !m.lines().some(l => l.includes('search: c')))
  m.push(KEY.esc)
  const backToList = await waitFor(() => m.lines().some(l => l.includes('2026-10-11 03:40 · Second session.')) && !m.lines().some(l => l.includes('corrected that.')), 4000)
  check('esc returns to the list', backToList)
  m.push(KEY.esc)
  const backToOverview = await waitFor(() => m.lines().some(l => l.includes('journal: 2 entries')), 4000)
  check('esc again returns to the overview', backToOverview)
  m.unmount()
}

section('§4 the setting off: the row says so and offers nothing to open')
writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ memory: { journal: false } }))
resetSettingsCache()
{
  const m = await mountMemory()
  await waitFor(() => m.lines().some(l => l.includes('journal:')), 6000)
  await settle(150)
  const row = rowOf(m, 'journal:')
  check('the row reads off and names the setting', row.includes('journal: off — memory.journal in /config'), row.trim())
  check('the row is information, not an action', row.includes('· journal: off'), row.trim())
  m.unmount()
}
writeFileSync(join(HOME, 'settings.json'), '{}')
resetSettingsCache()

await releaseScratchHome(HOME)
console.log(`\nprove-journal-view: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
