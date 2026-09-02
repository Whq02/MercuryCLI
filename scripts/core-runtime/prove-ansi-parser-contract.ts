#!/usr/bin/env bun
// ============================================================================
//  scripts/core-runtime/prove-ansi-parser-contract.ts —
// the display-ANSI semantic parser contract, over the PUBLIC seam
//  (src/ink/termio/display.ts + display-types.ts: Parser + the Action
//  vocabulary Ansi.tsx consumes; the one-hop re-export barrel retired with
//  the orphan burn-down). Built GREEN ON THE OLD BODY FIRST (parser.ts/sgr.ts/esc.ts),
//  then the native cut must pass with the goldens UNCHANGED.
//
//  LAWS:
//    • SGR-FOLD (oracle differential) — an INDEPENDENT SGR interpreter,
//      derived from the public escape semantics (ECMA-48 §8.3.117 + xterm/
//      kitty extensions) with the old body's quirks pinned EXPLICITLY
//      (each carries a Q-tag below), agrees field-by-field with the
//      Parser's folded style over a curated table + LCG-random sequences
//      across the full attribute space (16/256/truecolor · bold/dim/italic/
//      underline(+styles)/blink/inverse/hidden/strike/overline · partial +
//      full resets · colon AND semicolon extended-color grammars ·
//      malformed introducers).
//    • SGR-3WAY — on the ink-runtime ansiEmulator's supported vocabulary
//      subset, the Parser, the oracle, and scripts/ink-runtime/
//      ansiEmulator.ts (the T2-trusted oracle) agree three ways.
//    • ACTION-STREAM GOLDENS — canonical shell outputs (ls --color, git
//      diff/log, npm, pytest, ripgrep, cursor/erase bursts, OSC titles +
//      links + tab-status, DCS/APC/SS3 passthrough, BEL, grapheme batching
//      over CJK/emoji/ZWJ/NFD, malformed tails) pin the EXACT serialized
//      Action stream.
//    • SPLIT-INVARIANCE — the same bytes chunked at EVERY split boundary
//      produce the same NORMALIZED action stream (adjacent same-style text
//      merged: per-feed grapheme re-batching is the characterized streaming
//      behavior; the merged projection is what Ansi.tsx consumes).
//    • TOTALITY / NO-FABRICATION — arbitrary byte soup never throws, whole
//      vs char-by-char feeding agree on the normalized stream, every action
//      type stays inside the vocabulary, and emitted text is a subsequence
//      of the input (no invented bytes).
//    • WIDTH — the grapheme width classification is pinned as data
//      (multi-codepoint ⇒ 2 · emoji ranges · the East-Asian-Wide table),
//      including its characterized quirks (Q-WIDTH below).
//    • STATE — style/link state carries across feeds; reset() restores the
//      boot state; link start/stop pairing tracks OSC 8.
//
//  PINNED OLD-BODY QUIRKS (deliberately preserved, each pinned by a law):
//    Q-21-DOUBLE      SGR 21 = double underline (kitty semantics), NOT
//                     bold-off (the ink-runtime emulator's 21 differs — it is
//                     excluded from the 3-way alphabet).
//    Q-EXT-FALLTHROUGH a malformed 38/48/58 extended-color introducer
//                     consumes ONLY itself; the following params are then
//                     interpreted individually (38;5 ⇒ blink · 38;2 ⇒ dim).
//    Q-COLON-LOOKAHEAD a colon-form introducer whose subparams don't parse
//                     STILL resolves color from the following semicolon
//                     params, but advances only 1 (38:9;5;123 ⇒ fg=idx123
//                     AND blink from the still-processed `5`).
//    Q-MIXED-LOST     the mixed form 38;2:R:G:B loses the subparams
//                     (⇒ dim from the bare `2`).
//    Q-PRIVATE-IGNORED a ?/>/= private marker is stripped and ignored for
//                     every non-SGR, non-mode dispatch (\x1b[?5A ⇒ up 5).
//    Q-INTERMEDIATE-SGR a trailing intermediate is stripped before SGR
//                     dispatch (\x1b[1$m ⇒ bold).
//    Q-COUNT-0        explicit 0 params pass through (\x1b[0B ⇒ down 0).
//    Q-TAIL-DROPPED   a trailing incomplete sequence never emerges from
//                     feed() (no flush on the display path).
//    Q-WIDTH          any multi-codepoint grapheme is width 2 (NFD é ⇒ 2,
//                     CRLF ⇒ 2, the clustered ｶﾞ pair ⇒ 2) while NFC é ⇒ 1
//                     and a LONE halfwidth ｶ U+FF76 ⇒ 1 (the wide row stops
//                     at FF60; halfwidth katakana starts at FF61).
//                     carve-out: a base + ONLY Hebrew niqqud / Arabic
//                     harakat marks takes the BASE's width (the marks are
//                     zero-width; aligned with the stringWidth oracle).
//
//  Run:   ~/.bun/bin/bun run scripts/core-runtime/prove-ansi-parser-contract.ts
//  Author goldens (review before embedding): … --dump
// ============================================================================
import { Parser } from '../../src/ink/termio/display.js'
import {
  type Action,
  type Color,
  defaultStyle,
  type TextStyle,
} from '../../src/ink/termio/display-types.js'
import {
  applySgrParams,
  defaultSgr,
  type SgrState,
} from '../ink-runtime/ansiEmulator.js'

const DUMP = process.argv.includes('--dump')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

