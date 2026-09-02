// ============================================================================
//  scripts/ink-runtime/styleMapLaws.ts — the FN-016 R11 laws, runtime-
//  agnostic: prove-style-map-transforms.ts runs them in-process under bun
//  AND bundle-and-runs them under node, the product's runtime. The two
//  runtimes wrap with DIFFERENT engines (src/ink/wrapAnsi.ts prefers
//  Bun.wrapAnsi; node takes the bundled wrap-ansi, which normalizes its
//  input to NFC, folds CRLF and expands tabs), so a wrap-face law green
//  under bun alone says nothing about the shipped frame — the normalize
//  faces (§4, §4b) bite under node.
//
//  Colours are asserted against REFERENCE renders of single-dress lines,
//  never a palette guess: the two counts wear RAW truecolor values (a raw
//  colour bypasses the theme-role lookup ThemedText applies to every other
//  spelling — `color: 'green'` is an unknown ROLE and paints nothing), and
//  the path wears dimColor, which ThemedText resolves to the theme's own
//  inactive colour — whatever spec that is here, the reference render says.
//
//  Env pins are the CALLER's, set before this module evaluates: FORCE_COLOR
//  (the colour lane is read at import) and MERCURY_CONFIG_DIR (a scratch
//  home). Static imports on purpose — the node arm bundles this module.
// ============================================================================
import React from 'react'
import { enableConfigs } from '../../src/utils/config/globalConfig.js'
import { Box, Text } from '../../src/ink.js'
import { renderToAnsiString } from '../../src/utils/staticRender.js'

/** Visible chars with their active SGR foreground spec. Truecolor-aware:
 *  38;2;r;g;b and 38;5;n are captured whole. */
type Painted = { ch: string; fg: string | null }
export function paintedChars(ansi: string): Painted[] {
  const out: Painted[] = []
  let fg: string | null = null
  for (let i = 0; i < ansi.length; i++) {
    const c = ansi[i]!
    if (c === '\x1b') {
      const m = /^\x1b\[([0-9;]*)m/.exec(ansi.slice(i))
      if (m) {
        const codes = m[1]!.split(';').map(Number)
        for (let k = 0; k < codes.length; k++) {
          const code = codes[k]!
          if (code === 0) fg = null
          else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) fg = String(code)
          else if (code === 39) fg = null
          else if (code === 38) {
            if (codes[k + 1] === 2) {
              fg = codes.slice(k, k + 5).join(';')
              k += 4
            } else if (codes[k + 1] === 5) {
              fg = codes.slice(k, k + 3).join(';')
              k += 2
            }
          } else if (code === 48) {
            if (codes[k + 1] === 2) k += 4
            else if (codes[k + 1] === 5) k += 2
          }
        }
        i += m[0].length - 1
        continue
      }
      const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(ansi.slice(i))
      if (osc) {
        i += osc[0].length - 1
        continue
      }
      const csi = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(ansi.slice(i))
      if (csi) {
        i += csi[0].length - 1
        continue
      }
      continue
    }
    if (c !== '\n' && c !== '\r') out.push({ ch: c, fg })
  }
  return out
}

const visible = (cells: Painted[]): string => cells.map(p => p.ch).join('')
const runOf = (cells: Painted[], text: string): Painted[] | null => {
  const at = visible(cells).indexOf(text)
  return at === -1 ? null : cells.slice(at, at + text.length)
}
const wears = (cells: Painted[] | null, fg: string | null): boolean =>
  cells !== null && cells.length > 0 && cells.every(p => p.fg === fg)

/** The R11 laws. Returns the failure count; prints one verdict line per law
 *  tagged with the runtime so the two arms read apart in one log. */
