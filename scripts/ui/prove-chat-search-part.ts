#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { KEY, settle, waitFor } from '../lib/settingsPopupHarness.ts'
import { mountPart, openTranscriptPart } from './chatScenarios.ts'

let failures = 0
const searchPartFix = 'fix the transcript search hook, search bar and footer in src/screen/chat/useChatSearch.tsx (the editor door is src/platform/editor/externalEditor.ts)'
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail ? `${detail} · ` : ''}${searchPartFix}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

const t = await openTranscriptPart('chat-search-part')
const { part, press, act, frame, highlights, jumps, scroll, editor, touched } = t
const { TranscriptFooter, TranscriptSearchBar, highlightTextOf } = t.module
const React = await import('react')
const h = React.createElement
const allRows = t.rowsOf(5)
await t.setRows(allRows.slice(0, 3))
const enter = (): Promise<void> =>
  act(() => {
    part.value().handleEnterTranscript()
    part.value().setScreen('transcript')
  })

section('§1 the hook alone: the flip into the transcript and out of it')
check('the screen starts on the prompt and the transcript rows are the live rows themselves', part.value().screen === 'prompt' && !part.value().inTranscript && part.value().transcriptMessages.length === 3 && part.value().transcriptMessages[2] === allRows[2])
await enter()
check('entering keeps the scroll of the prompt and asks for one flip', scroll.captures === 1 && scroll.flips === 1, `${scroll.captures} captures, ${scroll.flips} flips`)
check('the view is the virtual transcript of the one layout', part.value().inTranscript && part.value().inVirtualTranscript && !part.value().legacyTranscript)
check('the footer of the transcript is drawn with its hints', frame().includes('detailed transcript') && frame().includes('ctrl+o to toggle') && frame().includes('/ search'), frame())
await t.setRows(allRows)
check('rows that arrive while the transcript is open are not shown: the view is frozen at the 3 rows of the entry', part.value().transcriptMessages.length === 3 && part.value().transcriptMessages[2] === allRows[2], `${part.value().transcriptMessages.length}`)
await act(() => {
  part.value().handleExitTranscript()
  part.value().setScreen('prompt')
})
check('leaving thaws the view: the transcript rows are the 5 live rows again', part.value().transcriptMessages === allRows)
check('leaving keeps the scroll again, asks for a second flip and disarms the search', scroll.captures === 2 && scroll.flips === 2 && jumps.at(-1) === 'disarm', `${scroll.captures} · ${scroll.flips} · ${jumps.at(-1)}`)
check('the flip is a change of view only: the session was sent nothing, interrupted nothing, rewound nothing', touched.length === 0, touched.join(','))