// ── Canonical serialization (body-independent: sorted keys, style as a
//    diff-from-default token list) ──────────────────────────────────────────
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  if (v && typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>).sort()
    return `{${keys
      .map(k => `${k}:${canon((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v)
}

function serColor(c: Color): string {
  switch (c.type) {
    case 'default':
      return 'd'
    case 'named':
      return `n:${c.name}`
    case 'indexed':
      return `i:${c.index}`
    case 'rgb':
      return `r:${c.r},${c.g},${c.b}`
  }
}

function serStyle(s: TextStyle): string {
  const parts: string[] = []
  if (s.bold) parts.push('bold')
  if (s.dim) parts.push('dim')
  if (s.italic) parts.push('italic')
  if (s.underline !== 'none') parts.push(`ul=${s.underline}`)
  if (s.blink) parts.push('blink')
  if (s.inverse) parts.push('inverse')
  if (s.hidden) parts.push('hidden')
  if (s.strikethrough) parts.push('strike')
  if (s.overline) parts.push('over')
  if (s.fg.type !== 'default') parts.push(`fg=${serColor(s.fg)}`)
  if (s.bg.type !== 'default') parts.push(`bg=${serColor(s.bg)}`)
  if (s.underlineColor.type !== 'default')
    parts.push(`ulc=${serColor(s.underlineColor)}`)
  return parts.join(',')
}

function serAction(a: Action): string {
  switch (a.type) {
    case 'text':
      return `text ${JSON.stringify(a.graphemes.map(g => g.value).join(''))} w=${a.graphemes.map(g => g.width).join('')} [${serStyle(a.style)}]`
    case 'bell':
      return 'bell'
    case 'reset':
      return 'reset'
    case 'unknown':
      return `unknown ${JSON.stringify(a.sequence)}`
    case 'sgr':
      return `sgr ${JSON.stringify(a.params)}`
    default:
      return `${a.type} ${canon((a as { action: unknown }).action)}`
  }
}

function parseAll(input: string): Action[] {
  return new Parser().feed(input)
}

function serStream(input: string): string[] {
  return parseAll(input).map(serAction)
}

// Normalized projection: adjacent text actions with the same style merge
// (per-feed grapheme batching is deliberately NOT split-invariant; the merged
// text+style runs — what Ansi.tsx renders — are).
function normalize(actions: Action[]): string[] {
  const out: string[] = []
  let text = ''
  let styleKey = ''
  const flush = (): void => {
    if (text) {
      out.push(`text ${JSON.stringify(text)} [${styleKey}]`)
      text = ''
    }
  }
  for (const a of actions) {
    if (a.type === 'text') {
      const key = serStyle(a.style)
      if (text && key !== styleKey) flush()
      styleKey = key
      text += a.graphemes.map(g => g.value).join('')
    } else {
      flush()
      out.push(serAction(a))
    }
  }
  flush()
  return out
}

function feedChunks(chunks: string[]): Action[] {
  const p = new Parser()
  const out: Action[] = []
  for (const c of chunks) out.push(...p.feed(c))
  return out
}

// ============================================================================
//  THE ORACLE — an independent SGR interpreter.
//
//  Derived from the public grammar: a parameter string is `;`-separated
//  groups; a group may carry `:`-separated subparameters (ECMA-48 §5.4.2);
//  digits accumulate inside a unit, any other byte inside a unit is ignored;
//  an empty unit is an absent value; an absent group value means 0. The fold
//  applies each attribute per the xterm/kitty SGR table, with the pinned
//  quirks above. Colors are encoded as strings immediately (a deliberately
//  different state model from the body's tagged unions).
// ============================================================================
type OStyle = {
  bold: boolean
  dim: boolean
  italic: boolean
  underline: 'none' | 'single' | 'double' | 'curly' | 'dotted' | 'dashed'
  blink: boolean
  inverse: boolean
  hidden: boolean
  strike: boolean
  over: boolean
  fg: string // serColor encoding
  bg: string
  ulc: string
}

function oDefault(): OStyle {
  return {
    bold: false,
    dim: false,
    italic: false,
    underline: 'none',
    blink: false,
    inverse: false,
    hidden: false,
    strike: false,
    over: false,
    fg: 'd',
    bg: 'd',
    ulc: 'd',
  }
}

const O_NAMED = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const

const O_UNDERLINE = [
  'none',
  'single',
  'double',
  'curly',
  'dotted',
  'dashed',
] as const

type OGroup = { n: number | null; colon: boolean; sub: number[] }

function oGroups(raw: string): OGroup[] {
  if (raw === '') return [{ n: 0, colon: false, sub: [] }]
  return raw.split(';').map(piece => {
    const units = piece.split(':').map(u => {
      const digits = u.replace(/[^0-9]/g, '')
      return digits === '' ? null : parseInt(digits, 10)
    })
    return {
      n: units[0] ?? null,
      colon: units.length > 1,
      sub: units.slice(1).filter((v): v is number => v !== null),
    }
  })
}

/** Resolve a 38/48/58 extended-color introducer at groups[i].
 *  Returns the color encoding + how many EXTRA groups the fold consumes.
 *  Q-COLON-LOOKAHEAD / Q-MIXED-LOST / Q-EXT-FALLTHROUGH live here. */
function oExtColor(
  groups: OGroup[],
  i: number,
): { color: string; extra: number } | null {
  const g = groups[i]!
  if (g.colon && g.sub.length >= 1) {
    if (g.sub[0] === 5 && g.sub.length >= 2)
      return { color: `i:${g.sub[1]}`, extra: 0 }
    if (g.sub[0] === 2 && g.sub.length >= 4) {
      const off = g.sub.length >= 5 ? 1 : 0 // optional colorspace id
      return {
        color: `r:${g.sub[1 + off]},${g.sub[2 + off]},${g.sub[3 + off]}`,
        extra: 0,
      }
    }
  }
  // Semicolon lookahead — applies even after a failed colon form
  // (Q-COLON-LOOKAHEAD: a colon introducer still advances only 1).
  const next = groups[i + 1]
  if (!next) return null
  if (next.n === 5 && groups[i + 2]?.n != null) {
    return { color: `i:${groups[i + 2]!.n}`, extra: g.colon ? 0 : 2 }
  }
  if (next.n === 2) {
    const r = groups[i + 2]?.n
    const gg = groups[i + 3]?.n
    const b = groups[i + 4]?.n
    if (r != null && gg != null && b != null) {
      return { color: `r:${r},${gg},${b}`, extra: g.colon ? 0 : 4 }
    }
  }
  return null
}

function oracleFold(raw: string, prev: OStyle): OStyle {
  const groups = oGroups(raw)
  let s: OStyle = { ...prev }
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!
    const code = g.n ?? 0
    if (code === 0) {
      s = oDefault()
      continue
    }
    if (code === 1) { s.bold = true; continue }
    if (code === 2) { s.dim = true; continue }
    if (code === 3) { s.italic = true; continue }
    if (code === 4) {
      s.underline = g.colon
        ? (O_UNDERLINE[g.sub[0]!] ?? 'single')
        : 'single'
      continue
    }
    if (code === 5 || code === 6) { s.blink = true; continue }
    if (code === 7) { s.inverse = true; continue }
    if (code === 8) { s.hidden = true; continue }
    if (code === 9) { s.strike = true; continue }
    if (code === 21) { s.underline = 'double'; continue } // Q-21-DOUBLE
    if (code === 22) { s.bold = false; s.dim = false; continue }
    if (code === 23) { s.italic = false; continue }
    if (code === 24) { s.underline = 'none'; continue }
    if (code === 25) { s.blink = false; continue }
    if (code === 27) { s.inverse = false; continue }
    if (code === 28) { s.hidden = false; continue }
    if (code === 29) { s.strike = false; continue }
    if (code === 53) { s.over = true; continue }
    if (code === 55) { s.over = false; continue }
    if (code >= 30 && code <= 37) { s.fg = `n:${O_NAMED[code - 30]}`; continue }
    if (code === 39) { s.fg = 'd'; continue }
    if (code >= 40 && code <= 47) { s.bg = `n:${O_NAMED[code - 40]}`; continue }
    if (code === 49) { s.bg = 'd'; continue }
    if (code >= 90 && code <= 97) { s.fg = `n:${O_NAMED[code - 90 + 8]}`; continue }
    if (code >= 100 && code <= 107) { s.bg = `n:${O_NAMED[code - 100 + 8]}`; continue }
    if (code === 38 || code === 48 || code === 58) {
      const c = oExtColor(groups, i)
      if (c) {
        if (code === 38) s.fg = c.color
        else if (code === 48) s.bg = c.color
        else s.ulc = c.color
        i += c.extra
      }
      // Q-EXT-FALLTHROUGH: malformed introducer consumes only itself.
      continue
    }
    if (code === 59) { s.ulc = 'd'; continue }
    // Unknown codes are ignored.
  }
  return s
}

