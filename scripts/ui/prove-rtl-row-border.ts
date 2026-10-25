#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import stripAnsi from 'strip-ansi'
import presentationData from '../../src/ink/arabicPresentationForms.json'
import unicodeRows from './fixtures/arabic-presentation-forms.json'

process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'rtl-row-border-home-')))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
const appleTerminal = process.argv.includes('--apple')
process.env.TERM_PROGRAM = appleTerminal ? 'Apple_Terminal' : 'xterm'
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
  'Multiple joiners a\u200c\u200db and a wide base 漢\u200d next to Latin.',
]

console.log(`§1 the oracle: letters, marks and ${process.env.TERM_PROGRAM} joiners agree on both paths`)
{
  const samples: Array<[string, number]> = [
    ['تفلسف', 5],
    ['بلا تفلسف', 9],
    ['نعم، هل هذا صحيح؟', 17],
    ['שלום עולם', 9],
    ['שָׁלוֹם', 4],
    ['می\u200Cخواهم', appleTerminal ? 8 : 7],
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
    ['a\u200db', appleTerminal ? 3 : 2],
    ['a\u200cb', appleTerminal ? 3 : 2],
    ['a\u200c\u200db', appleTerminal ? 4 : 2],
    ['\u200c', appleTerminal ? 1 : 0],
    ['\u200d', appleTerminal ? 1 : 0],
    ['\u2068تفلسف\u2069', 5],
    ['\u2066\u2067\u2068\u2069', 0],
    ['👨\u200d👩\u200d👧\u200d👦', 2],
  ]
  for (const [text, cells] of samples) {
    check(`"${text}" is ${cells} cells on the bun path and the node path`, stringWidth(text) === cells && nodeWidth(text) === cells, `${stringWidth(text)} / ${nodeWidth(text)}`)
  }
}

