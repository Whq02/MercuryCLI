#!/usr/bin/env bun
// ============================================================================
//  scripts/ink-runtime/prove-truncate-per-line.ts — a multi-line text node
//  under a truncate wrap is cut per source line, as layout reserves
//  (FN-016 R14).
//
//  THE DEFECT: the compositor short-circuited every truncate mode to ONE
//  wrapText over the whole squashed string, newlines included — the
//  truncate arms compare stringWidth(text), which bills a newline ZERO, and
//  take one leading slice across the entire string, so the width budget was
//  spent on the first display line. Layout does the opposite (dom.ts splits
//  on newlines and truncates each line, its own comment naming compositor
//  parity as the requirement). The reachable instance is the composer: the
//  moment the caret filled the last display line, the multi-line draft
//  collapsed to a single row — the head of line one, an ellipsis, every
//  remaining line gone, the reserved rows blank — and reappeared one
//  keystroke later.
//
//  THE LAW: truncate modes cut each source line on its own; the composed
//  row count equals the height layout reserved; single-line text keeps the
//  identical slice.
//
//   §1 truncate-end, rendered through the REAL pipeline: every source line
//      paints on its own row, overflowing lines ellipsized, and the next
//      sibling sits directly below (no blank reserved rows);
//   §2 truncate-start and truncate-middle cut per line too;
//   §3 the single-line slice is unchanged (the fast path's control);
//   §4 layout parity, structurally: the compositor splits exactly where
//      dom.ts does.
//
//  Run: ~/.bun/bin/bun run scripts/ink-runtime/prove-truncate-per-line.ts
// ============================================================================
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
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'trunc-line-home-'))
const { enableConfigs } = await import(join(ROOT, 'src/utils/config/globalConfig.ts'))
enableConfigs()

const React = (await import('react')).default
const { renderToString } = await import(join(ROOT, 'src/utils/staticRender.tsx'))
const { Box, Text } = await import(join(ROOT, 'src/ink.ts'))

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
  check('THE DEFECT PIN: the second source line survives the cut', ls.some(l => l.trim() === 'second line'), j(ls))
  check('the third line survives too', ls.some(l => l.trim() === 'third'), j(ls))
  check('the overflowing first line is ellipsized inside its box', ls[0]!.startsWith('abcdefghijk') && ls[0]!.includes('…'), j(ls[0]))
  check('NEXT sits directly below the three rows — no blank reserved band', ls.indexOf('NEXT') === 3, j(ls))
}

section('§2 the other truncate arms cut per line')
{
  const start = await scene('truncate-start')
  check('truncate-start keeps the TAIL of the long line and every later line', start[0]!.startsWith('…') && start.some(l => l.trim() === 'second line'), j(start.slice(0, 3)))
  const middle = await scene('truncate-middle')
  check('truncate-middle keeps head and tail of the long line and every later line', middle[0]!.includes('…') && middle[0]!.startsWith('a') && middle.some(l => l.trim() === 'third'), j(middle.slice(0, 3)))
}

section('§3 the single-line slice is unchanged')
{
  const one = await scene('truncate', 'abcdefghijklmnop')
  check('one line, one row, the same leading slice', one[0]! === 'abcdefghijk…' && one.indexOf('NEXT') === 1, j(one.slice(0, 2)))
  const fits = await scene('truncate', 'short\nlines')
  check('lines that fit pass untouched', fits[0]! === 'short' && fits[1]! === 'lines' && fits.indexOf('NEXT') === 2, j(fits.slice(0, 3)))
}

section('§4 layout parity, structurally')
{
  const walk = readFileSync(join(ROOT, 'src/ink/compose-walk.ts'), 'utf8')
  check('the compositor truncates per source line', walk.includes(".map(line => wrapText(line, maxWidth, textWrap))"))
  const dom = readFileSync(join(ROOT, 'src/ink/dom.ts'), 'utf8')
  check('layout truncates per source line (the parity partner)', dom.includes('lines[i] = wrapText(lines[i]!, width, textWrap)'))
}

console.log(failures === 0 ? '\nprove-truncate-per-line: ALL LAWS HOLD' : `\nprove-truncate-per-line: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