function oSer(s: OStyle): string {
  const parts: string[] = []
  if (s.bold) parts.push('bold')
  if (s.dim) parts.push('dim')
  if (s.italic) parts.push('italic')
  if (s.underline !== 'none') parts.push(`ul=${s.underline}`)
  if (s.blink) parts.push('blink')
  if (s.inverse) parts.push('inverse')
  if (s.hidden) parts.push('hidden')
  if (s.strike) parts.push('strike')
  if (s.over) parts.push('over')
  if (s.fg !== 'd') parts.push(`fg=${s.fg}`)
  if (s.bg !== 'd') parts.push(`bg=${s.bg}`)
  if (s.ulc !== 'd') parts.push(`ulc=${s.ulc}`)
  return parts.join(',')
}

/** Fold param strings through the PARSER (via real CSI m sequences). */
function parserFold(paramStrs: string[]): TextStyle {
  const p = new Parser()
  for (const raw of paramStrs) p.feed(`\x1b[${raw}m`)
  return p.style
}

function oracleFoldAll(paramStrs: string[]): OStyle {
  let s = oDefault()
  for (const raw of paramStrs) s = oracleFold(raw, s)
  return s
}

// ============================================================================
//  LAW SGR-FOLD — curated vectors
// ============================================================================
{
  const vectors: string[][] = [
    [''], ['0'], ['1'], ['2'], ['3'], ['4'], ['5'], ['6'], ['7'], ['8'],
    ['9'], ['21'], ['53'],
    ['1', '22'], ['2', '22'], ['1;2', '22'], ['3', '23'], ['4', '24'],
    ['5', '25'], ['7', '27'], ['8', '28'], ['9', '29'], ['53', '55'],
    ['31'], ['37'], ['90'], ['97'], ['39'], ['31', '39'],
    ['41'], ['47'], ['100'], ['107'], ['49'], ['44', '49'],
    ['38;5;196'], ['38;5;0'], ['38;5;255'], ['38;5;999'],
    ['48;5;21'], ['58;5;33'], ['58;5;33', '59'],
    ['38;2;255;0;0'], ['48;2;1;2;3'], ['58;2;10;20;30'],
    ['38:5:196'], ['48:5:21'], ['38:2:255:0:0'], ['38:2:1:255:0:0'],
    ['48:2:9:8:7'], ['58:2:1:2:3'],
    ['4:0'], ['4:1'], ['4:2'], ['4:3'], ['4:4'], ['4:5'], ['4:6'], ['4:'],
    ['1;31;4;9'], ['1;31', '0'], ['1;31', ''], ['31;1;2;3;4;5;7;8;9;53'],
    [';31'], ['31;'], [';'], ['::'], [':5'],
    ['38'], ['48'], ['58'], ['38;5'], ['48;5'], ['38;2'], ['38;2;10;20'],
    ['38;5;'], ['38;2;;;'], ['38:9'], ['38:9;5;123'], ['38;2:255:0:0'],
    ['38;5;196;48;5;21'], ['38;2;255;0;0;1'], ['1;38;5;196;4'],
    ['77'], ['111'], ['999'], ['30;38;99;31'],
    ['21;24'], ['4:3;24'], ['31', '32', '33'], ['0;1;0;2'],
  ]
  for (const v of vectors) {
    const got = serStyle(parserFold(v))
    const want = oSer(oracleFoldAll(v))
    check(`sgr-fold curated [${v.join(' | ')}]`, got === want, `parser=[${got}] oracle=[${want}]`)
  }
}

