#!/usr/bin/env bun
// gate-watch: src/utils/ansiSpans.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const j = (v: unknown): string => JSON.stringify(v)

const { DEFAULT_BG, parseAnsi } = await import('../../src/utils/ansiSpans.ts')
const E = '\u001b['
const FG = { r: 229, g: 229, b: 229 }

section('§1 plain text, the per-line reset, and the empty span')
{
  const lines = parseAnsi('plain\n\nsecond')
  check('a plain line is one default span', j(lines[0]) === j([{ text: 'plain', color: FG, bold: false }]), j(lines[0]))
  check('an empty line is one empty default span', j(lines[1]) === j([{ text: '', color: FG, bold: false }]), j(lines[1]))
  check('the default background is the dark grey the PNG paints', j(DEFAULT_BG) === j({ r: 30, g: 30, b: 30 }))
  const carried = parseAnsi(`${E}1;31mred bold\nnext line`)
  check('the pen does not carry across lines', j(carried[1]) === j([{ text: 'next line', color: FG, bold: false }]), j(carried[1]))
}

section('§2 the SGR codes: palette, bright, default, bold, reset, empty parameters')
{
  const [line] = parseAnsi(`${E}31mred${E}92mgreen${E}39mdefault${E}1mbold${E}0mreset${E}mreset2${E};1mbold3`)
  const spans = line!
  check('31 is the palette red', j(spans[0]) === j({ text: 'red', color: { r: 205, g: 49, b: 49 }, bold: false }), j(spans[0]))
  check('92 is the bright green', j(spans[1]!.color) === j({ r: 35, g: 209, b: 139 }))
  check('39 returns to the default foreground', j(spans[2]!.color) === j(FG))
  check('1 turns bold on and keeps the colour', spans[3]!.bold === true && j(spans[3]!.color) === j(FG))
  check('0 clears bold', spans[4]!.bold === false)
  check('an empty parameter list resets', spans[5]!.bold === false && j(spans[5]!.color) === j(FG))
  check('";1" is a reset followed by bold', spans[6]!.bold === true)
  const [kept] = parseAnsi(`${E}1m${E}31mstays bold`)
  check('nothing but 0 clears bold (no 22 handling)', kept![0]!.bold === true && j(kept![0]!.color) === j({ r: 205, g: 49, b: 49 }))
}

section('§3 the extended foregrounds: 256-colour table, cube, grey, truecolor, truncation')
{
  const colorOf = (sgr: string) => parseAnsi(`${E}${sgr}mx`)[0]![0]!.color
  check('38;5;9 is the VGA bright red', j(colorOf('38;5;9')) === j({ r: 255, g: 0, b: 0 }))
  check('38;5;16 is the cube origin (black)', j(colorOf('38;5;16')) === j({ r: 0, g: 0, b: 0 }))
  check('38;5;196 is the cube red (r level 5)', j(colorOf('38;5;196')) === j({ r: 255, g: 0, b: 0 }))
  check('38;5;244 is a grey from the ramp', j(colorOf('38;5;244')) === j({ r: 128, g: 128, b: 128 }))
  check('38;2;r;g;b is the raw triple', j(colorOf('38;2;1;2;3')) === j({ r: 1, g: 2, b: 3 }))
  check('a truncated 38;5 leaves the colour and reads the 5 as a code of its own (ignored)', j(colorOf('38;5')) === j(FG))
  check('a truncated 38;2;1;2 is ignored and its leftovers read as codes (1 = bold)', j(colorOf('38;2;1;2')) === j(FG) && parseAnsi(`${E}38;2;1;2mx`)[0]![0]!.bold === true)
  check("an unknown code's parameters are read as codes (48;5;31 paints red)", j(colorOf('48;5;31')) === j({ r: 205, g: 49, b: 49 }))
}

section('§4 sequences that are not SGR, an unterminated escape, a stray ESC')
{
  check('a cursor sequence is skipped whole', j(parseAnsi(`a${E}2Kb`)[0]!.map(s => s.text)) === j(['a', 'b']))
  check('an escape with no letter before the line end consumes the rest', j(parseAnsi(`keep${E}31;`)[0]!.map(s => s.text)) === j(['keep']))
  check('a lone ESC is consumed and the scan goes on', j(parseAnsi('a\u001bb')[0]!.map(s => s.text)) === j(['a', 'b']))
}

console.log(failures === 0 ? '\nprove-ansi-spans: ALL PASS' : `\nprove-ansi-spans: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
