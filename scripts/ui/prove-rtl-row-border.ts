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

console.log(failures === 0 ? '\nrtl-row-border: GREEN' : `\nrtl-row-border: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
