#!/usr/bin/env bun
// gate-watch: src/components/memory/MemoryCentreView.tsx src/mneme/entryPage.ts src/mneme/ledger.ts src/mneme/paths.ts
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
const { lineageRowWords, lineagePageRows } = await import('../../src/components/memory/MemoryCentreView.js')
const { composeEntryPage } = await import('../../src/mneme/entryPage.js')
const { getSessionId } = await import('../../src/bootstrap/state.js')

const key = mnemeProjectKey()
const me = String(getSessionId())

async function mountCentre(): Promise<Mounted> {
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

async function selectRow(m: Mounted, words: string): Promise<string> {
  for (let step = 0; step < 12; step++) {
    const row = m.lines().find(l => l.includes(words)) ?? ''
    if (row.includes('▸')) return row
    m.push(KEY.down)
    await settle(40)
  }
  return m.lines().find(l => l.includes(words)) ?? ''
}

section('§1 the row words: a first session says so; a later session names its ordinal, the count and the last note')
{
  check('no record: the row says first session, no record before it', lineageRowWords([], me).includes('first session of this work — no record before it'))
  const entries = [
    { ordinal: 1, sessionId: 'a', startedAt: '2026-10-10T10:00:00.000Z', endedAt: '2026-10-10T11:00:00.000Z', engines: [{ model: 'm', at: '2026-10-10T10:00:00.000Z' }], rulings: [], retained: [], corrected: [], files: [], outcome: 'closed', handoff: { text: 'the first note', at: '2026-10-10T11:00:00.000Z' } },
    { ordinal: 2, sessionId: 'b', startedAt: '2026-10-10T12:00:00.000Z', endedAt: '2026-10-10T13:00:00.000Z', engines: [{ model: 'm', at: '2026-10-10T12:00:00.000Z' }], rulings: [], retained: [], corrected: [], files: [], outcome: 'closed', handoff: null },
  ]
  const words = lineageRowWords(entries, me)
  check('two sessions before, the last without a note: the row counts them and names the last note that exists, within the row width', words === 'lineage: session 3 · 2 before · last note from session 1 — ↵ page' && words.length <= 70, words)
  check('no note anywhere: the row says so', lineageRowWords([{ ...entries[1]!, ordinal: 1 }], me) === 'lineage: session 2 · 1 before · no note left yet — ↵ page', lineageRowWords([{ ...entries[1]!, ordinal: 1 }], me))
  const rows = lineagePageRows('# Lineage\nSession 3 of this work; 2 sessions before it.\n\n## The last note left (session 1, 2026-10-10 11:00 (UTC+00:00))\n' + 'word '.repeat(40).trim(), 70)
  check('the page rows drop the heading, keep the blank line and wrap long lines whole-word at the width', rows[0] === 'Session 3 of this work; 2 sessions before it.' && rows[1] === '' && rows.every(r => r.length <= 70) && rows.slice(3).join(' ') === 'word '.repeat(40).trim(), JSON.stringify(rows))
}

section('§2 the overview row and the page view in /memory, from a ledger in the scratch home')
{
  openEntry(key, { sessionId: 'earlier', model: 'claude-fable-5-1' })
  closeEntry(key, 'earlier', { outcome: 'closed', handoff: 'The work is the memory centre.\nStill to do: the lineage row.' })
  openEntry(key, { sessionId: me, model: 'claude-fable-5-1' })
  const page = composeEntryPage(key, me) ?? ''
  check('the page for this session carries the earlier note', page.includes('Session 2 of this work; 1 session before it') && page.includes('The work is the memory centre.'), page)
  const m = await mountCentre()
  const painted = await waitFor(() => m.lines().some(l => l.includes('lineage: session 2 ·')), 6000)
  check('the overview paints the lineage row with the ordinal and the count', painted, m.lines().filter(l => l.trim()).slice(0, 12).join(' | '))
  await settle(120)
  const row = m.lines().find(l => l.includes('lineage: session 2')) ?? ''
  check('the row names the last note by its session and offers the page, whole on the row', row.includes('lineage: session 2 · 1 before · last note from session 1 — ↵ page'), row.trim())
  const selected = await selectRow(m, 'lineage: session 2')
  check('the row is selectable', selected.includes('▸'), selected.trim())
  m.push(KEY.enter)
  const opened = await waitFor(() => m.lines().some(l => l.includes('Lineage')) && m.lines().some(l => l.includes('The work is the memory centre.')), 6000)
  check('↵ opens the page this session was given, the note in it word for word', opened, m.lines().filter(l => l.trim()).slice(0, 14).join(' | '))
  await settle(100)
  check('the view says what the page is', m.lines().some(l => l.includes('the page this session was given at its start')))
  check('the page lines are the entry page\'s: the ordinal line, the engines line, the rulings line, the note heading', m.lines().some(l => l.includes('Session 2 of this work; 1 session before it')) && m.lines().some(l => l.includes('Engines before this session: claude-fable-5-1 from')) && m.lines().some(l => l.includes('Standing rulings: none pinned.')) && m.lines().some(l => l.includes('The last note left (session 1,')), m.lines().filter(l => l.trim()).slice(0, 14).join(' | '))
  check('the footer offers esc back', m.lines().some(l => l.includes('esc back')))
  m.push(KEY.esc)
  const back = await waitFor(() => m.lines().some(l => l.includes('lineage: session 2 ·')) && !m.lines().some(l => l.includes('the page this session was given at its start')), 4000)
  check('esc returns to the overview', back)
  m.unmount()
}

await releaseScratchHome(HOME)
console.log(failures === 0 ? `\n✅ LINEAGE VIEW GREEN (${checks} checks)` : `\n❌ LINEAGE VIEW RED (${failures} of ${checks} checks failed)`)
process.exit(failures === 0 ? 0 : 1)