// ============================================================================
//  LAW SGR-FOLD — LCG-random sequences over the full attribute space
// ============================================================================
{
  const rnd = lcg(0x20a11ce)
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!
  const num = (max: number): string => String(Math.floor(rnd() * max))
  const fragment = (): string => {
    const simple = [
      '', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '21', '22',
      '23', '24', '25', '27', '28', '29', '53', '55', '39', '49', '59',
      '30', '31', '32', '33', '34', '35', '36', '37',
      '40', '41', '42', '43', '44', '45', '46', '47',
      '90', '91', '92', '93', '94', '95', '96', '97',
      '100', '101', '102', '103', '104', '105', '106', '107',
      '38', '48', '58', '77', '111', '999', '4:0', '4:1', '4:2', '4:3',
      '4:4', '4:5', '4:9', '4:', ':5', '1:2',
    ]
    const r = rnd()
    if (r < 0.55) return pick(simple)
    if (r < 0.63) return `${pick(['38', '48', '58'])};5;${num(300)}`
    if (r < 0.71) return `${pick(['38', '48', '58'])};2;${num(300)};${num(300)};${num(300)}`
    if (r < 0.78) return `${pick(['38', '48', '58'])}:5:${num(300)}`
    if (r < 0.85) return `${pick(['38', '48', '58'])}:2:${num(300)}:${num(300)}:${num(300)}`
    if (r < 0.89) return `${pick(['38', '48'])}:2:${num(9)}:${num(255)}:${num(255)}:${num(255)}`
    if (r < 0.93) return `${pick(['38', '48', '58'])};5`
    if (r < 0.97) return `${pick(['38', '48', '58'])};2;${num(255)}`
    return `${pick(['38', '48'])}:9`
  }
  let bad = 0
  const N = 2500
  for (let t = 0; t < N; t++) {
    const runs: string[] = []
    const nRuns = 1 + Math.floor(rnd() * 3)
    for (let r = 0; r < nRuns; r++) {
      const parts: string[] = []
      const n = 1 + Math.floor(rnd() * 7)
      for (let k = 0; k < n; k++) parts.push(fragment())
      runs.push(parts.join(';'))
    }
    const got = serStyle(parserFold(runs))
    const want = oSer(oracleFoldAll(runs))
    if (got !== want) {
      bad++
      if (bad <= 5)
        console.log(`  [sgr-fold random diverged] [${runs.join(' | ')}]\n    parser=[${got}]\n    oracle=[${want}]`)
    }
  }
  check(`sgr-fold random: ${N} sequences agree with the oracle`, bad === 0, `${bad} diverged`)
  checks += N - 1 // each vector is a real check; the aggregate reported once
}

// ============================================================================
//  LAW SGR-3WAY — parser vs oracle vs the ink-runtime ansiEmulator on the
//  emulator-supported vocabulary (21 excluded: Q-21-DOUBLE names the split).
// ============================================================================
{
  const rnd = lcg(0xbed40c)
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!
  const num = (max: number): string => String(Math.floor(rnd() * max))
  const fragment = (): string => {
    const simple = [
      '0', '1', '2', '3', '4', '7', '9', '22', '23', '24', '27', '29',
      '30', '31', '32', '33', '34', '35', '36', '37', '39',
      '40', '41', '42', '43', '44', '45', '46', '47', '49',
      '90', '91', '92', '93', '94', '95', '96', '97',
      '100', '101', '102', '103', '104', '105', '106', '107',
    ]
    const r = rnd()
    if (r < 0.7) return pick(simple)
    if (r < 0.85) return `${pick(['38', '48'])};5;${num(256)}`
    return `${pick(['38', '48'])};2;${num(256)};${num(256)};${num(256)}`
  }
  const toBedrockColor = (c: Color, base: number, ext: number): string => {
    switch (c.type) {
      case 'default':
        return 'default'
      case 'named': {
        const idx = O_NAMED.indexOf(c.name as (typeof O_NAMED)[number])
        return String(idx < 8 ? base + idx : base + 60 + idx - 8)
      }
      case 'indexed':
        return `${ext};5;${c.index}`
      case 'rgb':
        return `${ext};2;${c.r};${c.g};${c.b}`
    }
  }
  const styleToBedrock = (s: TextStyle): SgrState => ({
    bold: s.bold,
    dim: s.dim,
    italic: s.italic,
    underline: s.underline !== 'none',
    inverse: s.inverse,
    strike: s.strikethrough,
    fg: toBedrockColor(s.fg, 30, 38),
    bg: toBedrockColor(s.bg, 40, 48),
  })
  const oToBedrock = (s: OStyle): SgrState => {
    const color = (enc: string, base: number, ext: number): string => {
      if (enc === 'd') return 'default'
      if (enc.startsWith('n:')) {
        const idx = O_NAMED.indexOf(enc.slice(2) as (typeof O_NAMED)[number])
        return String(idx < 8 ? base + idx : base + 60 + idx - 8)
      }
      if (enc.startsWith('i:')) return `${ext};5;${enc.slice(2)}`
      return `${ext};2;${enc.slice(2).split(',').join(';')}`
    }
    return {
      bold: s.bold,
      dim: s.dim,
      italic: s.italic,
      underline: s.underline !== 'none',
      inverse: s.inverse,
      strike: s.strike,
      fg: color(s.fg, 30, 38),
      bg: color(s.bg, 40, 48),
    }
  }
  let bad = 0
  const N = 800
  for (let t = 0; t < N; t++) {
    const parts: string[] = []
    const n = 1 + Math.floor(rnd() * 6)
    for (let k = 0; k < n; k++) parts.push(fragment())
    const raw = parts.join(';')
    const fromParser = canon(styleToBedrock(parserFold([raw])))
    const fromOracle = canon(oToBedrock(oracleFold(raw, oDefault())))
    const bed = defaultSgr()
    applySgrParams(bed, raw.split(';').map(v => parseInt(v, 10)))
    const fromBedrock = canon(bed)
    if (fromParser !== fromBedrock || fromOracle !== fromBedrock) {
      bad++
      if (bad <= 5)
        console.log(`  [sgr-3way diverged] [${raw}]\n    parser=${fromParser}\n    oracle=${fromOracle}\n    bedrock=${fromBedrock}`)
    }
  }
  check(`sgr-3way: ${N} sequences agree parser=oracle=bedrock`, bad === 0, `${bad} diverged`)
  checks += N - 1
}

// ============================================================================
//  ACTION-STREAM GOLDENS
// ============================================================================
type Golden = { name: string; input: string; expected: string[] }

