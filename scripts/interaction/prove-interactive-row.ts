#!/usr/bin/env bun
// ============================================================================
//  scripts/interaction/prove-interactive-row.ts — the shared interaction grammar,
//  proven in a REAL PTY. Self-spawning fixture
//  (the render-command-palette idiom): the child branch mounts either
//    · mode=panes — a NavigablePanes board with two sections + sideInfo +
//      a 'z' reorder key (rotates the rows under the cursor), or
//    · mode=rows  — two raw InteractiveRows (one live, one unavailable) with
//      a status line counting activations,
//  and the parent drives keys + SGR mouse bytes through vshot and asserts
//  from the cell grid:
//    A. ↓ selects row 2; a data REORDER keeps the selection on the same ROW
//       KEY (the cursor follows 'beta', never the index).
//    B. click an UNSELECTED row selects it (sideInfo follows, no drill);
//       a second click on the selected row DRILLS (same meaning as ↵).
//    C. clicking a section nav entry switches sections (one-click control).
//    D. hover paints exactly the hovered row's background (tokens.surface2);
//       an unavailable row takes no hover paint and no click.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveProofHome } from '../lib/proofHome.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const SELF = fileURLToPath(import.meta.url)
const VSHOT = join(dirname(SELF), '../ui/vshot.py')
// The proof's config home (scripts/lib/proofHome.ts): the inherited pin, else
// a fresh seeded scratch — never another program's directory.
const CONFIG_HOME = resolveProofHome([process.cwd()])

