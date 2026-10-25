#!/usr/bin/env bun
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'rtl-row-border-home-')))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
process.env['FORCE_COLOR'] = '0'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const React = (await import('react')).default
const { Box } = await import('../../src/ink.js')
const { renderToString } = await import('../../src/utils/staticRender.tsx')
const { Markdown } = await import('../../src/components/Markdown.js')
const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { stringWidth, __correctedWidthForTest: nodeWidth } = await import('../../src/ink/stringWidth.js')
const { wrapAnsi } = await import('../../src/ink/wrapAnsi.js')

const h = React.createElement
const mounted = (node: unknown) => h(AppStateProvider as never, { initialState: getDefaultAppState() } as never, node as never)

const ROWS = [
  '**بلا تفلسف** — no tfalsif. Do what is asked, inside what is there: no new ideas, no redesigns, no essays. إذا احتاج التغيير إلى حجة فهو ليس تغييراً: اتركه، وسمّه في سطر واحد للمالك.',
  'نعم، هل هذا صحيح؟ The Arabic comma and question mark sit inside the row with Latin text on both sides of them so the wrap has to cross scripts.',
  'שלום עולם — a Hebrew line with niqqud: שָׁלוֹם, and Persian with the joiner: می\u200Cخواهم که این متن درست بماند.',
  'مُحَمَّدٌ رَسُولُ اللهِ — harakat on every letter, then a lam-alef: لا إله إلا الله, then letters that never join: د ا ر و ز.',
  'Arabic digits ١٢٣٤٥ and presentation forms ﻻ ﷲ and the word تفلسف again, mixed with Latin 123 and a ZWJ\u200d joiner.',
]

console.log('§1 the oracle: one cell per letter, none for a mark or the joiner, on both paths')
{
  const samples: Array<[string, number]> = [
    ['تفلسف', 5],
    ['بلا تفلسف', 9],
    ['نعم، هل هذا صحيح؟', 17],
    ['שלום עולם', 9],
    ['שָׁלוֹם', 4],
    ['می\u200Cخواهم', 7],
    ['مُحَمَّدٌ', 4],
    ['لا إله إلا الله', 15],
    ['د ا ر و ز', 9],
    ['The word تفلسف means philosophising', 35],
    ['The word تفلسف means 123 things', 31],
    ['**بلا تفلسف** — no tfalsif.', 27],
    ['١٢٣٤٥', 5],
    ['\ufefb', 1],
    ['\ufdf2', 1],
    ['\u0627\u0653', 1],
    ['a\u200db', 2],
  ]
  for (const [text, cells] of samples) {
    check(`"${text}" is ${cells} cells on the bun path and the node path`, stringWidth(text) === cells && nodeWidth(text) === cells, `${stringWidth(text)} / ${nodeWidth(text)}`)
  }
}

console.log('§2 the wrapper never packs a line wider than its columns')
{
  let sound = true
  const faults: string[] = []
  for (const row of ROWS) {
    for (const cols of [40, 76, 106]) {
      for (const line of wrapAnsi(row, cols, { hard: true, trim: false }).split('\n')) {
        if (stringWidth(line) > cols || nodeWidth(line) > cols) { sound = false; faults.push(`${cols}: "${line}"`) }
      }
    }
  }
  check('every wrapped line fits its columns on both paths', sound, faults.slice(0, 3).join(' | '))
}

console.log('§3 the rendered row: the right border lands on the frame at 80 and 110 columns')
for (const cols of [80, 110]) {
  const frame = await renderToString(
    mounted(h(Box, { width: cols, flexDirection: 'column', borderStyle: 'round' }, h(Box, { paddingX: 1, flexDirection: 'column' }, h(Markdown, { children: ROWS.join('\n\n') })))),
    cols,
  )
  const lines = frame.split('\n')
  const rtl = lines.filter(l => /[\u0590-\u06FF]/.test(l))
  check(`${cols}: the frame carries right-to-left rows`, rtl.length >= 4, String(rtl.length))
  const widths = lines.map(l => [stringWidth(l), nodeWidth(l)] as const)
  check(`${cols}: every line is exactly ${cols} cells on both paths`, widths.every(([b, n]) => b === cols && n === cols), JSON.stringify(widths.filter(([b, n]) => b !== cols || n !== cols)))
  check(`${cols}: every row ends in its border cell`, lines.every(l => /[│╮╯]$/.test(l)), lines.filter(l => !/[│╮╯]$/.test(l)).join(' | '))
  check(`${cols}: the first and last lines are the frame`, lines[0]!.startsWith('╭') && lines[lines.length - 1]!.startsWith('╰'))
}