const GOLDENS: Golden[] = [
  {
    name: 'ls-color',
    input:
      'total 16\n\x1b[0m\x1b[01;34mdist\x1b[0m  \x1b[01;32mbuild.sh\x1b[0m  \x1b[01;36mlink.ts\x1b[0m  README.md\n',
    expected: [
      "text \"total 16\\n\" w=111111111 []",
      "text \"dist\" w=1111 [bold,fg=n:blue]",
      "text \"  \" w=11 []",
      "text \"build.sh\" w=11111111 [bold,fg=n:green]",
      "text \"  \" w=11 []",
      "text \"link.ts\" w=1111111 [bold,fg=n:cyan]",
      "text \"  README.md\\n\" w=111111111111 []",
    ]
  },
  {
    name: 'git-diff',
    input:
      '\x1b[1mdiff --git a/x.ts b/x.ts\x1b[m\n\x1b[36m@@ -1,3 +1,4 @@\x1b[m\n\x1b[31m-const a = 1\x1b[m\n\x1b[32m+const a = 2\x1b[m\n \x1b[mcontext\x1b[m\n',
    expected: [
      "text \"diff --git a/x.ts b/x.ts\" w=111111111111111111111111 [bold]",
      "text \"\\n\" w=1 []",
      "text \"@@ -1,3 +1,4 @@\" w=111111111111111 [fg=n:cyan]",
      "text \"\\n\" w=1 []",
      "text \"-const a = 1\" w=111111111111 [fg=n:red]",
      "text \"\\n\" w=1 []",
      "text \"+const a = 2\" w=111111111111 [fg=n:green]",
      "text \"\\n \" w=11 []",
      "text \"context\" w=1111111 []",
      "text \"\\n\" w=1 []",
    ],
  },
  {
    name: 'git-log-decorate',
    input:
      '\x1b[33mabc1234\x1b[m\x1b[33m (\x1b[m\x1b[1;36mHEAD -> \x1b[m\x1b[1;32mmain\x1b[m\x1b[33m)\x1b[m fix: the thing\n',
    expected: [
      "text \"abc1234\" w=1111111 [fg=n:yellow]",
      "text \" (\" w=11 [fg=n:yellow]",
      "text \"HEAD -> \" w=11111111 [bold,fg=n:cyan]",
      "text \"main\" w=1111 [bold,fg=n:green]",
      "text \")\" w=1 [fg=n:yellow]",
      "text \" fix: the thing\\n\" w=1111111111111111 []",
    ],
  },
  {
    name: 'npm-err',
    input:
      '\x1b[37;40mnpm\x1b[0m \x1b[0m\x1b[31;40mERR!\x1b[0m \x1b[0m\x1b[35mcode\x1b[0m ELIFECYCLE\n',
    expected: [
      "text \"npm\" w=111 [fg=n:white,bg=n:black]",
      "text \" \" w=1 []",
      "text \"ERR!\" w=1111 [fg=n:red,bg=n:black]",
      "text \" \" w=1 []",
      "text \"code\" w=1111 [fg=n:magenta]",
      "text \" ELIFECYCLE\\n\" w=111111111111 []",
    ],
  },
  {
    name: 'pytest',
    input:
      'test_a.py \x1b[32m.\x1b[0m\x1b[32m.\x1b[0m\x1b[31mF\x1b[0m\n\x1b[1m\x1b[31mFAILED\x1b[0m test_a.py::test_c\n\x1b[31m\x1b[1m1 failed\x1b[0m\x1b[31m, \x1b[32m2 passed\x1b[0m\n',
    expected: [
      "text \"test_a.py \" w=1111111111 []",
      "text \".\" w=1 [fg=n:green]",
      "text \".\" w=1 [fg=n:green]",
      "text \"F\" w=1 [fg=n:red]",
      "text \"\\n\" w=1 []",
      "text \"FAILED\" w=111111 [bold,fg=n:red]",
      "text \" test_a.py::test_c\\n\" w=1111111111111111111 []",
      "text \"1 failed\" w=11111111 [bold,fg=n:red]",
      "text \", \" w=11 [fg=n:red]",
      "text \"2 passed\" w=11111111 [fg=n:green]",
      "text \"\\n\" w=1 []",
    ],
  },
  {
    name: 'ripgrep',
    input:
      '\x1b[0m\x1b[35msrc/a.ts\x1b[0m\n\x1b[0m\x1b[32m12\x1b[0m:\x1b[0m\x1b[1m\x1b[31mmatch\x1b[0m rest\n',
    expected: [
      "text \"src/a.ts\" w=11111111 [fg=n:magenta]",
      "text \"\\n\" w=1 []",
      "text \"12\" w=11 [fg=n:green]",
      "text \":\" w=1 []",
      "text \"match\" w=11111 [bold,fg=n:red]",
      "text \" rest\\n\" w=111111 []",
    ],
  },
  {
    name: 'progress-cursor',
    input:
      '0%\r\x1b[K25%\r\x1b[2K50%\x1b[1A\x1b[3D\x1b[0Jdone\x1b[B\x1b[2;5H\x1b[4G\x1b[3d',
    expected: [
      "text \"0%\\r\" w=111 []",
      "erase {region:\"toEnd\",type:\"line\"}",
      "text \"25%\\r\" w=1111 []",
      "erase {region:\"all\",type:\"line\"}",
      "text \"50%\" w=111 []",
      "cursor {count:1,direction:\"up\",type:\"move\"}",
      "cursor {count:3,direction:\"back\",type:\"move\"}",
      "erase {region:\"toEnd\",type:\"display\"}",
      "text \"done\" w=1111 []",
      "cursor {count:1,direction:\"down\",type:\"move\"}",
      "cursor {col:5,row:2,type:\"position\"}",
      "cursor {col:4,type:\"column\"}",
      "cursor {row:3,type:\"row\"}",
    ],
  },
  {
    name: 'erase-scroll',
    input: '\x1b[1J\x1b[2J\x1b[3J\x1b[5X\x1b[2S\x1b[3T\x1b[1;24r\x1b[s\x1b[u\x1b[=5J',
    expected: [
      "erase {region:\"toStart\",type:\"display\"}",
      "erase {region:\"all\",type:\"display\"}",
      "erase {region:\"scrollback\",type:\"display\"}",
      "erase {count:5,type:\"chars\"}",
      "scroll {count:2,type:\"up\"}",
      "scroll {count:3,type:\"down\"}",
      "scroll {bottom:24,top:1,type:\"setRegion\"}",
      "cursor {type:\"save\"}",
      "cursor {type:\"restore\"}",
      "erase {region:\"toEnd\",type:\"display\"}",
    ],
  },
  {
    name: 'modes',
    input:
      '\x1b[?25l\x1b[?25h\x1b[?1049h\x1b[?47l\x1b[?2004h\x1b[?1000h\x1b[?1002l\x1b[?1003h\x1b[?1004l\x1b[?1006h\x1b[4h',
    expected: [
      "cursor {type:\"hide\"}",
      "cursor {type:\"show\"}",
      "mode {enabled:true,type:\"alternateScreen\"}",
      "mode {enabled:false,type:\"alternateScreen\"}",
      "mode {enabled:true,type:\"bracketedPaste\"}",
      "mode {mode:\"normal\",type:\"mouseTracking\"}",
      "mode {mode:\"off\",type:\"mouseTracking\"}",
      "mode {mode:\"any\",type:\"mouseTracking\"}",
      "mode {enabled:false,type:\"focusEvents\"}",
      "unknown \"\\u001b[?1006h\"",
      "unknown \"\\u001b[4h\"",
    ],
  },
  {
    name: 'cursor-style',
    input: '\x1b[ q\x1b[2 q\x1b[6 q\x1b[9 q\x1b[3q',
    expected: [
      "cursor {blinking:true,style:\"block\",type:\"style\"}",
      "cursor {blinking:false,style:\"block\",type:\"style\"}",
      "cursor {blinking:false,style:\"bar\",type:\"style\"}",
      "cursor {blinking:true,style:\"block\",type:\"style\"}",
      "unknown \"\\u001b[3q\"",
    ],
  },
  {
    name: 'esc-family',
    input: 'a\x1bcb\x1b7c\x1b8d\x1bDe\x1bMf\x1bEg\x1bHh\x1b(Bi\x1b)0j\x1b#8k\x1b^privacy\x1b\\l',
    expected: [
      "text \"a\" w=1 []",
      "reset",
      "text \"b\" w=1 []",
      "cursor {type:\"save\"}",
      "text \"c\" w=1 []",
      "cursor {type:\"restore\"}",
      "text \"d\" w=1 []",
      "cursor {count:1,direction:\"down\",type:\"move\"}",
      "text \"e\" w=1 []",
      "cursor {count:1,direction:\"up\",type:\"move\"}",
      "text \"f\" w=1 []",
      "cursor {count:1,type:\"nextLine\"}",
      "text \"g\" w=1 []",
      "text \"h\" w=1 []",
      "text \"i\" w=1 []",
      "text \"j\" w=1 []",
      "unknown \"\\u001b#8\"",
      "text \"k\" w=1 []",
      "unknown \"\\u001b^\"",
      "text \"privacy\" w=1111111 []",
      "unknown \"\\u001b\\\\\"",
      "text \"l\" w=1 []",
    ],
  },
  {
    name: 'osc-title-link',
    input:
      '\x1b]0;My Title\x07text\x1b]2;T2\x1b\\\x1b]1;Icon\x07\x1b]8;;https://example.com\x07link text\x1b]8;;\x07after\x1b]8;id=x:foo=bar;https://y.z\x1b\\ID\x1b]8;;\x1b\\',
    expected: [
      "title {title:\"My Title\",type:\"both\"}",
      "text \"text\" w=1111 []",
      "title {title:\"T2\",type:\"windowTitle\"}",
      "title {name:\"Icon\",type:\"iconName\"}",
      "link {params:undefined,type:\"start\",url:\"https://example.com\"}",
      "text \"link text\" w=111111111 []",
      "link {type:\"end\"}",
      "text \"after\" w=11111 []",
      "link {params:{foo:\"bar\",id:\"x\"},type:\"start\",url:\"https://y.z\"}",
      "text \"ID\" w=11 []",
      "link {type:\"end\"}",
    ],
  },
  {
    name: 'osc-unknown-tabstatus',
    input:
      '\x1b]52;c;aGk=\x07\x1b]21337;status=busy:statusColor=#ff0000\x07\x1b]21337;indicator\x07\x1b]133;A\x07',
    expected: [
      "unknown \"\\u001b]52;c;aGk=\"",
      "tabStatus {status:\"busy:statusColor=#ff0000\"}",
      "tabStatus {indicator:null}",
      "unknown \"\\u001b]133;A\"",
    ],
  },
  {
    name: 'bel-text',
    input: 'before\x07after\x07\x07end',
    expected: [
      "text \"before\" w=111111 []",
      "bell",
      "text \"after\" w=11111 []",
      "bell",
      "bell",
      "text \"end\" w=111 []",
    ],
  },
  {
    name: 'graphemes',
    input:
      '中文 ｶﾞ\x1b[31m😀👍🏽👨‍👩‍👧‍👦🇺🇸\x1b[0mcafé é \r\n€ー',
    expected: [
      "text \"中文 ｶﾞ\" w=2212 []",
      "text \"😀👍🏽👨‍👩‍👧‍👦🇺🇸\" w=2222 [fg=n:red]",
      "text \"café é \\r\\n€ー\" w=1111121212 []",
    ],
  },
  {
    name: 'tail-incomplete-csi',
    input: 'ok\x1b[31',
    expected: [
      "text \"ok\" w=11 []",
    ],
  },
  {
    name: 'tail-incomplete-osc',
    input: 'ok\x1b]8;;http://x',
    expected: [
      "text \"ok\" w=11 []",
    ],
  },
  {
    name: 'tail-lone-esc',
    input: 'ok\x1b',
    expected: [
      "text \"ok\" w=11 []",
    ],
  },
  {
    name: 'tail-incomplete-dcs',
    input: 'ok\x1bP1$r0m',
    expected: [
      "text \"ok\" w=11 []",
    ],
  },
  {
    name: 'dcs-apc-ss3',
    input: '\x1bP1$r0m\x1b\\mid\x1b_Gi=1;OK\x1b\\end\x1bOPq',
    expected: [
      "unknown \"\\u001bP1$r0m\\u001b\\\\\"",
      "text \"mid\" w=111 []",
      "unknown \"\\u001b_Gi=1;OK\\u001b\\\\\"",
      "text \"end\" w=111 []",
      "unknown \"\\u001bOP\"",
      "text \"q\" w=1 []",
    ],
  },
  {
    name: 'sgr-mouse-in-output',
    input: '\x1b[<65;10;3Mafter\x1b[M',
    expected: [
      "unknown \"\\u001b[<65;10;3M\"",
      "text \"after\" w=11111 []",
      "unknown \"\\u001b[M\"",
    ],
  },
  {
    name: 'private-prefix-quirks',
    input: '\x1b[?5Aup\x1b[>1;2mmod\x1b[=5Jed',
    expected: [
      "cursor {count:5,direction:\"up\",type:\"move\"}",
      "text \"up\" w=11 []",
      "unknown \"\\u001b[>1;2m\"",
      "text \"mod\" w=111 []",
      "erase {region:\"toEnd\",type:\"display\"}",
      "text \"ed\" w=11 []",
    ],
  },
  {
    name: 'intermediate-sgr-quirk',
    input: '\x1b[1$mstill',
    expected: [
      "text \"still\" w=11111 [bold]",
    ],
  },
  {
    name: 'sgr-quirks',
    input:
      '\x1b[38;5mblink\x1b[0m\x1b[38;2mdim\x1b[0m\x1b[21mdbl\x1b[0m\x1b[38:9;5;123mqq',
    expected: [
      "text \"blink\" w=11111 [blink]",
      "text \"dim\" w=111 [dim]",
      "text \"dbl\" w=111 [ul=double]",
      "text \"qq\" w=11 [blink,fg=i:123]",
    ],
  },
  {
    name: 'empty-and-reset',
    input: '\x1b[mplain\x1b[;31mred-after-reset\x1b[31;mreset-tail',
    expected: [
      "text \"plain\" w=11111 []",
      "text \"red-after-reset\" w=111111111111111 [fg=n:red]",
      "text \"reset-tail\" w=1111111111 []",
    ],
  },
  {
    name: 'count-zero-and-wide',
    input: '\x1b[10A\x1b[0B\x1b[999C\x1b[2F\x1b[3E',
    expected: [
      "cursor {count:10,direction:\"up\",type:\"move\"}",
      "cursor {count:0,direction:\"down\",type:\"move\"}",
      "cursor {count:999,direction:\"forward\",type:\"move\"}",
      "cursor {count:2,type:\"prevLine\"}",
      "cursor {count:3,type:\"nextLine\"}",
    ],
  },
]

