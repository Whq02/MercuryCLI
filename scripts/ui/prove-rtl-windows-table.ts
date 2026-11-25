#!/usr/bin/env bun
// gate-watch: src/screen/renderer/bidi.ts src/screen/renderer/compose-buffer.ts src/screen/messages/Markdown.tsx
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'rtl-windows-table-home-')))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
process.env.TERM_PROGRAM = 'xterm'
process.env['WT_SESSION'] = 'rtl-windows-table'
process.env['FORCE_COLOR'] = '0'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const HINT = 'what to change: reorderBidi in src/screen/renderer/bidi.ts orders each stretch between border cells by itself'

const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
enableConfigs()
const React = (await import('react')).default
const { Box } = await import('../../src/screen/themedRenderer.js')
const { renderToString } = await import('../../src/screen/renderer/staticRender.tsx')
const { Markdown } = await import('../../src/screen/messages/Markdown.js')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.tsx')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { reorderBidi } = await import('../../src/screen/renderer/bidi.js')

const h = React.createElement
const mounted = (node: unknown) => h(AppStateProvider as never, { initialState: getDefaultAppState() } as never, node as never)
const columnsOf = (line: string, marks: RegExp): number[] => Array.from(line, (ch, at) => (marks.test(ch) ? at : -1)).filter(at => at >= 0)

console.log('§1 where Mercury orders right-to-left text itself (Windows Terminal), a row keeps its lines in their columns')
{
  const row = '│ بحر │ حقيقة │'
  const ordered = reorderBidi(Array.from(row, value => ({ value, width: 1, styleId: 0, hyperlink: undefined }))).map(c => c.value).join('')
  check('the three lines of a table row stay where they were', columnsOf(ordered, /│/).join(',') === columnsOf(row, /│/).join(','), `${HINT} · ${columnsOf(ordered, /│/).join(',')} against ${columnsOf(row, /│/).join(',')}`)
  check('each cell still reads right to left', ordered.includes('رحب') && ordered.includes('ةقيقح'), ordered)
}

console.log("§2 a drawn Arabic table: the border's joints stand over the column line")
{
  const table = ['| البحر | حقيقة |', '| --- | --- |', '| البحر الأحمر | يضم ثلاث مئة نوع من المرجان |', '| البحر الميت | أخفض بقعة على سطح الأرض |'].join('\n')
  const frame = await renderToString(mounted(h(Box, { width: 80, flexDirection: 'column' }, h(Markdown, { children: table }))), 80)
  const lines = frame.split('\n')
  const joints = lines.filter(line => /[┬┼┴]/.test(line)).map(line => columnsOf(line, /[┬┼┴]/).join(','))
  const rows = lines.filter(line => /[\u0600-\u06FF]/.test(line)).map(line => columnsOf(line, /│/).slice(1, -1).join(','))
  check('the table drew its joints and three rows of letters', joints.length >= 2 && rows.length >= 3, `${joints.length} joint lines, ${rows.length} rows`)
  check("every row's inner line stands under the joints", joints.length >= 2 && rows.length >= 3 && rows.every(columns => columns === joints[0]), `${HINT} · joints at ${joints[0]}, inner lines at ${rows.join(' | ')}`)
}

console.log(failures === 0 ? '\nrtl-windows-table: GREEN' : `\nrtl-windows-table: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
