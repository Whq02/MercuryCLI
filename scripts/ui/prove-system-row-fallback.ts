#!/usr/bin/env bun
import React from 'react'
import { mountOffscreen, pinScratchHome, releaseScratchHome, settle } from '../lib/settingsPopupHarness.ts'

const home = pinScratchHome('system-row-fallback')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { Box } = await import('../../src/screen/themedRenderer.ts')
const { App } = await import('../../src/boot/App.tsx')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { SystemTextMessage } = await import('../../src/screen/messages/SystemTextMessage.tsx')

const h = React.createElement
const row = (extra: object) => ({ type: 'system', uuid: '00000000-0000-4000-8000-00000000000a', timestamp: new Date().toISOString(), ...extra })
const cases: Array<[string, object, boolean, RegExp | null]> = [
  ['a rewind boundary as the branch writer writes it (content, no level), ordinary view', row({ subtype: 'rewind_boundary', content: 'rewound to the second prompt' }), false, null],
  ['the same row in the verbose view', row({ subtype: 'rewind_boundary', content: 'rewound to the second prompt' }), true, /rewound to the second prompt/],
  ['a fork boundary with a null level, ordinary view', row({ subtype: 'fork_boundary', content: 'forked from the first session', level: null }), false, null],
  ['a stored row with no content and no level, verbose', row({ subtype: 'rewind_boundary' }), true, null],
  ['a stored row with no content and a warning level', row({ subtype: 'rewind_boundary', level: 'warning' }), false, null],
  ['a row with level info and a content, ordinary view', row({ subtype: 'fork_boundary', level: 'info', content: 'an info row' }), false, null],
  ['a row with level warning and a content', row({ subtype: 'fork_boundary', level: 'warning', content: '  a warning row  ' }), false, /a warning row/],
  ['a row with level error and a content', row({ subtype: 'fork_boundary', level: 'error', content: 'an error row' }), false, /an error row/],
]
const HINT = 'check SystemTextMessage in src/screen/messages/SystemTextMessage.tsx for how fallback system messages handle missing/null level and content in ordinary vs verbose view'
let bad = 0
try {
  for (const [name, message, verbose, want] of cases) {
    let drawn = ''
    try {
      const view = await mountOffscreen(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(Box, { flexDirection: 'column' }, h(SystemTextMessage, { message, verbose } as never))), 100, 6)
      await settle(120)
      drawn = view.lines().map((line: string) => line.replace(/\s+$/, '')).filter((line: string) => line !== '').join(' / ')
      view.unmount()
    } catch (error) {
      drawn = `THREW ${error instanceof Error ? error.message : String(error)}`
    }
    const ok = want === null ? drawn === '' : want.test(drawn) && !/RENDER ERROR|could not be rendered|THREW/.test(drawn)
    if (!ok) bad++
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}: ${drawn === '' ? '(nothing drawn)' : drawn}${ok ? '' : ` — ${HINT}`}`)
  }
} finally {
  releaseScratchHome(home)
}
console.log(bad === 0 ? 'prove-system-row-fallback: 8 of 8' : `prove-system-row-fallback: ${bad} differ`)
process.exit(bad === 0 ? 0 : 1)