if (DUMP) {
  for (const g of GOLDENS) {
    console.log(`  {\n    name: ${JSON.stringify(g.name)},`)
    console.log(`    expected: [`)
    for (const line of serStream(g.input)) {
      console.log(`      ${JSON.stringify(line)},`)
    }
    console.log(`    ],\n  },`)
  }
  process.exit(0)
}

for (const g of GOLDENS) {
  const got = serStream(g.input)
  const want = g.expected
  const equal = got.length === want.length && got.every((l, i) => l === want[i])
  check(
    `golden ${g.name}`,
    equal,
    `\n    got:  ${JSON.stringify(got, null, 2).split('\n').join('\n    ')}\n    want: ${JSON.stringify(want, null, 2).split('\n').join('\n    ')}`,
  )
}

// ============================================================================
//  LAW SPLIT-INVARIANCE — every golden input, split at every boundary
// ============================================================================
{
  for (const g of GOLDENS) {
    const whole = normalize(parseAll(g.input)).join('\n')
    let bad = 0
    for (let i = 1; i < g.input.length; i++) {
      const split = normalize(
        feedChunks([g.input.slice(0, i), g.input.slice(i)]),
      ).join('\n')
      checks++
      if (split !== whole) {
        bad++
        failures++
        if (bad <= 2)
          console.log(
            `  [FAIL] split-invariance ${g.name} @${i}\n    whole: ${whole}\n    split: ${split}`,
          )
      }
    }
    // A 3-chunk sweep at thirds
    const a = Math.floor(g.input.length / 3)
    const b = Math.floor((2 * g.input.length) / 3)
    if (a > 0 && b > a && b < g.input.length) {
      const tri = normalize(
        feedChunks([
          g.input.slice(0, a),
          g.input.slice(a, b),
          g.input.slice(b),
        ]),
      ).join('\n')
      check(`split-invariance ${g.name} (3-chunk)`, tri === whole)
    }
  }
}