section('§2 the keys of the transcript view')
await enter()
jumps.length = 0
highlights.length = 0
await press('/')
check('a slash sets the anchor and opens the search bar', part.value().searchBarOpen && jumps[0] === 'anchor' && frame().includes('/'), jumps.join(','))
await waitFor(() => jumps.includes('query ""'), 2000)
for (const ch of 'tool:bash gate') await press(ch, 30)
await settle(120)
check('each typed character previews the query on the index', jumps.includes('query "tool:bash gate"'), jumps.slice(-3).join(','))
check('and only the words of the query are highlighted, never an operator with its value', highlights.at(-1) === 'gate' && !highlights.some(text => text.includes('tool:b')) && highlightTextOf('tool:bash gate') === 'gate', highlights.join('|'))
await act(() => part.value().onSearchMatchesChange(3, 1))
check('the bar shows the match it stands on', frame().includes('1/3'), frame())
await press(KEY.enter)
check('enter commits the query and closes the bar', !part.value().searchBarOpen && part.value().committedSearchQuery === 'tool:bash gate')
check('the footer carries the badge and the hint for the matches', frame().includes('1/3') && frame().includes('n/N navigate matches'), frame())
jumps.length = 0
await press('n')
await press('N')
check('n and N walk the matches', jumps.join(',') === 'next,prev', jumps.join(','))
await press('/')
await press(KEY.esc)
check('esc in the bar cancels it and puts the committed query back on the index and the highlight', !part.value().searchBarOpen && jumps.slice(-2).join(',') === 'query "",query "tool:bash gate"' && highlights.at(-1) === 'gate', `${jumps.slice(-2).join(',')} · ${highlights.at(-1)}`)
await press('/')
await press('\x03')
check('the interrupt key cancels the bar too', !part.value().searchBarOpen, String(part.value().searchBarOpen))
await t.plant({ focusedInputDialog: 'tool-permission' })
await press('/')
check('with a dialog in focus the view takes no key', !part.value().searchBarOpen)
await t.plant({})
scroll.calls.length = 0
scroll.restore.current = { gap: 2, sticky: false }
await press('g')
check('g drops the kept scroll and goes to the top', scroll.calls.join() === 'scrollTo 0' && scroll.restore.current === null, scroll.calls.join())
scroll.restore.current = { gap: 2, sticky: false }
await press('G')
check('G drops the kept scroll and goes to the bottom', scroll.calls.join() === 'scrollTo 0,scrollToBottom' && scroll.restore.current === null, scroll.calls.join())
scroll.calls.length = 0
jumps.length = 0
await act(() => part.value().onTranscriptScroll(false, {} as never))
check('a scroll of the transcript disarms the search and is handed on to the scroll part', jumps.join() === 'disarm' && scroll.calls.join() === 'onScroll away', `${jumps.join()} · ${scroll.calls.join()}`)
scroll.calls.length = 0
await act(() => part.value().onTranscriptPillClick())
check('the pill of the transcript goes to the very bottom and tells the scroll part it stands on the tail', scroll.calls.join() === 'scrollTo 70,scrollToBottom,onScroll sticky', scroll.calls.join())
await t.plant({ columns: 90 })
check('a change of width drops the committed search, its counts and its highlight', part.value().committedSearchQuery === '' && part.value().searchMatchCount === null && highlights.at(-1) === '' && jumps.includes('disarm'), `${part.value().committedSearchQuery} · ${highlights.at(-1)}`)
await act(() => part.value().onSearchMatchesChange(0, 0))
await press('/')
for (const ch of 'zzz') await press(ch, 30)
await settle(120)
check('a query with no match says so in the bar', frame().includes('no matches'), frame())
await press(KEY.enter)
check('and committing it commits nothing', part.value().committedSearchQuery === '' && part.value().searchMatchCount === null && jumps.at(-1) === 'query ""', `${part.value().committedSearchQuery} · ${jumps.at(-1)}`)
await press('[')
check('the bracket dumps the whole transcript: every row shown, the legacy view, no virtual scroll', part.value().dumpMode && part.value().showAllInTranscript && part.value().legacyTranscript && !part.value().inVirtualTranscript)
await act(() => part.value().setShowAllInTranscript(false))
await press('[')
check('a second bracket does nothing', part.value().dumpMode && !part.value().showAllInTranscript)

section('§3 the transcript in the editor: the one door is asked and the footer says what is known')
editor.answer = true
await press('v')
await waitFor(() => (part.value().editorStatus ?? '').startsWith('opening '), 8000)
const opened = part.value().editorStatus ?? ''
const path = opened.replace(/^opening /, '')
check('v renders the transcript to a file and asks the door for it', editor.asked.length === 1 && editor.asked[0] === path && existsSync(path), `${opened} · asked ${editor.asked.join(',')}`)
const written = existsSync(path) ? readFileSync(path, 'utf8') : ''
check('the file holds the rows of the session', written.includes('answer 1 about the gate') && written.includes('question 4 about the gate'), JSON.stringify(written.slice(0, 600)))
check('the footer says it is opening the file, and claims no more', opened === `opening ${path}` && frame().includes(path.slice(-24)) && !frame().includes('opened'), frame())
editor.answer = false
await press('v')
await waitFor(() => (part.value().editorStatus ?? '').startsWith('written to '), 8000)
check('with no editor to open it the footer says where it was written and how to open it', /^written to .*mercury-transcript-\d+\.md — set \$EDITOR to open it$/.test(part.value().editorStatus ?? ''), part.value().editorStatus ?? '')
editor.platform = 'win32'
await press('v')
await waitFor(() => (part.value().editorStatus ?? '').includes('EDITOR (or VISUAL)'), 8000)
check('on Windows the advice names EDITOR and VISUAL, not $EDITOR', /^written to .* — set EDITOR \(or VISUAL\) to open it$/.test(part.value().editorStatus ?? ''), part.value().editorStatus ?? '')
check('the door was asked three times and nothing else opened the file', editor.asked.length === 3, String(editor.asked.length))
await settle(4300)
check('the word in the footer goes after four seconds', part.value().editorStatus === null, String(part.value().editorStatus))
await press('q')
check('q leaves the transcript', part.value().screen === 'prompt' && !part.value().dumpMode && part.value().transcriptMessages === allRows)
await t.close()