if (process.env.IROW_CHILD) {
  // ── child: mount the fixture ───────────────────────────────────────────────
  process.env.NODE_ENV = 'test'
  ;(globalThis as Record<string, unknown>).MACRO = {
    VERSION: '1.0.0',
    ISSUES_EXPLAINER: '',
    PACKAGE_URL: '',
    README_URL: '',
    IS_DEV: false,
    IS_DEMO: false,
  }
  const React = await import('react')
  const ink = (await import('../../src/ink.js')) as unknown as {
    render: (n: React.ReactNode) => Promise<unknown>
    Box: React.ComponentType<Record<string, unknown>>
    Text: React.ComponentType<Record<string, unknown>>
    useInput: (h: (input: string, key: Record<string, boolean>) => void) => void
  }
  const h = React.createElement
  const { AppStateProvider } = await import('../../src/state/AppState.js')
  const { ThemeProvider } = await import(
    '../../src/components/design-system/ThemeProvider.js'
  )
  // Optional theme-family pin (IROW_THEME): an INNER ThemeProvider overrides
  // the render()-level default, so the family leg can prove the fixture
  // adapts (hover paint = that family's surface2, not the dark literal).
  const wrapTheme = (node: React.ReactNode): React.ReactNode =>
    process.env.IROW_THEME
      ? h(
          ThemeProvider as never,
          { initialState: process.env.IROW_THEME, onThemeSave: () => {} },
          node,
        )
      : node

  if (process.env.IROW_MODE === 'rows') {
    const { AlternateScreen } = await import('../../src/ink/components/AlternateScreen.js')
    const { InteractiveRow } = await import('../../src/components/mercury-ui/InteractiveRow.js')
    function RowsFixture(): React.ReactNode {
      const [sel, setSel] = React.useState<string>('none')
      const [acts, setActs] = React.useState(0)
      // A useInput consumer keeps ink reading stdin (raw mode), so the SGR
      // mouse bytes the proof injects actually reach the decode path.
      ink.useInput(() => {})
      return h(
        ink.Box,
        { flexDirection: 'column' },
        h(ink.Text, {}, `sel=${sel} acts=${acts}`),
        h(
          InteractiveRow as React.ComponentType<Record<string, unknown>>,
          {
            id: 'fx:alpha',
            selected: sel === 'alpha',
            onSelect: () => setSel('alpha'),
            onActivate: () => setActs(n => n + 1),
            height: 1,
            width: 30,
          },
          h(ink.Text, {}, 'ROW-alpha live'),
        ),
        h(
          InteractiveRow as React.ComponentType<Record<string, unknown>>,
          {
            id: 'fx:omega',
            unavailable: true,
            onSelect: () => setSel('omega'),
            onActivate: () => setActs(n => n + 100),
            height: 1,
            width: 30,
          },
          h(ink.Text, {}, 'ROW-omega dead'),
        ),
      )
    }
    void ink.render(
      wrapTheme(
        h(
          AppStateProvider as never,
          {},
          h(AlternateScreen as never, { mouseTracking: true }, h(RowsFixture)),
        ),
      ),
    )
  } else {
    const { NavigablePanes } = await import(
      '../../src/components/mercury-ui/NavigablePanes.js'
    )
    type R = { id: string; name: string }
    function PanesFixture(): React.ReactNode {
      const [order, setOrder] = React.useState<R[]>([
        { id: 'alpha', name: 'row-alpha' },
        { id: 'beta', name: 'row-beta' },
        { id: 'gamma', name: 'row-gamma' },
        { id: 'delta', name: 'row-delta' },
      ])
      ink.useInput(input => {
        if (input === 'z') {
          // Rotate: the row under a resting cursor changes INDEX but keeps
          // its key — the selection must follow the key.
          setOrder(o => [o[3]!, o[0]!, o[1]!, o[2]!])
        }
      })
      return h(NavigablePanes as React.ComponentType<Record<string, unknown>>, {
        view: 'fixture',
        sections: [
          { id: 'main', label: 'main', rows: order },
          { id: 'other', label: 'other', rows: [{ id: 'omega', name: 'row-omega' }] },
        ],
        columns: [
          { key: 'name', header: 'name', cell: (r: R) => h(ink.Text, {}, r.name) },
        ],
        rowKey: (r: R) => r.id,
        renderDetail: (r: R) => h(ink.Text, {}, `detail-of-${r.id}`),
        detailTitle: (r: R) => `dt-${r.id}`,
        sideInfo: (r: R) => h(ink.Text, {}, `side-${r.id}`),
        onClose: () => process.exit(0),
      })
    }
    void ink.render(wrapTheme(h(AppStateProvider as never, {}, h(PanesFixture))))
  }
  setTimeout(() => process.exit(0), 30_000)
} else {
  // ── parent: drive the fixture through vshot ────────────────────────────────
  const { ASH_RAISED } = await import('../../src/components/mercuryPalette.ts')
  const HOVER_BG = ASH_RAISED.slice(1).toLowerCase()

  let failures = 0
  const check = (label: string, cond: boolean, detail = ''): void => {
    if (!cond) failures++
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
  }
  if (!existsSync(VSHOT)) {
    console.error('vshot.py missing — render-verify required')
    process.exit(1)
  }

  type Cell = { c: string; bg?: string }
  // The timelines are written in absolute ticks from spawn; the capture
  // anchors them on the fixture instead: the first send fires its authored
  // lead AFTER the fixture's rows paint (a harness that never paints is a
  // loud UNDELIVERED-SENDS refusal, never a blind keystroke), later sends
  // keep their authored spacing, and the frame is taken the authored gap
  // after the capture's own asserted needle paints. A slow boot under pool
  // load moves the whole capture later instead of typing into a blank.
  const READY_NEEDLE: Record<'panes' | 'rows', string> = { panes: 'row-gamma', rows: 'ROW-alpha' }
  // The fixture rows' measured first tick after spawn (the receipt records it).
  const READY_TICK = 3
  const SLACK = 30
  type Timeline = Array<{ atTick: number; data: string }>
  function anchored(mode: 'panes' | 'rows', sends: Timeline, total: number, ready: string): Record<string, unknown> {
    let prev = 0
    const out = sends.map((s, i) => {
      const send = i === 0
        ? { awaitText: READY_NEEDLE[mode], requireAwait: true, minTick: 1, awaitSettleTicks: Math.max(0, s.atTick - READY_TICK), data: s.data }
        : { afterPrevTicks: Math.max(1, s.atTick - prev), data: s.data }
      prev = s.atTick
      return send
    })
    const last = sends.length ? sends[sends.length - 1]!.atTick : READY_TICK
    return { sends: out, readyText: ready, readySettleTicks: Math.max(1, total - last), total: total + SLACK }
  }
  function capture(
    tag: string,
    mode: 'panes' | 'rows',
    sends: Timeline,
    total: number,
    cols = 150,
    rows = 40,
    extraEnv: Record<string, string> = {},
    ready: string = READY_NEEDLE[mode],
  ): { lines: string[]; grid: Cell[][] } | null {
    const cfgPath = `/tmp/irow-${tag}-cfg-${process.pid}.json`
    const outPath = `/tmp/irow-${tag}-${process.pid}.json`
    writeFileSync(
      cfgPath,
      JSON.stringify({
        argv: [process.execPath, 'run', SELF],
        ...anchored(mode, sends, total, ready),
        cols,
        rows,
        out: outPath,
      }),
    )
    const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
      encoding: 'utf8',
      timeout: vshotBudgetMs(120_000),
      env: {
        ...process.env,
        IROW_CHILD: '1',
        IROW_MODE: mode,
        MERCURY_LIVE_GLYPHS: '0',
        MERCURY_CONFIG_DIR: CONFIG_HOME,
        ...extraEnv,
      },
    })
    if (res.status !== 0) {
      check(`${tag}: PTY capture ran`, false, res.stderr?.slice(0, 300) ?? '')
      return null
    }
    const grid = (JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Cell[][] }).grid
    return { lines: grid.map(r => r.map(c => c.c).join('')), grid }
  }

  const click = (x: number, y: number): string => `\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`
  const motion = (x: number, y: number): string => `\x1b[<35;${x};${y}M`
  const cursorOn = (lines: string[], needle: string): boolean =>
    lines.some(l => l.includes(needle) && l.includes('▸'))

  console.log('============================================================')
  console.log(' interactive-row grammar — PTY (keys + SGR pointer)')
  console.log('============================================================')

  console.log('\n── A. row-key-stable selection across a live reorder ───────')
  {
    const a1 = capture('a1', 'panes', [{ atTick: 20, data: '\x1b[B' }], 32, 150, 40, {}, 'side-beta')
    if (a1) {
      check('↓ selects row-beta', cursorOn(a1.lines, 'row-beta'))
      check('sideInfo follows the selection (side-beta)', a1.lines.some(l => l.includes('side-beta')))
    }
    const a2 = capture(
      'a2',
      'panes',
      [
        { atTick: 20, data: '\x1b[B' },
        { atTick: 26, data: 'z' },
      ],
      36,
      150,
      40,
      {},
      'side-beta',
    )
    if (a2) {
      check(
        'after the reorder the cursor still sits on row-beta (key, not index)',
        cursorOn(a2.lines, 'row-beta'),
      )
      check('sideInfo still shows side-beta', a2.lines.some(l => l.includes('side-beta')))
    }
  }

  console.log('\n── B/C. pointer: select → second-click drills · section click ─')
  {
    const base = capture('b0', 'panes', [], 26)
    let gRow = -1
    let gCol = -1
    let secRow = -1
    let secCol = -1
    if (base) {
      gRow = base.lines.findIndex(l => l.includes('row-gamma'))
      gCol = gRow >= 0 ? base.lines[gRow]!.indexOf('row-gamma') + 3 : -1
      secRow = base.lines.findIndex(l => l.includes('other (1)'))
      secCol = secRow >= 0 ? base.lines[secRow]!.indexOf('other (1)') + 2 : -1
      check('baseline anchors present', gRow >= 0 && secRow >= 0, `g=${gRow} sec=${secRow}`)
    }
    if (gRow >= 0) {
      const b1 = capture('b1', 'panes', [{ atTick: 20, data: click(gCol + 1, gRow + 1) }], 32, 150, 40, {}, 'side-gamma')
      if (b1) {
        check('click selects row-gamma', cursorOn(b1.lines, 'row-gamma'))
        check('single click does NOT drill (no dt-gamma)', !b1.lines.some(l => l.includes('dt-gamma')))
        check('sideInfo follows the click (side-gamma)', b1.lines.some(l => l.includes('side-gamma')))
      }
      const b2 = capture(
        'b2',
        'panes',
        [
          { atTick: 20, data: click(gCol + 1, gRow + 1) },
          { atTick: 27, data: click(gCol + 1, gRow + 1) },
        ],
        36,
        150,
        40,
        {},
        'dt-gamma',
      )
      if (b2) {
        check('second click on the selected row DRILLS (dt-gamma)', b2.lines.some(l => l.includes('dt-gamma')))
      }
    }
    if (secRow >= 0) {
      const c1 = capture('c1', 'panes', [{ atTick: 20, data: click(secCol + 1, secRow + 1) }], 32, 150, 40, {}, 'row-omega')
      if (c1) {
        check('clicking the section entry switches sections (row-omega visible)', c1.lines.some(l => l.includes('row-omega')))
      }
    }
  }

  console.log('\n── D. hover paint + unavailable inertness (raw rows) ────────')
  {
    // The rows fixture mounts the alternate-screen host, which paints the
    // one resize line under the 80 × 22 viewport floor — the raw-row legs
    // live AT the floor.
    const base = capture('d0', 'rows', [], 24, 80, 22)
    let aRow = -1
    let oRow = -1
    if (base) {
      aRow = base.lines.findIndex(l => l.includes('ROW-alpha'))
      oRow = base.lines.findIndex(l => l.includes('ROW-omega'))
      check('rows fixture anchors present', aRow >= 0 && oRow >= 0, `a=${aRow} o=${oRow}`)
    }
    const hoverRows = (grid: Cell[][]): number[] => {
      const out: number[] = []
      grid.forEach((row, y) => {
        if (row.some(c => c.bg?.toLowerCase() === HOVER_BG)) out.push(y)
      })
      return out
    }
    if (aRow >= 0 && oRow >= 0) {
      const d1 = capture('d1', 'rows', [{ atTick: 16, data: motion(4, aRow + 1) }], 26, 80, 22)
      if (d1) {
        const lit = hoverRows(d1.grid)
        check('hover paints exactly the live row', lit.length === 1 && lit[0] === aRow, `lit=${lit.join(',')}`)
      }
      const d2 = capture('d2', 'rows', [{ atTick: 16, data: motion(4, oRow + 1) }], 26, 80, 22)
      if (d2) {
        check('an unavailable row takes NO hover paint', hoverRows(d2.grid).length === 0)
      }
      const d3 = capture(
        'd3',
        'rows',
        [
          { atTick: 14, data: click(4, oRow + 1) },
          { atTick: 18, data: click(4, aRow + 1) },
          { atTick: 22, data: click(4, aRow + 1) },
        ],
        30,
        80,
        22,
      )
      if (d3) {
        check(
          'dead row never fires; live row select-then-activate (sel=alpha acts=1)',
          d3.lines.some(l => l.includes('sel=alpha acts=1')),
          d3.lines.find(l => l.includes('sel=')) ?? '',
        )
      }
    }
  }

  console.log('\n── E. semantic adaptation — hover paint per theme family ────')
  {
    const { resolveMercuryTokens } = await import('../../src/utils/mercuryTokens.ts')
    // Theme values arrive as '#rrggbb' | 'rgb(r, g, b)' | 'ansi:name'; the
    // pyte grid reports lowercase hex (no '#') or the bare ansi name.
    const gridForm = (v: string): string => {
      const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(v)
      if (rgb) {
        return rgb
          .slice(1, 4)
          .map(n => Number(n).toString(16).padStart(2, '0'))
          .join('')
      }
      if (v.startsWith('ansi:')) {
        // The token spells the bright octet chalk-style (`blackbright`); the
        // grid records pyte's name for the same cell (`brightblack`).
        const name = v.slice(5).toLowerCase()
        return name.endsWith('bright') ? `bright${name.slice(0, -'bright'.length)}` : name
      }
      return v.replace(/^#/, '').toLowerCase()
    }
    for (const family of ['light', 'dark-ansi'] as const) {
      const expected = gridForm(resolveMercuryTokens(family, '#DD4444').surface2)
      const base = capture(`e-${family}-0`, 'rows', [], 24, 80, 22, { IROW_THEME: family })
      const aRow = base ? base.lines.findIndex(l => l.includes('ROW-alpha')) : -1
      if (aRow < 0) {
        check(`${family}: fixture renders`, false)
        continue
      }
      const e1 = capture(
        `e-${family}-1`,
        'rows',
        [{ atTick: 16, data: motion(4, aRow + 1) }],
        26,
        80,
        22,
        { IROW_THEME: family },
      )
      if (e1) {
        const litBgs = new Set(
          e1.grid.flatMap(r => r.filter(c => c.bg).map(c => c.bg!.toLowerCase())),
        )
        check(
          `${family}: hover paints THAT family's surface2 (${expected})`,
          litBgs.has(expected),
          `bgs=${[...litBgs].join(',') || 'none'}`,
        )
      }
    }
  }

  console.log()
  if (failures > 0) {
    console.log(`❌ INTERACTIVE-ROW PROOF RED (${failures})`)
    process.exit(1)
  }
  console.log('✅ INTERACTIVE-ROW PROOF PASS')
}