// ============================================================================
//  LAW TOTALITY / NO-FABRICATION — byte soup never throws; whole ≡ char-fed;
//  vocabulary closed; text is a subsequence of the input.
// ============================================================================
{
  const KNOWN_TYPES = new Set([
    'text', 'cursor', 'erase', 'scroll', 'mode', 'link', 'title',
    'tabStatus', 'sgr', 'bell', 'reset', 'unknown',
  ])
  const isSubsequence = (needle: string, hay: string): boolean => {
    let j = 0
    for (let i = 0; i < hay.length && j < needle.length; i++) {
      if (hay[i] === needle[j]) j++
    }
    return j === needle.length
  }
  const rnd = lcg(0x50f7f00d)
  const alphabet: string[] = []
  for (let b = 0; b < 256; b++) alphabet.push(String.fromCharCode(b))
  alphabet.push(
    '\x1b', '\x1b', '\x1b', '[', ']', ';', ':', 'm', 'M', 'h', 'l', 'q',
    '\x07', '\\', '?', '>', '=', '<', '8', '5', '2', '0',
    '中', '😀', '👨‍👩‍👧', '\uD800', '\uDC00', 'é', 'é', 'ｶ',
  )
  const N = 1500
  let threw = 0
  let mismatch = 0
  let vocab = 0
  let fabricated = 0
  for (let t = 0; t < N; t++) {
    const len = 1 + Math.floor(rnd() * 60)
    let input = ''
    for (let k = 0; k < len; k++)
      input += alphabet[Math.floor(rnd() * alphabet.length)]!
    let whole: Action[] | null = null
    try {
      whole = parseAll(input)
      for (const a of whole) if (!KNOWN_TYPES.has(a.type)) vocab++
      const text = whole
        .filter(a => a.type === 'text')
        .map(a => (a as Extract<Action, { type: 'text' }>).graphemes.map(g => g.value).join(''))
        .join('')
      if (!isSubsequence(text, input)) {
        fabricated++
        if (fabricated <= 3)
          console.log(`  [totality fabricated] input=${JSON.stringify(input)} text=${JSON.stringify(text)}`)
      }
    } catch (err) {
      threw++
      if (threw <= 3) console.log(`  [totality threw whole] ${JSON.stringify(input)} — ${err}`)
    }
    try {
      const p = new Parser()
      const acc: Action[] = []
      for (const ch of input.split('')) acc.push(...p.feed(ch))
      if (whole) {
        const a = normalize(whole).join('\n')
        const b = normalize(acc).join('\n')
        if (a !== b) {
          mismatch++
          if (mismatch <= 3)
            console.log(
              `  [totality whole≠char-fed] input=${JSON.stringify(input)}\n    whole: ${a}\n    char:  ${b}`,
            )
        }
      }
    } catch (err) {
      threw++
      if (threw <= 3) console.log(`  [totality threw char-fed] ${JSON.stringify(input)} — ${err}`)
    }
  }
  check(`totality: ${N} byte soups never throw`, threw === 0, `${threw} threw`)
  check(`totality: whole ≡ char-fed normalized on all ${N}`, mismatch === 0, `${mismatch} mismatched`)
  check('totality: vocabulary closed', vocab === 0, `${vocab} unknown action types`)
  check('totality: no fabricated text', fabricated === 0, `${fabricated} fabricated`)
  checks += 4 * (N - 1)
}