console.log('§4 the live path: the frame writer addresses every row of the bordered frame so its border cell is the last column, at 80 and 110')
{
  const { FrameWriter } = await import('../../src/ink/frame-writer.js')
  const { optimizePatches } = await import('../../src/ink/patch-stream.js')
  const { writeDiffToTerminal } = await import('../../src/ink/session/delivery.js')
  const { composeScene, makeContext } = await import('../ink-runtime/frameHarness.js')
  const { getGraphemeSegmenter } = await import('../../src/utils/intl.js')
  const serialize = (diff: ReturnType<typeof optimizePatches>): string => {
    let captured = ''
    const fake = { stdout: { write(s: string) { captured += s; return true }, isTTY: false } }
    writeDiffToTerminal(fake as never, diff, true)
    return captured
  }
  const replayCells = (bytes: string, cols: number, rows: number): { grid: string[][]; overflow: string[] } => {
    const grid: string[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ' '))
    const overflow: string[] = []
    let x = 0
    let y = 0
    let i = 0
    while (i < bytes.length) {
      const ch = bytes[i]!
      if (ch === '\x1b') {
        if (bytes[i + 1] === '[') {
          let j = i + 2
          while (j < bytes.length && !/[A-Za-z@]/.test(bytes[j]!)) j++
          const params = bytes.slice(i + 2, j).replace(/^[?>]/, '').split(';').map(p => (p === '' ? undefined : Number(p)))
          const n = params[0] ?? 1
          switch (bytes[j]) {
            case 'A': y = Math.max(0, y - n); break
            case 'B': y = Math.min(rows - 1, y + n); break
            case 'C': x = Math.min(cols, x + n); break
            case 'D': x = Math.max(0, x - n); break
            case 'G': x = Math.max(0, Math.min(cols, n - 1)); break
            case 'd': y = Math.max(0, Math.min(rows - 1, n - 1)); break
            case 'H': case 'f': y = Math.max(0, Math.min(rows - 1, n - 1)); x = Math.max(0, Math.min(cols, (params[1] ?? 1) - 1)); break
            default: break
          }
          i = j + 1
          continue
        }
        if (bytes[i + 1] === ']') {
          const bel = bytes.indexOf('\x07', i)
          const st = bytes.indexOf('\x1b\\', i)
          const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st)
          i = end === -1 ? bytes.length : end + (bytes[end] === '\x07' ? 1 : 2)
          continue
        }
        i += 2
        continue
      }
      if (ch === '\r') { x = 0; i++; continue }
      if (ch === '\n') { y = Math.min(rows - 1, y + 1); i++; continue }
      let k = i
      while (k < bytes.length && bytes[k] !== '\x1b' && bytes[k] !== '\r' && bytes[k] !== '\n') k++
      for (const { segment } of getGraphemeSegmenter().segment(bytes.slice(i, k))) {
        const w = stringWidth(segment)
        if (x + w > cols) { overflow.push(`row ${y} column ${x} ${JSON.stringify(segment)}`); x += w; continue }
        if (w === 0) { if (x > 0) grid[y]![x - 1] += segment; continue }
        grid[y]![x] = segment
        for (let t = 1; t < w; t++) grid[y]![x + t] = ''
        x += w
      }
      i = k
    }
    return { grid, overflow }
  }
  for (const cols of [80, 110]) {
    const rows = 40
    const ctx = makeContext()
    const writer = new FrameWriter({ isTTY: true, stylePool: ctx.stylePool })
    const empty = composeScene({ name: 'empty', cols, rows, root: { kind: 'box' } }, ctx, undefined, { altScreen: true })
    const frame = composeScene(
      {
        name: 'rtl', cols, rows,
        root: {
          kind: 'box',
          style: { width: cols, flexDirection: 'column', borderStyle: 'round' },
          children: [{ kind: 'box', style: { paddingX: 1, flexDirection: 'column' }, children: ROWS.map(text => ({ kind: 'text' as const, text })) }],
        },
      },
      ctx, undefined, { altScreen: true },
    )
    const bytes = serialize(optimizePatches(writer.render(empty, frame, true, true)))
    const { grid, overflow } = replayCells(bytes, cols, rows)
    const framed = grid.map(row => row.join('')).filter(row => /[│╮╯]/.test(row))
    const rtl = framed.filter(row => /[\u0590-\u06FF]/.test(row))
    check(`${cols}: the writer paints right-to-left rows inside the frame`, rtl.length >= 6, String(rtl.length))
    check(`${cols}: no write addresses a cell beyond the last column`, overflow.length === 0, overflow.slice(0, 3).join(' | '))
    const borderCells = grid.filter(row => row.some(c => /[│╮╯]/.test(c))).map(row => row[cols - 1])
    check(`${cols}: every framed row holds its border in the last column`, borderCells.length >= 8 && borderCells.every(c => /^[│╮╯]/.test(c ?? '')), JSON.stringify(borderCells))
    check(`${cols}: the owner's word sits inside the frame`, rtl.some(row => row.includes('تفلسف') && /│$/.test(row)), rtl.filter(row => row.includes('تفلسف')).join(' | '))
  }
}

console.log(failures === 0 ? '\nrtl-row-border: GREEN' : `\nrtl-row-border: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