export async function runStyleMapLaws(runtime: string): Promise<number> {
  enableConfigs()
  let failures = 0
  const j = (v: unknown): string => JSON.stringify(v)
  const check = (label: string, ok: boolean, detail = ''): void => {
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] (${runtime}) ${label}${!ok && detail ? ` — ${detail}` : ''}`)
    if (!ok) failures++
  }
  const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n(${runtime}) ${t}`)
  const e = React.createElement
  const render = (node: React.ReactNode, width: number): Promise<string> => renderToAnsiString(node, width)

  // ── reference renders: what each dress's fg spec actually is here ────────
  const refFg = async (props: Record<string, unknown>): Promise<string | null> => {
    const ansi = await render(e(Box, { width: 10 }, e(Text, props as never, 'X')), 10)
    return paintedChars(ansi).find(p => p.ch === 'X')?.fg ?? null
  }
  const GREEN = await refFg({ color: '#00ff00' })
  const RED = await refFg({ color: '#ff0000' })
  const DIM = await refFg({ dimColor: true })
  section('§0 the reference dresses')
  check(
    'green, red and the dim path are three distinct foreground specs (raw truecolor values · the theme\'s inactive)',
    GREEN !== null && RED !== null && DIM !== null && GREEN !== RED && GREEN !== DIM && RED !== DIM,
    j({ GREEN, RED, DIM }),
  )

  section('§1 truncate-middle: the header shape keeps its colours past the ellipsis')
  {
    // The tool-use header's shape: a coloured count, a dim path, a coloured
    // count — cut in the middle. The linear map painted everything right of
    // the ellipsis in the LEAD's colours (output position ≠ source position
    // past the cut), so "-3" wore the path's dim.
    const ansi = await render(
      e(
        Box,
        { width: 26 },
        e(
          Text,
          { wrap: 'truncate-middle' },
          e(Text, { color: '#00ff00' }, '+12 '),
          e(Text, { dimColor: true }, '/very/long/path/to/some/file.ts'),
          e(Text, { color: '#ff0000' }, ' -3'),
        ),
      ),
      26,
    )
    const cells = paintedChars(ansi)
    check('fixture: one row, cut in the middle (ellipsis present)', cells.some(p => p.ch === '…'), j(visible(cells)))
    check('fixture: both counts survive the cut', runOf(cells, '+12') !== null && runOf(cells, '-3') !== null, j(visible(cells)))
    check('the lead count is green (control: inside the lead the map was right)', wears(runOf(cells, '+12'), GREEN), j(runOf(cells, '+12')))
    check("THE DEFECT PIN: the trail count is RED — its own segment's dress, not the path's dim", wears(runOf(cells, '-3'), RED), j(runOf(cells, '-3')))
    const slashes = cells.filter(p => p.ch === '/')
    check('the path wears the dim dress on BOTH sides of the ellipsis', slashes.length >= 2 && wears(slashes, DIM), j(slashes))
  }

  section('§2 truncate-start: the visible tail wears its OWN styles')
  {
    // Nothing of the lead survives: the whole visible line is the trail.
    // The linear map read source positions 0..11 for output 0..11 — all
    // inside the DISCARDED green head — so "TAIL" wore green.
    const ansi = await render(
      e(
        Box,
        { width: 12 },
        e(Text, { wrap: 'truncate-start' }, e(Text, { color: '#00ff00' }, 'discarded-head-'), e(Text, { color: '#ff0000' }, 'TAIL')),
      ),
      12,
    )
    const cells = paintedChars(ansi)
    check('fixture: the line is "…d-head-TAIL"', visible(cells).trimEnd() === '…d-head-TAIL', j(visible(cells)))
    check('THE DEFECT PIN: the kept tail is RED (its own segment)', wears(runOf(cells, 'TAIL'), RED), j(runOf(cells, 'TAIL')))
    check('the kept part of the green segment stays green (control)', wears(runOf(cells, 'd-head-'), GREEN), j(runOf(cells, 'd-head-')))
    check('the ellipsis wears the dress of the first character it stands for (the cut head: green)', wears(runOf(cells, '…'), GREEN), j(runOf(cells, '…')))
  }

  section('§3 the wrap face: a word ending exactly at the wrap column no longer drifts the continuation styles')
  {
    // "aaa bbb " green + "ccc" red at width 7: the break lands ON the
    // space the wrapper drops. Un-compensated, the continuation's first
    // character read the SPACE's segment — one green "c" per such break,
    // accumulating line by line.
    const ansi = await render(
      e(Box, { width: 7 }, e(Text, { wrap: 'wrap' }, e(Text, { color: '#00ff00' }, 'aaa bbb '), e(Text, { color: '#ff0000' }, 'ccc'))),
      7,
    )
    const cells = paintedChars(ansi)
    check('THE DEFECT PIN: every character of the continuation word is red (no one-off drift)', wears(runOf(cells, 'ccc'), RED), j(runOf(cells, 'ccc')))
    check('the first segment keeps its own dress (control)', wears(runOf(cells, 'aaa'), GREEN) && wears(runOf(cells, 'bbb'), GREEN), j(runOf(cells, 'aaa bbb')))
  }

  section('§3b the compensation is keyed on the soft-break record: a blank line and the indent after it keep their styles')
  {
    // A soft-broken first line, a blank line, then an INDENTED line whose
    // styles change mid-line — the shape of every code block. A skip keyed
    // on whitespace alone ate the blank line's newline AND the indent
    // (nothing stopped it at an empty next line), drifting every style
    // after them: the red "y" came out green.
    const ansi = await render(
      e(
        Box,
        { width: 6 },
        e(
          Text,
          { wrap: 'wrap' },
          e(Text, { color: '#00ff00' }, 'aaaa bbbb\n\n  '),
          e(Text, { color: '#ff0000' }, 'y'),
          e(Text, { color: '#00ff00' }, ' z'),
        ),
      ),
      6,
    )
    const cells = paintedChars(ansi)
    check('fixture: the soft break lands and the indented line survives', visible(cells).includes('bbbb') && visible(cells).includes('  y z'), j(visible(cells)))
    check('THE DEFECT PIN: the indented line\'s red character is red', wears(runOf(cells, 'y'), RED), j(runOf(cells, 'y')))
    check('the character after it is green again (the boundary did not drift)', wears(runOf(cells, 'z'), GREEN), j(runOf(cells, 'z')))
    check('the soft-broken continuation keeps its own dress (control)', wears(runOf(cells, 'bbbb'), GREEN), j(runOf(cells, 'bbbb')))
  }

  section('§4 the normalize face: decomposed source keeps its style boundaries')
  {
    // e + COMBINING ACUTE (decomposed). The bundled wrapper (node — the
    // product) emits NFC, one code unit shorter than the source: the map
    // indexed the decomposed original and drifted one unit past the
    // cluster for the rest of the text. Under bun the native wrapper does
    // not normalize, so this face never drifted there — the node arm is
    // the one that bites.
    const deco = 'café au'
    const ansi = await render(
      e(Box, { width: 5 }, e(Text, { wrap: 'wrap' }, e(Text, { color: '#00ff00' }, deco + ' '), e(Text, { color: '#ff0000' }, 'lait'))),
      5,
    )
    const cells = paintedChars(ansi)
    check('the painted text is the NFC form (one composed é)', visible(cells).includes('café') && !visible(cells).includes('́'), j(visible(cells)))
    check('THE DEFECT PIN: the second segment is wholly red past the decomposed cluster', wears(runOf(cells, 'lait'), RED), j(runOf(cells, 'lait')))
    check('the first segment never bleeds red (control)', wears(runOf(cells, 'au'), GREEN) && wears(runOf(cells, 'caf'), GREEN), j(runOf(cells, 'café au')))
  }

  section('§4b the normalize face, second term: the wrapper folds CRLF, and the map indexes the folded form')
  {
    // The bundled wrapper folds "\r\n" to "\n" before it wraps — one code
    // unit fewer per fold. Un-mirrored, the map indexed the unfolded
    // source and every style after the fold sat one unit early: "xy" wore
    // the green of the segment before it.
    const ansi = await render(
      e(Box, { width: 5 }, e(Text, { wrap: 'wrap' }, e(Text, { color: '#00ff00' }, 'abcdefgh\r\n'), e(Text, { color: '#ff0000' }, 'xy'))),
      5,
    )
    const cells = paintedChars(ansi)
    check('fixture: the long line soft-breaks and the second line follows', visible(cells).includes('abcde') && visible(cells).includes('fgh') && visible(cells).includes('xy'), j(visible(cells)))
    check('THE DEFECT PIN: the second segment is wholly red past the fold', wears(runOf(cells, 'xy'), RED), j(runOf(cells, 'xy')))
    check('the first segment keeps its own dress (control)', wears(runOf(cells, 'abcde'), GREEN) && wears(runOf(cells, 'fgh'), GREEN), j(runOf(cells, 'abcdefgh')))
  }

  section('§6 the inert wrap members never cut: `end` and `middle` paint untouched, as layout measured them')
  {
    // wrapText leaves these union members untouched (several call sites
    // rely on it, and layout measures them untouched); a truncate branch
    // keyed on "not a wrap mode" would have ellipsized them — one text,
    // two disagreeing widths again.
    for (const wrap of ['end', 'middle'] as const) {
      const ansi = await render(
        e(Box, { width: 8 }, e(Text, { wrap }, e(Text, { color: '#00ff00' }, 'abcdef'), e(Text, { color: '#ff0000' }, 'ghijklmnop'))),
        8,
      )
      const cells = paintedChars(ansi)
      check(`wrap="${wrap}": no ellipsis — the overflow is clipped, never cut`, !visible(cells).includes('…'), j(visible(cells)))
      check(`wrap="${wrap}": the visible head keeps both dresses in place`, wears(runOf(cells, 'abcdef'), GREEN) && wears(runOf(cells, 'gh'), RED), j(cells.slice(0, 8)))
    }
  }

  return failures
}