// ============================================================================
//  LAW WIDTH — the pinned grapheme classification (Q-WIDTH)
// ============================================================================
{
  const widthOf = (g: string): number => {
    const actions = parseAll(g)
    const t = actions.find(a => a.type === 'text') as
      | Extract<Action, { type: 'text' }>
      | undefined
    if (!t || t.graphemes.length !== 1) return -1
    return t.graphemes[0]!.width
  }
  const table: Array<[string, number, string]> = [
    ['a', 1, 'ascii'],
    ['~', 1, 'ascii'],
    ['é', 1, 'NFC single-codepoint latin (not in any wide table)'],
    ['é', 2, 'Q-WIDTH: NFD multi-codepoint ⇒ 2'],
    ['\r\n', 2, 'Q-WIDTH: CRLF is one 2-codepoint grapheme ⇒ 2'],
    ['中', 2, 'CJK unified (2E80-9FFF)'],
    ['한', 2, 'Hangul syllable (AC00-D7A3)'],
    ['ᄀ', 2, 'Hangul jamo (1100-115F)'],
    ['ー', 2, 'katakana prolonged (2E80-9FFF)'],
    ['ｶ', 1, 'Q-WIDTH: lone halfwidth katakana FF76 is ABOVE FF00-FF60 ⇒ 1'],
    ['ﾞ', 1, 'halfwidth voiced mark FF9E is OUTSIDE the tables ⇒ 1'],
    ['Ａ', 2, 'fullwidth latin (FF00-FF60)'],
    ['￠', 2, 'fullwidth sign (FFE0-FFE6)'],
    ['☀', 2, 'emoji misc (2600-26FF)'],
    ['✂', 2, 'emoji dingbat (2700-27BF)'],
    ['😀', 2, 'emoji (1F300-1F9FF)'],
    ['🧿', 2, 'emoji (1F300-1F9FF)'],
    ['🪀', 2, 'emoji extended (1FA00-1FAFF)'],
    ['🇺🇸', 2, 'flag = 2 codepoints ⇒ 2'],
    ['👍🏽', 2, 'skin tone = multi-codepoint ⇒ 2'],
    ['👨‍👩‍👧‍👦', 2, 'ZWJ family = multi-codepoint ⇒ 2'],
    ['\u05d0\u05b0', 1, 'WAVE C1 carve-out: aleph + sheva takes the base width'],
    ['\u05e9\u05c1\u05b8', 1, 'WAVE C1 carve-out: shin + shin-dot + qamats'],
    ['\u0628\u064e', 1, 'WAVE C1 carve-out: beh + fatha'],
    ['\u0644\u0670', 1, 'WAVE C1 carve-out: lam + superscript alef'],
    ['\u05d0\u0301', 2, 'aleph + NON-Hebrew combining mark keeps Q-WIDTH 2'],
    ['́', 1, 'lone combining mark ⇒ 1'],
    ['€', 1, '20AC outside the tables ⇒ 1'],
    ['𠀀', 2, 'CJK ext B (20000-2FFFD)'],
    ['\uD800', 1, 'lone surrogate degrades to 1'],
  ]
  for (const [g, want, why] of table) {
    check(`width ${JSON.stringify(g)} = ${want} (${why})`, widthOf(g) === want, `got ${widthOf(g)}`)
  }
}

// ============================================================================
//  LAW STATE — carry, reset, link pairing
// ============================================================================
{
  // Style carries across feeds
  const p1 = new Parser()
  p1.feed('\x1b[1;31m')
  const acts = p1.feed('x')
  const t = acts[0] as Extract<Action, { type: 'text' }>
  check(
    'state: style carries across feeds',
    acts.length === 1 && t.type === 'text' && serStyle(t.style) === 'bold,fg=n:red',
    acts.map(serAction).join(' | '),
  )

  // reset() restores boot state (style + link + scanner carry)
  const p2 = new Parser()
  p2.feed('\x1b[1;31m\x1b]8;;http://x\x07partial\x1b[3')
  p2.reset()
  check('state: reset restores default style', serStyle(p2.style) === '')
  check('state: reset clears link', p2.inLink === false && p2.linkUrl === undefined)
  const after = p2.feed('1mred')
  check(
    'state: reset drops the carried partial sequence',
    after.length === 1 && after[0]!.type === 'text' &&
      serStyle((after[0] as Extract<Action, { type: 'text' }>).style) === '',
    after.map(serAction).join(' | '),
  )

  // Link pairing across feeds
  const p3 = new Parser()
  p3.feed('\x1b]8;;https://a.b\x07')
  check('state: link start sets inLink', p3.inLink === true && p3.linkUrl === 'https://a.b')
  p3.feed('mid')
  check('state: link persists across text feeds', p3.inLink === true)
  p3.feed('\x1b]8;;\x1b\\')
  check('state: link end clears inLink', p3.inLink === false && p3.linkUrl === undefined)
}

// ============================================================================
if (failures > 0) {
  console.log(`\nnative-core ansi-parser contract: RED (${failures}/${checks} checks failed)`)
  process.exit(1)
}
console.log(`\nnative-core ansi-parser contract: green (${checks} checks)`)
