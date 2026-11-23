#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { mountOffscreen, settle, waitFor } from '../lib/settingsPopupHarness.ts'
import type { SessionListing } from '../../src/sessions/transcripts/transcriptEntries.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_REDUCED_MOTION = '1'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

;(await import('../../src/platform/settings/config.ts')).enableConfigs()
const React = await import('react')
const { Box } = await import('../../src/screen/themedRenderer.ts')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.tsx')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.tsx')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
const { LogSelector } = await import('../../src/screen/session-chooser/SessionBrowser.tsx')

const at = (minute: number): string => new Date(Date.UTC(2026, 0, 1, 10, minute)).toISOString()
const listing = (minute: number, title: string, more: Partial<SessionListing>): SessionListing => ({
  date: at(minute),
  value: minute,
  firstPrompt: title,
  customTitle: title,
  isSidechain: false,
  messages: [],
  created: new Date(at(minute)),
  modified: new Date(at(minute)),
  sessionId: randomUUID(),
  messageCount: 2,
  ...more,
})
const logs: SessionListing[] = [
  listing(1, 'ALPHA_ROW', { gitBranch: 'Release-Candidate' }),
  listing(2, 'BRAVO_ROW', { gitBranch: 'main', tag: 'Hotfix' }),
  listing(3, 'CHARLIE_ROW', { gitBranch: 'main' }),
  listing(4, 'DELTA_ROW', { gitBranch: 'main', prNumber: 77, prRepository: 'Acme/Widgets' }),
  listing(5, 'Echo Mixed Title', { gitBranch: 'main' }),
]
const titles = logs.map(log => log.customTitle ?? '')
const h = React.createElement
const noop = (): void => {}

async function found(query: string): Promise<string[]> {
  const list = h(LogSelector as never, { logs, onSelect: noop, onCancel: noop, maxHeight: 40 })
  const screen = await mountOffscreen(h(AppStateProvider as never, {}, h(ThemeProvider as never, {}, h(KeybindingSetup as never, {}, h(Box as never, { width: 120, height: 44, flexDirection: 'column' }, list)))), 120, 44)
  try {
    const shown = (text: string): boolean => screen.screen().includes(text)
    if (!(await waitFor(() => titles.every(shown), 5_000))) return [`the list did not open with its ${titles.length} sessions: ${screen.screen().slice(0, 300)}`]
    if (query === '') return titles.filter(shown)
    screen.push('/')
    await settle(60)
    for (const letter of query) {
      screen.push(letter)
      await settle(25)
    }
    if (!(await waitFor(() => shown(query), 3_000))) return [`the search box never showed ${query}: ${screen.screen().slice(0, 300)}`]
    await settle(250)
    return titles.filter(shown)
  } finally {
    screen.unmount()
  }
}

const same = (got: string[], wanted: string[]): boolean => got.length === wanted.length && wanted.every(title => got.includes(title))
const cases: Array<[string, string, string[]]> = [
  ['with no search every session is listed', '', titles],
  ['a branch named with capitals is found by its name typed in lower case', 'release', ['ALPHA_ROW']],
  ['a tag named with capitals is found by its name typed in lower case', 'hotfix', ['BRAVO_ROW']],
  ['a lower-case branch is found by its name typed in capitals', 'MAIN', ['BRAVO_ROW', 'CHARLIE_ROW', 'DELTA_ROW', 'Echo Mixed Title']],
  ['a pull request is found by its repository typed in lower case', 'acme/widgets', ['DELTA_ROW']],
  ['a title is found by its words typed in lower case', 'echo mixed', ['Echo Mixed Title']],
  ['a search that fits no title, branch, tag or pull request lists no session', 'zebra', []],
]
for (const [label, query, wanted] of cases) {
  const got = await found(query)
  check(label, same(got, wanted), `searched ${JSON.stringify(query)}: listed ${JSON.stringify(got)}; wanted ${JSON.stringify(wanted)}`)
}

console.log('\n' + (failures === 0 ? 'SESSION SEARCH IGNORES CASE GREEN' : `SESSION SEARCH IGNORES CASE RED: ${failures} failed`))
process.exit(failures === 0 ? 0 : 1)
