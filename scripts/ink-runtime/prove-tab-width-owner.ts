#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const j = (v: unknown): string => JSON.stringify(v)

const { mkdtempSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'tab-width-home-'))
const { enableConfigs } = await import(join(ROOT, 'src/utils/config/globalConfig.ts'))
enableConfigs()

const React = (await import('react')).default
const { renderToString } = await import(join(ROOT, 'src/utils/staticRender.tsx'))
const { Box, Text } = await import(join(ROOT, 'src/ink.ts'))

const TABBED = 'ab\tcd\tEFGHIJKLM'

const lines = (s: string): string[] => s.split('\n').map(l => l.replace(/\s+$/, ''))

section('§1 the wrap decision counts the expanded width — rows match the reserved height')
{
  const frame = await renderToString(
    React.createElement(
      Box,
      { flexDirection: 'column', width: 40 },
      React.createElement(Box, { width: 24 }, React.createElement(Text, null, TABBED)),
      React.createElement(Text, null, 'NEXT'),
    ),
    40,
  )
  const ls = lines(frame)
  check('the tabbed line WRAPS: its overflowing word starts a row of its own', ls.some(l => l.trim() === 'EFGHIJKLM'), j(ls))
  check('no blank reserved row stands between the wrap and the next row (layout and paint agree)', ls.findIndex(l => l.trim() === 'EFGHIJKLM') + 1 === ls.findIndex(l => l.trim() === 'NEXT'), j(ls))
  check('the first row carries the tab-expanded head, inside the box', ls[0]!.startsWith('ab      cd') && ls[0]!.trim().length <= 24, j(ls[0]))
}

section('§2 tab stops anchor to the TEXT origin, not the screen column')
{
  const frame = await renderToString(
    React.createElement(
      Box,
      { flexDirection: 'column', width: 40 },
      React.createElement(Box, { paddingLeft: 3 }, React.createElement(Text, null, 'a\tb')),
      React.createElement(Text, null, 'a\tb'),
    ),
    40,
  )
  const ls = lines(frame)
  const indented = ls.find(l => l.trimStart().startsWith('a') && l.startsWith('   '))!
  const flush = ls.find(l => l.startsWith('a'))!
  check('the unindented row lands b at its own column 8', flush.indexOf('b') === 8, j({ flush, at: flush.indexOf('b') }))
  check("the indented pane keeps ITS OWN alignment: b at text-col 8 (screen 11), never screen-col 8", indented.indexOf('b') === 11, j({ indented, at: indented.indexOf('b') }))
}

section('§3 the neighbor pane survives — the expanded line stays inside its clip')
{
  const frame = await renderToString(
    React.createElement(
      Box,
      { width: 40 },
      React.createElement(Box, { width: 20, flexShrink: 0, overflow: 'hidden' }, React.createElement(Text, null, TABBED)),
      React.createElement(Text, null, 'RAIL'),
    ),
    40,
  )
  const ls = lines(frame)
  check('the rail is intact and nothing paints past it', ls[0]!.endsWith('RAIL'), j(ls[0]))
  check('no row glues spilled tab cells onto the rail (the pre-fix overrun shape)', !frame.includes('RAILM') && !frame.includes('KLMRAIL') && !frame.includes('EFGHRAIL'), j(ls))
}

section('§4 one owner, structurally')
{
  const walk = readFileSync(join(ROOT, 'src/ink/compose-walk.ts'), 'utf8')
  check('composeText pre-expands per segment through the one arithmetic owner', walk.includes('expandTabsWithColumn(s.text, column)'))
  const tabstops = readFileSync(join(ROOT, 'src/ink/tabstops.ts'), 'utf8')
  check('expandTabs is the same walk (one owner, two doors)', tabstops.includes('return expandTabsWithColumn(text, 0, interval).text'))
  const dom = readFileSync(join(ROOT, 'src/ink/dom.ts'), 'utf8')
  check("layout keeps measuring the expanded text (the owner's other consumer)", dom.includes('const text = expandTabs(raw)'))
  const buffer = readFileSync(join(ROOT, 'src/ink/compose-buffer.ts'), 'utf8')
  check('the buffer arm is the raw-ansi backstop (an absolute-column stop), never the text path', buffer.includes('if (cp === 0x09) {') && buffer.includes('const stop = 8 - (cx % 8)') && !buffer.includes('expandTabs'))
}

console.log(failures === 0 ? '\nprove-tab-width-owner: ALL LAWS HOLD' : `\nprove-tab-width-owner: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
