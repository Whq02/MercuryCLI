#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'
import { parseSplashRuns, type SplashRun } from '../../src/screen/widgets/splashRuns.ts'
import { createSplashCore, assembleCardRows } from '../../assets/splash/splash-core.mjs'

const t = checker()



t.section('§2 — the core is pure (injection-only capability + data)')
{
  const mod = createSplashCore({ nocolor: false, truecolor: true })
  t.check('createSplashCore yields the compose surface', typeof mod.composeLockup === 'function' && typeof mod.placeBlock === 'function', 'factory shape')
  const plain = createSplashCore({ nocolor: true, truecolor: true })
  t.check(
    'the nocolor binding emits ZERO styling bytes (layout-identical plain path)',
    plain.R === '' && plain.hexFg('#DD4444', 167) === '' && plain.BOLD === '',
    'plain law',
  )
}

t.section('§3 — flatten parity at the capture matrix (incl. the operator profile)')
{
  const core = createSplashCore({ nocolor: false, truecolor: true })
  const IN_PROCESS_OPTS = {
    cardRows: assembleCardRows({
      cwdBase: 'orchard-src',
      continueTarget: { base: 'orchard-src', ageMs: 5 * 60000, cross: false },
      menuAvailable: true,
      concourse: { ctx: 'the live board · 2 live' },
    }),
    cardSel: 0,
    hintSegments: [
      { key: '↵', label: '', tone: 'ivory' as const },
      { key: 'm', label: ' menu', tone: 'faint' as const },
    ],
    tinyHint: '↵',
    stripLines: (w: number) =>
      core.composeStrip(
        {
          model: 'Opus 5',
          dir: 'orchard-src',
        },
        w,
      ),
  }
  const SGR = /\x1b\[[0-9;]*m/g
  const emit = (runs: SplashRun[]): string =>
    runs
      .map(r => {
        let s = '\x1b[0m'
        if (r.bold) s += '\x1b[1m'
        if (r.dim) s += '\x1b[2m'
        if (r.underline) s += '\x1b[4m'
        if (r.fg) s += `\x1b[38;2;${parseInt(r.fg.slice(1, 3), 16)};${parseInt(r.fg.slice(3, 5), 16)};${parseInt(r.fg.slice(5, 7), 16)}m`
        if (r.bg) s += `\x1b[48;2;${parseInt(r.bg.slice(1, 3), 16)};${parseInt(r.bg.slice(3, 5), 16)};${parseInt(r.bg.slice(5, 7), 16)}m`
        return s + r.text
      })
      .join('')
  for (const [cols, rows] of [[80, 24], [100, 34], [142, 38], [205, 53]] as const) {
    const res = core.composeLockup(cols, rows, IN_PROCESS_OPTS)
    let vocabOk = true
    let textOk = true
    let roundtripOk = true
    for (const line of res.lines) {
      let runs: SplashRun[]
      try {
        runs = parseSplashRuns(line)
      } catch {
        vocabOk = false
        continue
      }
      if (runs.map(r => r.text).join('') !== line.replace(SGR, '')) textOk = false
      const reparsed = parseSplashRuns(emit(runs))
      if (JSON.stringify(reparsed) !== JSON.stringify(runs)) roundtripOk = false
    }
    t.check(`${cols}x${rows}: the adapter accepts the core's complete SGR vocabulary`, vocabOk, 'closed vocabulary')
    t.check(`${cols}x${rows}: run text is byte-preserved (no dropped cells)`, textOk, 'lossless text')
    t.check(`${cols}x${rows}: emit→reparse is a fixed point (cell output ≡ SGR flatten)`, roundtripOk, 'round-trip stable')
    t.check(
      `${cols}x${rows}: the composition carries the five action rows (new · continue · logins · concourse · menu)`,
      res.cardShown && res.actionLines.length === 5,
      `cardShown=${String(res.cardShown)} actions=${res.actionLines.length}`,
    )
  }
}

t.section('§4 — CB-11: background ink is art cells + the approved plate only (no field paint)')
{
  const core = createSplashCore({ nocolor: false, truecolor: true })
  const res = core.composeLockup(142, 38, {
    cardRows: assembleCardRows({
      cwdBase: 'proj',
      continueTarget: null,
      menuAvailable: true,
      concourse: { ctx: 'the live board' },
    }),
    cardSel: 0,
    hintSegments: [{ key: '↵', label: '', tone: 'ivory' as const }],
    tinyHint: '↵',
    stripLines: (w: number) =>
      core.composeStrip(
        { model: 'Opus 5', dir: 'proj' },
        w,
      ),
  })
  const offenders: number[] = []
  const PLATE = '\x1b[48;2;13;24;27m'
  res.lines.forEach((line, i) => {
    if (!line.includes('\x1b[48;2;')) return
    if (/[▀▄█]/.test(line)) return
    const nonPlate = line.split('\x1b[48;2;').slice(1).some(seg => !('\x1b[48;2;' + seg).startsWith(PLATE))
    if (nonPlate || !/[╭╮╰╯─│├┤]/.test(line)) offenders.push(i)
  })
  t.check(
    'every bg-carrying line is half-block art or PLATE_TONE boxed chrome (no field paint)',
    offenders.length === 0,
    offenders.length === 0 ? 'ground-free' : `non-art/non-plate bg at lines ${offenders.join(',')}`,
  )
}

t.finish('prove-splash-core-parity')
