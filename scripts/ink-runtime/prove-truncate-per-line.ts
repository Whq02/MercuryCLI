#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const j = (v: unknown): string => JSON.stringify(v)
const FIX_PER_LINE_CUT = ' | fix: each source line must be cut on its own, not the text as a whole; see wrapWithSoftWrap and styleTruncatedLines in src/screen/renderer/compose-walk.ts (painting), makeTextMeasureFunc in src/screen/renderer/dom.ts (row count) and truncateParts in src/screen/renderer/wrap-text.ts (the cut)'
const FIX_SINGLE_LINE_CUT = ' | fix: a one-line text must keep the plain truncateParts cut in src/screen/renderer/wrap-text.ts, and no extra row may be reserved by makeTextMeasureFunc in src/screen/renderer/dom.ts'

const { mkdtempSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'trunc-line-home-'))
const { enableConfigs } = await import(join(ROOT, 'src/platform/config/globalConfig.ts'))
enableConfigs()

const React = (await import('react')).default
const { renderToString } = await import(join(ROOT, 'src/screen/renderer/staticRender.tsx'))
const { Box, Text } = await import(join(ROOT, 'src/screen/themedRenderer.ts'))

const lines = (s: string): string[] => s.split('\n').map(l => l.replace(/\s+$/, ''))
const DRAFT = 'abcdefghijklmnop\nsecond line\nthird'

const scene = async (wrap: 'truncate' | 'truncate-start' | 'truncate-middle', text = DRAFT): Promise<string[]> =>
  lines(
    await renderToString(
      React.createElement(
        Box,
        { flexDirection: 'column', width: 30 },
        React.createElement(Box, { width: 12 }, React.createElement(Text, { wrap }, text)),
        React.createElement(Text, null, 'NEXT'),
      ),
      30,
    ),
  )

section('§1 truncate-end: every source line paints on its own row')
{
  const ls = await scene('truncate')
  check('THE DEFECT PIN: the second source line survives the cut', ls.some(l => l.trim() === 'second line'), j(ls) + FIX_PER_LINE_CUT)
  check('the third line survives too', ls.some(l => l.trim() === 'third'), j(ls) + FIX_PER_LINE_CUT)
  check('the overflowing first line is ellipsized inside its box', ls[0]!.startsWith('abcdefghijk') && ls[0]!.includes('…'), j(ls[0]) + FIX_PER_LINE_CUT)
  check('NEXT sits directly below the three rows — no blank reserved band', ls.indexOf('NEXT') === 3, j(ls) + FIX_PER_LINE_CUT)
}

section('§2 the other truncate arms cut per line')
{
  const start = await scene('truncate-start')
  check('truncate-start keeps the TAIL of the long line and every later line', start[0]!.startsWith('…') && start.some(l => l.trim() === 'second line'), j(start.slice(0, 3)) + FIX_PER_LINE_CUT)
  const middle = await scene('truncate-middle')
  check('truncate-middle keeps head and tail of the long line and every later line', middle[0]!.includes('…') && middle[0]!.startsWith('a') && middle.some(l => l.trim() === 'third'), j(middle.slice(0, 3)) + FIX_PER_LINE_CUT)
}

section('§3 the single-line slice is unchanged')
{
  const one = await scene('truncate', 'abcdefghijklmnop')
  check('one line, one row, the same leading slice', one[0]! === 'abcdefghijk…' && one.indexOf('NEXT') === 1, j(one.slice(0, 2)) + FIX_SINGLE_LINE_CUT)
  const fits = await scene('truncate', 'short\nlines')
  check('lines that fit pass untouched', fits[0]! === 'short' && fits[1]! === 'lines' && fits.indexOf('NEXT') === 2, j(fits.slice(0, 3)) + FIX_SINGLE_LINE_CUT)
}


console.log(failures === 0 ? '\nprove-truncate-per-line: ALL LAWS HOLD' : `\nprove-truncate-per-line: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