console.log('§2 the wrapper never packs a line wider than its columns')
{
  let sound = true
  const faults: string[] = []
  for (const row of [...ROWS, 'می\u200cخواهم '.repeat(24), `\x1b[31m${'a\u200db '.repeat(40)}\x1b[0m`]) {
    for (const cols of [40, 76, 106]) {
      const lines = wrapAnsi(row, cols, { hard: true, trim: false }).split('\n')
      if (stripAnsi(lines.join('')) !== stripAnsi(row)) { sound = false; faults.push(`${cols}: wrapping changed source text`) }
      for (const line of lines) {
        if (stringWidth(line) > cols || nodeWidth(stripAnsi(line)) > cols) { sound = false; faults.push(`${cols}: "${line}"`) }
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
    const rtl = framed.filter(row => /[\u0590-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(row))
    check(`${cols}: the writer paints right-to-left rows inside the frame`, rtl.length >= 6, String(rtl.length))
    check(`${cols}: no write addresses a cell beyond the last column`, overflow.length === 0, overflow.slice(0, 3).join(' | '))
    const borderCells = grid.filter(row => row.some(c => /[│╮╯]/.test(c))).map(row => row[cols - 1])
    check(`${cols}: every framed row holds its border in the last column`, borderCells.length >= 8 && borderCells.every(c => /^[│╮╯]/.test(c ?? '')), JSON.stringify(borderCells))
    const ownerWord = appleTerminal ? '\u2068\uFED2\u2069\u2068\uFEB4\u2069\u2068\uFEE0\u2069\u2068\uFED4\u2069\u2068\uFE97\u2069' : 'تفلسف'
    check(`${cols}: the owner's word sits inside the frame`, rtl.some(row => row.includes(ownerWord) && /│$/.test(row)))
    check(`${cols}: terminal bytes carry isolation only on Apple_Terminal`, bytes.includes('\u2068') === appleTerminal)
    const plain = writer.fullFrameText(frame)
    check(`${cols}: the transcript projection stays logical and unshaped`, plain.includes('تفلسف') && !/[\u2066-\u2069]/.test(plain))
    check(`${cols}: an unchanged frame emits no bytes`, writer.render(frame, frame, true, true).length === 0)
    const latin = composeScene({ name: 'latin', cols, rows, root: { kind: 'text', text: 'Only Latin text, 123.' } }, ctx, undefined, { altScreen: true })
    const latinBytes = serialize(optimizePatches(writer.render(empty, latin, true, true)))
    check(`${cols}: a row without RTL carries no isolates`, !/[\u2066-\u2069]/.test(latinBytes))
    const terminal: string | undefined = process.env.TERM_PROGRAM
    process.env.TERM_PROGRAM = 'xterm'
    check(`${cols}: non-RTL terminal bytes remain identical across profiles`, latinBytes === serialize(optimizePatches(writer.render(empty, latin, true, true))))
    process.env.TERM_PROGRAM = terminal
  }
}

console.log('§5 contextual forms come from the Unicode source rows')
{
  const forms: Record<string, Record<string, number>> = {}
  const ligatures: Record<string, Record<string, number>> = {}
  for (const row of unicodeRows.unicodeData) {
    const fields = row.split(';')
    const [tag, ...points] = fields[5]!.split(' ')
    const form = tag!.slice(1, -1)
    const target = points.length === 1 ? forms : ligatures
    const key = points[points.length - 1]!
    ;(target[key] ??= {})[form] = Number.parseInt(fields[0]!, 16)
  }
  const joining: Record<string, string> = {}
  for (const row of unicodeRows.arabicShaping) {
    const fields = row.split(';').map(s => s.trim())
    joining[fields[0]!] = fields[2]!
  }
  check('every generated letter/form pair matches its Unicode decomposition', JSON.stringify(forms) === JSON.stringify(presentationData.forms))
  check('every generated lam-alef pair matches its Unicode decomposition', JSON.stringify(ligatures) === JSON.stringify(presentationData.lamAlef))
  check('every joining type matches ArabicShaping', JSON.stringify(joining) === JSON.stringify(presentationData.joining))
  const { terminalTextCells } = await import('../../src/ink/session/terminalProfile.js')
  check('only the named Apple profile enables shaping and spacing joiners', ['xterm', 'iTerm.app', 'constructor', 'toString', ''].every(name => {
    const profile = terminalTextCells({ TERM_PROGRAM: name })
    return profile.joinerCells === 0 && !profile.shapeRtl
  }) && terminalTextCells({ TERM_PROGRAM: 'Apple_Terminal' }).shapeRtl)
  const { shapeBidiForTerminal } = await import('../../src/ink/bidi.js')
  const { getGraphemeSegmenter } = await import('../../src/utils/intl.js')
  const paint = (text: string): string => shapeBidiForTerminal(Array.from(getGraphemeSegmenter().segment(text), ({ segment }) => ({ value: segment, width: stringWidth(segment), styleId: 0, hyperlink: undefined }))).map(c => c.value).join('')
  const isolated = (text: string): string => Array.from(text, ch => `\u2068${ch}\u2069`).join('')
  const phrase = '**بلا تفلسف** — no tfalsif.'
  const expected = '**' + isolated('\uFED2\uFEB4\uFEE0\uFED4\uFE97  \uFEFC\uFE91') + '** — no tfalsif.'
  check('the owner phrase has the exact joined visual forms, mirrored order and zero-width isolates', paint(phrase) === expected, JSON.stringify(paint(phrase)))
  check('the shaped owner phrase keeps every source cell', stringWidth(paint(phrase)) === stringWidth(phrase))
  check('ZWNJ breaks joining and retains its cell without emitting the control', paint('ب\u200cب').replace(/[\u2068\u2069]/g, '') === '\uFE8F\uFE8F ')
  check('ZWJ joins and retains its cell without emitting the control', paint('ب\u200dب').replace(/[\u2068\u2069]/g, '') === '\uFE90\uFE91 ')
  check('shaping never changes an ASCII row', paint('Latin 123 [brackets]') === 'Latin 123 [brackets]')
  check('an emoji cluster beside Arabic keeps its own joiners and code points', paint('ب 👨\u200d👩\u200d👧\u200d👦 ب').includes('👨\u200d👩\u200d👧\u200d👦'))
  const pointed = paint('مُحَمَّدٌ שָׁלוֹם')
  check('a combining mark never shares an isolate with its base', Array.from(pointed.matchAll(/\u2068([^\u2069]*)\u2069/g), match => match[1]!).every(value => Array.from(value).length === 1))
  const persian = paint('می\u200cخواهم')
  check('a joiner replacement never shares an isolate with its Arabic base', Array.from(persian.matchAll(/\u2068([^\u2069]*)\u2069/g), match => match[1]!).every(value => stringWidth(value) === 1))
}

if (!appleTerminal) {
  const apple = spawnSync(process.execPath, [import.meta.filename, '--apple'], { env: process.env, encoding: 'utf8' })
  process.stdout.write(apple.stdout ?? '')
  process.stderr.write(apple.stderr ?? '')
  check('Apple_Terminal width and border arm', apple.status === 0, String(apple.status))
}

console.log(failures === 0 ? '\nrtl-row-border: GREEN' : `\nrtl-row-border: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
