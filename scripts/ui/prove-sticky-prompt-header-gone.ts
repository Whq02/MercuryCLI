#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const HELD_IT = [
  'src/components/FullscreenLayout.tsx',
  'src/components/VirtualMessageList.tsx',
  'src/components/Messages.tsx',
  'src/components/CrewmateTranscript.tsx',
  'src/screens/Chat.tsx',
]
const NAMES = /StickyPrompt|stickyPrompt|ScrollChromeContext|hideSticky|stickyHeaderText|stickyTracked|stickyVisible|stickyDescriptor/

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const text = new Map(HELD_IT.map(path => [path, readFileSync(join(ROOT, path), 'utf8')]))
const named = HELD_IT.flatMap(path => text.get(path)!.split('\n').flatMap((line, at) => (NAMES.test(line) ? [`${path}:${at + 1}`] : [])))
check('none of the five files that held the sticky prompt header names it, its tracker or its switch', named.length === 0, `${named.length} lines: ${named.slice(0, 10).join(' ')}`)

const layout = text.get('src/components/FullscreenLayout.tsx')!
check('the layout paints no header row above the transcript pane', !/<Box height=\{1\} onClick=\{\(\) => \w+\.scrollTo\(\)\}>/.test(layout) && !layout.includes('❯ {'))
check('the transcript pane keeps its one row of padding above the viewport at every size but the compact one', layout.includes('paddingTop={isCompact ? 0 : 1}'), (/paddingTop=\{[^}]*\}/.exec(layout.slice(layout.indexOf('stickyScroll'))) ?? ['no padding expression after stickyScroll'])[0])

const list = text.get('src/components/VirtualMessageList.tsx')!
check('the list mounts nothing that follows the scroll position for a header', !list.includes('useSyncExternalStore') && !/Tracker\b/.test(list))
check('the list still jumps to a row and reads where a row stands, for the search and the cursor', list.includes('vsRef.current.scrollToIndex(') && list.includes('vsRef.current.getItemTop('))

console.log(`sticky-prompt-header-gone: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