section('§4 the search bar alone')
{
  let release: (ms: number) => void = () => {}
  const seen: string[] = []
  let props = { columns: 80, onQueryChange: (query: string) => void seen.push(query), onCommit: (query: string) => void seen.push(`commit ${query}`), onCancel: () => void seen.push('cancel'), warmSearchIndex: () => new Promise<number>(resolve => (release = resolve)), matchCount: null as number | null, matchCurrent: 0 }
  const bar = await mountPart(() => props, { columns: 80, rows: 6, draw: value => h(TranscriptSearchBar, value) })
  const shown = (): string => bar.view.lines().join('\n')
  await waitFor(() => shown().trim() !== '', 3000)
  check('while the index warms the bar says so and previews nothing', shown().includes('indexing…') && seen.length === 0, shown())
  release(140)
  await settle(150)
  check('a warm-up that took time is told with its time', shown().includes('indexed in 140ms'), shown())
  check('and the empty query is previewed once the index is warm', seen.join() === '', seen.join())
  await settle(2100)
  check('the time leaves after two seconds', !shown().includes('indexed in'), shown())
  bar.view.push('g')
  await settle(100)
  props = { ...props, matchCount: 4, matchCurrent: 2 }
  await bar.set(() => props)
  check('a typed query is previewed and its place among the matches is shown', seen.at(-1) === 'g' && shown().includes('2/4'), `${seen.join(',')} · ${shown()}`)
  bar.view.push(KEY.enter)
  await settle(100)
  check('enter hands the query to the commit', seen.at(-1) === 'commit g', seen.join(','))
  bar.unmount()
}

section('§5 the footer alone: its hints and the budget of its right cell')
{
  const base = { toggleChord: 'ctrl+o', expandChord: 'ctrl+e', hasSearchBadge: false, virtualScroll: true, showAllSuppressed: false, showAll: false, status: null as string | null, badge: null as string | null }
  let props = base
  const footer = await mountPart(() => props, { columns: 120, rows: 4, draw: value => h(TranscriptFooter, value) })
  const line = (): string => footer.view.lines().find(row => row.includes('detailed transcript')) ?? footer.view.lines().join('|')
  await waitFor(() => line().includes('detailed transcript'), 3000)
  check('in the virtual transcript the footer names its keys', line().includes('q quits') && line().includes('/ search') && line().includes('g/G jump'), line())
  props = { ...base, virtualScroll: false }
  await footer.set(() => props)
  check('in the legacy view it names the chord that shows all', line().includes('ctrl+e to show all'), line())
  props = { ...base, virtualScroll: false, showAll: true }
  await footer.set(() => props)
  check('and the chord that collapses once all is shown', line().includes('ctrl+e to collapse'), line())
  props = { ...base, virtualScroll: false, showAllSuppressed: true }
  await footer.set(() => props)
  check('a dumped transcript offers neither', !line().includes('ctrl+e'), line())
  props = { ...base, status: 'written to /a/long/way/down/the/tree/of/folders/mercury-transcript-1234567890.md — set $EDITOR to open it' }
  footer.unmount()
  const narrow = await mountPart(() => props, { columns: 60, rows: 4, draw: value => h(TranscriptFooter, value) })
  await waitFor(() => narrow.view.lines().some(row => row.includes('to open it')), 3000)
  const narrowLine = narrow.view.lines().find(row => row.includes('to open it')) ?? narrow.view.lines().join('|')
  const cell = narrowLine.slice(narrowLine.lastIndexOf('…'))
  check('at 60 columns a long status keeps its tail in a cell of half the row (28 columns) and the row stays one line', narrowLine.length <= 60 && narrowLine.endsWith('set $EDITOR to open it') && cell.length === 28 && narrow.view.lines().filter(row => row.trim() !== '' && !/^─+$/.test(row.trim())).length === 1, `${JSON.stringify(narrowLine)} · cell ${cell.length}`)
  check('the hints on the left are packed into what the capped cell leaves', narrowLine.startsWith(' detailed transcript') && narrowLine.lastIndexOf('…') >= ' detailed transcript'.length, JSON.stringify(narrowLine))
  narrow.unmount()
  const tiny = await mountPart(() => props, { columns: 30, rows: 4, draw: value => h(TranscriptFooter, value) })
  await waitFor(() => tiny.view.lines().some(row => row.includes('open it')), 3000)
  const tinyLine = tiny.view.lines().find(row => row.includes('open it')) ?? tiny.view.lines().join('|')
  check('at 30 columns the cell holds its floor of 16 columns', tinyLine.slice(tinyLine.lastIndexOf('…')).length === 16 && tinyLine.endsWith('open it'), JSON.stringify(tinyLine))
  tiny.unmount()
}

console.log(`\n${failures === 0 ? 'prove-chat-search-part: ALL PASS' : `prove-chat-search-part: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
