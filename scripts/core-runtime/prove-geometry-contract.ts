#!/usr/bin/env bun
// ============================================================================
//  scripts/core-runtime/prove-geometry-contract.ts — T7:
//  the input-geometry contract (hit-test + selection), strengthening the B6
//  provers (prove-hit-map, prove-selection-copy) over the PUBLIC seams.
//
//  The characterization set
//  names the unpinned behaviors; these laws close them, implementation-blind
//  where possible and characterization-exact where the current body has a
//  quirk (the T4 precedent: a law that documents a quirk beats a law that
//  asserts what you wish were true — every characterized quirk cites its
//  file:line).
//
//    • DISPATCH — click bubbling order (deepest→up), per-handler
//      localCol/localRow rebase, stopImmediatePropagation, click-to-focus
//      on the nearest tabIndex ancestor, cellIsBlank pass-through.
//    • HIT GEOMETRY — nodeCache-absent subtrees prune; the parent-rect GATE
//      (a child painted outside its parent rect is unreachable); the
//      deepest-wins invariant under a random sweep.
//    • HOVER — enter/leave exact set-diff over a scripted pointer path,
//      non-bubbling between children, detached-node leave skipped,
//      null-hit clears, leave-only handlers join the hover set.
//    • WORD/LINE — the iTerm2 word-char class golden, spacer step-over at
//      CJK run edges, whitespace runs, selectWordAt/selectLineAt state,
//      extendSelection's three-way (backward/forward/overlap) + fallbacks.
//    • URL — multi-URL runs, balanced-closer strip, trailing punctuation,
//      right-edge containment miss, noSelect splits, wide-cell boundary.
//    • LIFECYCLE — startSelection resets ALL families, the anchor-cell
//      tremor guard, finish keeps highlight, clip-band setter edges,
//      bounds normalization, moveFocus semantics.
//    • COPY-TRUTH DIFFERENTIAL — getSelectedText vs a naive char-walk
//      oracle over a composed scene (wrap + CJK + noSelect + clip band),
//      LCG-random drags.
//    • SEE-WHAT-YOU-COPY — the cells restyled by applySelectionOverlay
//      equal the cells contributing to getSelectedText, modulo trailing
//      blanks past the soft-wrap content end; noSelect and the clip band
//      bind paint and copy identically.
//    • OVERLAY STYLE — withSelectionBg preserves fg, replaces bg, drops
//      inverse; the null-bg inverse fallback; spacer cells never restyled.
//    • CLIPPED SOFT-WRAP (T3-audit F4-4) — a wrapped logical line whose
//      first row is scrolled above a ScrollBox viewport: the through-clip
//      softWrap record exists, the visible remainder copies as ONE logical
//      line with the separator space intact, and the capture→shift flow
//      re-joins a captured wrap row across the accumulator seam.
//    • CAPTURE-BOUNDARY — anchor col reset exactly once (+ BOTH anchorSpan
//      cols), the below-side W-1 reset, clip-band capture.
//    • DEBT-ROUND-TRIP — scripted journeys (keyboard scroll, drag-to-scroll,
//      streaming follow, the drag→follow handoff) against a differential
//      ledger model that tracks TRUE document rows and a full off-screen
//      text ledger; accumulator length ≡ debt; both-ends-overshoot clears;
//      the invariant-restore truncation; moveFocus voiding clamp debt.
//    • READ-ONLY+ — every selection operation mutates zero screen cells;
//      applySelectionOverlay changes ONLY style bits.
//
//  Run: ~/.bun/bin/bun run scripts/core-runtime/prove-geometry-contract.ts
// ============================================================================
import type { AnsiCode } from '@alcalzone/ansi-tokenize'
import {
  appendChildNode,
  createNode,
  type DOMElement,
  removeChildNode,
  setAttribute,
} from '../../src/ink/dom.js'
import { FocusManager } from '../../src/ink/focus.js'
import { emptyFrame } from '../../src/ink/frame.js'
import { dispatchClick, dispatchHover, hitTest } from '../../src/ink/geometry/hit.js'
import { nodeCache } from '../../src/ink/node-cache.js'
import createRenderer from '../../src/ink/renderer.js'
import {
  type Cell,
  CellWidth,
  cellAt,
  CharPool,
  charInCellAt,
  createScreen,
  HyperlinkPool,
  type Screen,
  setCellAt,
  StylePool,
} from '../../src/ink/cell-grid.js'
import {
  applySelectionOverlay,
  captureScrolledRows,
  clearSelection,
  createSelectionState,
  extendSelection,
  findPlainTextUrlAt,
  finishSelection,
  getSelectedText,
  hasSelection,
  moveFocus,
  selectionBounds,
  type SelectionState,
  selectLineAt,
  selectWordAt,
  setSelectionClipBand,
  shiftAnchor,
  shiftSelection,
  shiftSelectionForFollow,
  startSelection,
  updateSelection,
} from '../../src/ink/geometry/selection.js'
import {
  applySceneStyle,
  buildDom,
  composeScene,
  type FrameScene,
  makeContext,
  type SceneNode,
  screenLines,
} from '../ink-runtime/frameHarness.js'

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

console.log('native-core T7 — input geometry contract')

// ── shared fixture helpers ──────────────────────────────────────────────────

/** Compose a DOM root through the production layout + renderer so nodeCache
 *  holds this frame's committed rects (the prove-hit-map pattern). */
function compose(root: DOMElement, cols: number, rows: number): void {
  const ctx = makeContext()
  root.layoutNode!.calculateLayout(cols, rows)
  const render = createRenderer(root, ctx.stylePool)
  render({
    frontFrame: emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool),
    backFrame: emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool),
    isTTY: true,
    terminalWidth: cols,
    terminalRows: rows,
    altScreen: true,
    prevFrameContaminated: true,
  })
}

function mkRoot(spec: SceneNode, cols: number, rows: number): DOMElement {
  const root = createNode('ink-root')
  applySceneStyle(root, { width: cols, height: rows, flexDirection: 'column' })
  appendChildNode(root, buildDom(spec))
  return root
}

/** Hand-painted screen: precise cell control for the word/URL goldens and
 *  the ledger journeys (the prove-selection-clip-band pattern — that ui
 *  prover is stale/unwired today; these laws re-pin its ground). */
function mkScreen(w: number, h: number): { screen: Screen; styles: StylePool } {
  const styles = new StylePool()
  const screen = createScreen(w, h, styles, new CharPool(), new HyperlinkPool())
  return { screen, styles }
}

const isWideChar = (ch: string): boolean => (ch.codePointAt(0) ?? 0) >= 0x1100

/** Write text left-to-right from (x, y); CJK glyphs become Wide head +
 *  SpacerTail pairs via setCellAt's own tail write. Returns the end col. */
function putText(
  screen: Screen,
  styles: StylePool,
  x: number,
  y: number,
  text: string,
  styleId?: number,
  hyperlink?: string,
): number {
  let cx = x
  for (const ch of text) {
    const wide = isWideChar(ch)
    const cell: Cell = {
      char: ch,
      styleId: styleId ?? styles.none,
      width: wide ? CellWidth.Wide : CellWidth.Narrow,
      hyperlink,
    }
    setCellAt(screen, cx, y, cell)
    cx += wide ? 2 : 1
  }
  return cx
}

// ════════════════════════════════════════════════════════════════════════════
// LAW DISPATCH — click bubbling · localCol rebase · stopImmediatePropagation ·
// focus climb · cellIsBlank (hit-test.ts:49-89)
// ════════════════════════════════════════════════════════════════════════════
{
  const COLS = 40
  const ROWS = 10
  const root = mkRoot(
    {
      kind: 'box',
      style: { flexDirection: 'row', height: ROWS },
      children: [
        {
          kind: 'box', // A — focusable ancestor
          style: { width: 20, height: 6, flexDirection: 'column' },
          children: [
            {
              kind: 'box', // B — handler, not focusable
              style: { width: 10, height: 3, marginLeft: 2, marginTop: 1 },
              children: [
                {
                  kind: 'box', // C — no handler, no tabIndex
                  style: { width: 6, height: 2, marginLeft: 1 },
                  children: [{ kind: 'text', text: 'cc' }],
                },
              ],
            },
          ],
        },
        {
          kind: 'box', // D — handler that observes E's stop
          style: { width: 8, height: 4 },
          children: [
            { kind: 'box', style: { width: 4, height: 2 }, children: [{ kind: 'text', text: 'ee' }] }, // E
          ],
        },
      ],
    },
    COLS,
    ROWS,
  )
  const outer = root.childNodes[0] as DOMElement
  const boxA = outer.childNodes[0] as DOMElement
  const boxB = boxA.childNodes[0] as DOMElement
  const boxC = boxB.childNodes[0] as DOMElement
  const boxD = outer.childNodes[1] as DOMElement
  const boxE = boxD.childNodes[0] as DOMElement

  const fired: Array<{ who: string; localCol: number; localRow: number; blank: boolean }> = []
  type Click = { localCol: number; localRow: number; cellIsBlank: boolean; stopImmediatePropagation: () => void }
  const rec = (who: string) => (e: Click) => {
    fired.push({ who, localCol: e.localCol, localRow: e.localRow, blank: e.cellIsBlank })
  }
  boxA._eventHandlers = { onClick: rec('A') }
  boxB._eventHandlers = { onClick: rec('B') }
  boxD._eventHandlers = { onClick: rec('D') }
  boxE._eventHandlers = {
    onClick: (e: Click) => {
      fired.push({ who: 'E', localCol: e.localCol, localRow: e.localRow, blank: e.cellIsBlank })
      e.stopImmediatePropagation()
    },
  }
  setAttribute(boxA, 'tabIndex', 1)
  root.focusManager = new FocusManager(() => true)

  compose(root, COLS, ROWS)

  // Bubbling order + per-handler rebase: click inside C (no handler there) —
  // B then A fire, each seeing coords rebased to ITS committed rect
  // (hit-test.ts:78-82 recomputes localCol/localRow before every handler).
  {
    const col = 4
    const row = 2
    fired.length = 0
    const handled = dispatchClick(root, col, row)
    check('dispatch: handlers fire deepest-first', fired.map(f => f.who).join(',') === 'B,A', JSON.stringify(fired))
    check('dispatch: returns true when a handler fired', handled === true)
    const rectB = nodeCache.get(boxB)!
    const rectA = nodeCache.get(boxA)!
    check(
      'dispatch: localCol/localRow rebased per handler',
      fired[0]!.localCol === col - rectB.x &&
        fired[0]!.localRow === row - rectB.y &&
        fired[1]!.localCol === col - rectA.x &&
        fired[1]!.localRow === row - rectA.y,
      JSON.stringify({ fired, rectA, rectB }),
    )
    check('dispatch: cellIsBlank defaults false', fired.every(f => f.blank === false))
    check(
      'dispatch: click-to-focus climbs to the nearest tabIndex ancestor',
      root.focusManager!.activeElement === boxA,
      String(root.focusManager!.activeElement?.nodeName),
    )
  }

  // stopImmediatePropagation halts the bubble (hit-test.ts:84).
  {
    fired.length = 0
    const rectE = nodeCache.get(boxE)!
    const handled = dispatchClick(root, rectE.x + 1, rectE.y)
    check('dispatch: stopImmediatePropagation halts ancestors', fired.map(f => f.who).join(',') === 'E', JSON.stringify(fired))
    check('dispatch: stopped dispatch still returns true', handled === true)
  }

  // No handler on the chain: returns false; focus untouched when no
  // tabIndex ancestor exists on the hit chain either.
  {
    fired.length = 0
    const before = root.focusManager!.activeElement
    const handled = dispatchClick(root, 35, 8) // outer/root only
    check('dispatch: no handler on the chain returns false', handled === false && fired.length === 0, JSON.stringify(fired))
    check('dispatch: focus unchanged without a tabIndex ancestor', root.focusManager!.activeElement === before)
  }

  // cellIsBlank pass-through (hit-test.ts:70).
  {
    fired.length = 0
    dispatchClick(root, 4, 2, true)
    check('dispatch: cellIsBlank=true reaches every handler', fired.length === 2 && fired.every(f => f.blank === true), JSON.stringify(fired))
  }

  // ── LAW HIT GEOMETRY: prune + parent-rect gate + deepest-wins sweep ────────
  {
    // A node appended AFTER compose has no nodeCache rect — its subtree is
    // pruned and the composed parent still resolves (hit-test.ts:23-24).
    const ghost = createNode('ink-box')
    applySceneStyle(ghost, { width: 20, height: 6 })
    appendChildNode(boxA, ghost)
    const hit = hitTest(root, 4, 4)
    check('hit: nodeCache-absent child subtree prunes to the composed parent', hit === boxA, String(hit?.nodeName))
    removeChildNode(boxA, ghost)

    // Parent-rect GATE (hit-test.ts:25-31): hitTest checks the parent's own
    // rect BEFORE descending, so an absolutely-positioned child painted
    // outside its parent's rect is unreachable — the probe falls through to
    // whatever else owns that cell (characterized: position is quantized to
    // the rect tree, not the painted cells).
    const gateRoot = mkRoot(
      {
        kind: 'box',
        style: { height: ROWS },
        children: [
          {
            kind: 'box',
            style: { width: 10, height: 2 },
            children: [
              {
                kind: 'box',
                style: { position: 'absolute', marginLeft: 14, width: 5, height: 2 },
                children: [{ kind: 'text', text: 'esc' }],
              },
            ],
          },
        ],
      },
      COLS,
      ROWS,
    )
    compose(gateRoot, COLS, ROWS)
    const escBox = ((gateRoot.childNodes[0] as DOMElement).childNodes[0] as DOMElement).childNodes[0] as DOMElement
    const escRect = nodeCache.get(escBox)
    if (escRect && escRect.x >= 10) {
      const gated = hitTest(gateRoot, escRect.x + 1, escRect.y)
      check(
        'hit: parent-rect gate — a child painted outside its parent rect is unreachable',
        gated !== escBox && gated !== null,
        JSON.stringify({ escRect, got: gated?.nodeName }),
      )
    } else {
      check('hit: parent-rect gate fixture laid out as expected', false, JSON.stringify(escRect))
    }

    // Deepest-wins invariant under a random sweep: the returned node's own
    // cached element children never contain the probe (hit-test.ts:33-39).
    compose(root, COLS, ROWS)
    const rnd = lcg(0x7e57ab1e)
    let violations = 0
    for (let i = 0; i < 300; i++) {
      const x = Math.floor(rnd() * COLS)
      const y = Math.floor(rnd() * ROWS)
      const h = hitTest(root, x, y)
      if (!h) continue
      const r = nodeCache.get(h)
      if (!r || x < r.x || x >= r.x + r.width || y < r.y || y >= r.y + r.height) {
        violations++
        continue
      }
      for (const c of h.childNodes) {
        if (c.nodeName === '#text') continue
        const cr = nodeCache.get(c as DOMElement)
        if (cr && x >= cr.x && x < cr.x + cr.width && y >= cr.y && y < cr.y + cr.height) violations++
      }
    }
    check('hit: deepest-wins sweep — no cached child of the hit contains the probe', violations === 0, `${violations} violations`)
  }

  // ── LAW HOVER — enter/leave set diff (hit-test.ts:102-130) ────────────────
  {
    const calls: string[] = []
    boxA._eventHandlers = { onMouseEnter: () => calls.push('enter A'), onMouseLeave: () => calls.push('leave A') }
    boxB._eventHandlers = { onMouseEnter: () => calls.push('enter B'), onMouseLeave: () => calls.push('leave B') }
    boxD._eventHandlers = { onMouseLeave: () => calls.push('leave D') } // leave-ONLY handler
    boxE._eventHandlers = {}
    const hovered = new Set<DOMElement>()

    // Enter fires deepest-first (the ancestor walk inserts hit→up; Set
    // iteration preserves insertion order).
    dispatchHover(root, 4, 2, hovered)
    check('hover: enter fires deepest-first on the handler chain', calls.join(',') === 'enter B,enter A', JSON.stringify(calls))

    // Moving within the same chain re-fires nothing (non-bubbling law).
    calls.length = 0
    dispatchHover(root, 5, 2, hovered)
    check('hover: motion within the same chain fires nothing', calls.length === 0, JSON.stringify(calls))

    // Crossing to D: B/A leave (insertion order), D enters silently — a
    // leave-only handler still joins the hovered set (hit-test.ts:112).
    calls.length = 0
    const rectE = nodeCache.get(boxE)!
    dispatchHover(root, rectE.x + 1, rectE.y, hovered)
    check('hover: chain swap fires exact leave set then enter set', calls.join(',') === 'leave B,leave A', JSON.stringify(calls))
    check('hover: leave-only handler joined the hovered set', hovered.has(boxD))

    // Detached node: leave callback SKIPPED, membership still dropped
    // (hit-test.ts:118-121).
    calls.length = 0
    removeChildNode(outer, boxD)
    dispatchHover(root, 35, 8, hovered)
    check('hover: detached node leaves the set without a callback', calls.length === 0 && !hovered.has(boxD), JSON.stringify(calls))

    // Null hit clears everything.
    dispatchHover(root, 4, 2, hovered) // re-enter B/A
    calls.length = 0
    dispatchHover(root, 200, 200, hovered)
    check(
      'hover: null hit clears the set and fires every leave',
      hovered.size === 0 && calls.join(',') === 'leave B,leave A',
      JSON.stringify({ calls, size: hovered.size }),
    )
  }
}

// ════════════════════════════════════════════════════════════════════════════
// The word/URL fixture screen — hand-painted for exact cell control.
// ════════════════════════════════════════════════════════════════════════════
const WU_W = 40
const WU_H = 12
const wu = mkScreen(WU_W, WU_H)
putText(wu.screen, wu.styles, 0, 0, '/usr/local/bin/bash-5.2 -> ok!')
putText(wu.screen, wu.styles, 0, 1, '漢字abc あtail') // 漢字abc あtail
putText(wu.screen, wu.styles, 0, 2, 'a  b')
putText(wu.screen, wu.styles, 0, 3, 'see https://a.co,https://b.co end')
putText(wu.screen, wu.styles, 0, 4, 'go https://en.wk/x_(y) fin')
putText(wu.screen, wu.styles, 0, 5, '(https://x.co/a) t')
putText(wu.screen, wu.styles, 0, 6, 'https://tail.co... x')
putText(wu.screen, wu.styles, 0, 7, 'https://cut.co/abc')
putText(wu.screen, wu.styles, 0, 8, 'file:///tmp/x ok')
putText(wu.screen, wu.styles, 0, 9, '漢https://w.co') // 漢https://w.co
putText(wu.screen, wu.styles, 0, 10, 'linked text', wu.styles.none, 'https://link.example')
// noSelect gutter inside row 7's URL (cols 10-11).
wu.screen.noSelect[7 * WU_W + 10] = 1
wu.screen.noSelect[7 * WU_W + 11] = 1

// ════════════════════════════════════════════════════════════════════════════
// LAW WORD/LINE — the iTerm2 word-char golden + spacer step-over + state
// (selection.ts:153-235, :251-265, :379-391)
// ════════════════════════════════════════════════════════════════════════════
{
  const wordSpanAt = (col: number, row: number): string => {
    const s = createSelectionState()
    selectWordAt(s, wu.screen, col, row)
    if (!s.anchor || !s.focus) return 'none'
    return `${s.anchor.col}..${s.focus.col}@${s.anchor.row}`
  }

  // Golden class table (WORD_CHAR = /[\p{L}\p{N}_/.\-+~\\]/u, :153): paths
  // select whole; '-' is word-class; '>' and '!' are their own runs; spaces
  // are a class-0 run.
  check('word: path run selects whole', wordSpanAt(5, 0) === '0..22@0', wordSpanAt(5, 0))
  check('word: single space is its own run', wordSpanAt(23, 0) === '23..23@0', wordSpanAt(23, 0))
  check('word: minus is word-class, its own run here', wordSpanAt(24, 0) === '24..24@0', wordSpanAt(24, 0))
  check('word: > is punctuation-class run', wordSpanAt(25, 0) === '25..25@0', wordSpanAt(25, 0))
  check('word: ! is punctuation-class run', wordSpanAt(29, 0) === '29..29@0', wordSpanAt(29, 0))
  check('word: interior whitespace run', wordSpanAt(1, 2) === '1..2@2', wordSpanAt(1, 2))
  // Blank tail: unwritten cells are class-0 spaces — double-click on the
  // void selects the blank run but copies nothing (trailing trim, :754).
  check('word: blank tail selects the space run to the edge', wordSpanAt(10, 2) === `4..${WU_W - 1}@2`, wordSpanAt(10, 2))
  {
    const s = createSelectionState()
    selectWordAt(s, wu.screen, 10, 2)
    check('word: blank-run copy is empty after trailing trim', getSelectedText(s, wu.screen) === '')
  }

  // CJK spacer step-over: 漢[0-1] 字[2-3] abc[4-6] — one \p{L} run 0..6;
  // a click on a SpacerTail rebases to its head (:186-189, :205-211).
  check('word: CJK+ascii one run with tails included', wordSpanAt(4, 1) === '0..6@1', wordSpanAt(4, 1))
  check('word: click on a wide tail rebases to the head run', wordSpanAt(1, 1) === '0..6@1', wordSpanAt(1, 1))
  check('word: あtail run from the head cell', wordSpanAt(8, 1) === '8..13@1', wordSpanAt(8, 1))
  {
    const s = createSelectionState()
    selectWordAt(s, wu.screen, 4, 1)
    check('word: CJK run copies whole glyphs', getSelectedText(s, wu.screen) === '漢字abc', JSON.stringify(getSelectedText(s, wu.screen)))
    check(
      'word: selectWordAt arms drag-extend state',
      s.isDragging === true && s.anchorSpan?.kind === 'word' && s.anchorSpan.lo.col === 0 && s.anchorSpan.hi.col === 6,
      JSON.stringify(s.anchorSpan),
    )
  }

  // noSelect / OOB are no-ops that leave prior state intact (:190, :257-258).
  {
    const s = createSelectionState()
    selectWordAt(s, wu.screen, 5, 0)
    const before = JSON.stringify({ a: s.anchor, f: s.focus, sp: s.anchorSpan })
    selectWordAt(s, wu.screen, 10, 7) // noSelect cell
    selectWordAt(s, wu.screen, 5, 99) // OOB row
    check('word: noSelect/OOB clicks are state-preserving no-ops', JSON.stringify({ a: s.anchor, f: s.focus, sp: s.anchorSpan }) === before)
  }

  // selectLineAt spans the full row; copy is the trimmed visible line (:379).
  {
    const s = createSelectionState()
    selectLineAt(s, wu.screen, 0)
    check(
      'line: selectLineAt spans col 0..W-1 and arms line mode',
      s.anchor?.col === 0 && s.focus?.col === WU_W - 1 && s.anchorSpan?.kind === 'line' && s.isDragging === true,
      JSON.stringify({ a: s.anchor, f: s.focus }),
    )
    check('line: copy is the visible line, trailing-trimmed', getSelectedText(s, wu.screen) === '/usr/local/bin/bash-5.2 -> ok!')
    selectLineAt(s, wu.screen, 99)
    check('line: OOB selectLineAt is a no-op', s.anchor?.row === 0)
  }

  // ── extendSelection three-way (:400-432) ──────────────────────────────────
  {
    const s = createSelectionState()
    selectWordAt(s, wu.screen, 5, 0) // span 0..22
    extendSelection(s, wu.screen, 27, 0) // 'ok' → [27,28], starts after span
    check('extend: forward — anchor=span.lo, focus=word.hi', s.anchor?.col === 0 && s.focus?.col === 28, JSON.stringify({ a: s.anchor, f: s.focus }))
    extendSelection(s, wu.screen, 10, 0) // overlaps the span
    check('extend: overlap — the anchor span alone stays selected', s.anchor?.col === 0 && s.focus?.col === 22, JSON.stringify({ a: s.anchor, f: s.focus }))

    const s2 = createSelectionState()
    selectWordAt(s2, wu.screen, 27, 0) // span 27..28 'ok'
    extendSelection(s2, wu.screen, 5, 0) // word [0,22] ends before span
    check('extend: backward — anchor=span.hi, focus=word.lo', s2.anchor?.col === 28 && s2.focus?.col === 0, JSON.stringify({ a: s2.anchor, f: s2.focus }))

    // noSelect fallback: the raw cell extends the selection (:411-413).
    const s3 = createSelectionState()
    selectWordAt(s3, wu.screen, 5, 0)
    extendSelection(s3, wu.screen, 10, 7) // noSelect cell → raw (10,7)
    check('extend: noSelect falls back to the raw cell', s3.focus?.col === 10 && s3.focus?.row === 7, JSON.stringify(s3.focus))

    // CHARACTERIZED QUIRK (:411-413): word-mode OOB fallback does NOT clamp
    // the row — the raw (col,row) rides out of screen bounds (line mode
    // clamps, :415). Screen-bounds application is the caller's job
    // (ink.tsx moveSelectionFocus).
    const s4 = createSelectionState()
    selectWordAt(s4, wu.screen, 5, 0)
    extendSelection(s4, wu.screen, 5, 99)
    check('extend: word-mode OOB row rides unclamped (quirk :411-413)', s4.focus?.row === 99, JSON.stringify(s4.focus))

    // Line-mode extend: whole rows, row clamped.
    const s5 = createSelectionState()
    selectLineAt(s5, wu.screen, 2)
    extendSelection(s5, wu.screen, 5, 4)
    check('extend: line mode extends by whole rows', s5.anchor?.row === 2 && s5.anchor.col === 0 && s5.focus?.row === 4 && s5.focus.col === WU_W - 1, JSON.stringify({ a: s5.anchor, f: s5.focus }))
    extendSelection(s5, wu.screen, 5, 0)
    check('extend: line mode backward from the span', s5.anchor?.row === 2 && s5.anchor.col === WU_W - 1 && s5.focus?.row === 0 && s5.focus.col === 0, JSON.stringify({ a: s5.anchor, f: s5.focus }))
    extendSelection(s5, wu.screen, 5, 99)
    check('extend: line mode clamps the OOB row', s5.focus?.row === WU_H - 1, JSON.stringify(s5.focus))

    // Guards: no anchorSpan / not dragging → no-op (:406).
    const s6 = createSelectionState()
    startSelection(s6, 1, 0)
    updateSelection(s6, 3, 0)
    extendSelection(s6, wu.screen, 9, 0)
    check('extend: char-mode drag (no anchorSpan) is untouched', s6.focus?.col === 3)
    const s7 = createSelectionState()
    selectWordAt(s7, wu.screen, 5, 0)
    finishSelection(s7)
    extendSelection(s7, wu.screen, 27, 0)
    check('extend: finished drag is untouched', s7.focus?.col === 22)
  }
}

// ════════════════════════════════════════════════════════════════════════════
// LAW URL — findPlainTextUrlAt (selection.ts:283-370)
// ════════════════════════════════════════════════════════════════════════════
{
  const url = (col: number, row: number): string => findPlainTextUrlAt(wu.screen, col, row) ?? 'undefined'
  // Two URLs, one run: the LAST scheme anchor at/before the click wins
  // (:326-340).
  check('url: first of two in one run', url(8, 3) === 'https://a.co', url(8, 3))
  check('url: second of two in one run', url(20, 3) === 'https://b.co', url(20, 3))
  check('url: last char of the second', url(28, 3) === 'https://b.co', url(28, 3))
  // The comma between them: the first URL is stripped back past the click
  // column → right-edge containment miss (:367).
  check('url: the separating comma resolves to none', url(16, 3) === 'undefined', url(16, 3))
  // Balanced closers survive (:344-364).
  check('url: balanced (y) kept', url(10, 4) === 'https://en.wk/x_(y)', url(10, 4))
  // Unbalanced closer stripped: the wrapping paren is outside the scheme
  // slice, so the trailing) is unmatched.
  check('url: wrapping paren stripped', url(5, 5) === 'https://x.co/a', url(5, 5))
  check('url: click on the stripped closer misses (right edge)', url(15, 5) === 'undefined', url(15, 5))
  // Trailing sentence punctuation stripped; clicking on it misses.
  check('url: trailing dots stripped', url(3, 6) === 'https://tail.co', url(3, 6))
  check('url: click on a stripped dot misses', url(16, 6) === 'undefined', url(16, 6))
  // noSelect gutter splits the run (:298, :309, :317).
  check('url: click on the noSelect cell misses', url(10, 7) === 'undefined', url(10, 7))
  check('url: right fragment after the gutter has no scheme', url(15, 7) === 'undefined', url(15, 7))
  // CHARACTERIZED QUIRK: the left fragment IS returned truncated — the run
  // stops at the gutter and the scheme+prefix pass every check (:307-321).
  check('url: left fragment returns the truncated URL (quirk)', url(5, 7) === 'https://cu', url(5, 7))
  // file:// scheme; plain word; space.
  check('url: file scheme resolves', url(4, 8) === 'file:///tmp/x', url(4, 8))
  check('url: schemeless word misses', url(14, 8) === 'undefined', url(14, 8))
  check('url: space misses', url(13, 8) === 'undefined', url(13, 8))
  // Wide-cell boundary: the run stops at a non-Narrow cell (:305, :311);
  // a click on the wide glyph itself misses (not a URL char).
  check('url: run bounded by the wide glyph still resolves', url(6, 9) === 'https://w.co', url(6, 9))
  check('url: click on the wide tail rebases to the head and misses', url(1, 9) === 'undefined', url(1, 9))
  check('url: OOB row misses', url(0, 99) === 'undefined')
}

// ════════════════════════════════════════════════════════════════════════════
// LAW LIFECYCLE — state families, tremor guard, clip band, bounds, moveFocus
// (selection.ts:74-145, :111-125, :453-461, :687-703, :787-800)
// ════════════════════════════════════════════════════════════════════════════
{
  const s = createSelectionState()
  check(
    'lifecycle: created state is fully empty',
    s.anchor === null && s.focus === null && !s.isDragging && s.anchorSpan === null &&
      s.scrolledOffAbove.length === 0 && s.scrolledOffBelow.length === 0 && s.lastPressHadAlt === false,
  )

  // Dirty every family, then startSelection resets ALL of them (:88-109).
  s.anchorSpan = { lo: { col: 1, row: 1 }, hi: { col: 2, row: 1 }, kind: 'word' }
  s.scrolledOffAbove = ['x']
  s.scrolledOffAboveSW = [true]
  s.scrolledOffBelow = ['y']
  s.scrolledOffBelowSW = [false]
  s.virtualAnchorRow = -3
  s.virtualFocusRow = 9
  s.clipLo = 2
  s.clipHi = 5
  s.lastPressHadAlt = true
  startSelection(s, 4, 2)
  check(
    'lifecycle: startSelection resets every family',
    s.anchor?.col === 4 && s.focus === null && s.isDragging && s.anchorSpan === null &&
      s.scrolledOffAbove.length === 0 && s.scrolledOffBelow.length === 0 &&
      s.scrolledOffAboveSW.length === 0 && s.scrolledOffBelowSW.length === 0 &&
      s.virtualAnchorRow === undefined && s.virtualFocusRow === undefined &&
      s.clipLo === undefined && s.clipHi === undefined && s.lastPressHadAlt === false,
    JSON.stringify(s),
  )

  // Tremor guard (:117-124): first motion at the anchor cell is a no-op; a
  // real drag then returning TO the anchor cell is a valid 1-cell selection.
  updateSelection(s, 4, 2)
  check('lifecycle: anchor-cell tremor leaves focus null', s.focus === null)
  check('lifecycle: bare click has no selection', hasSelection(s) === false && selectionBounds(s) === null)
  updateSelection(s, 6, 2)
  check('lifecycle: real motion sets focus', s.focus?.col === 6)
  updateSelection(s, 4, 2)
  check('lifecycle: returning to the anchor cell IS a 1-cell selection', s.focus?.col === 4 && s.focus.row === 2)

  finishSelection(s)
  check('lifecycle: finish keeps the highlight', !s.isDragging && s.anchor !== null && s.focus !== null)
  updateSelection(s, 9, 9)
  check('lifecycle: updates after finish are ignored', s.focus?.col === 4)
  clearSelection(s)
  check('lifecycle: clear empties everything', s.anchor === null && s.focus === null && !hasSelection(s))

  // Bounds normalization (:695-703).
  const s2 = createSelectionState()
  startSelection(s2, 8, 4)
  updateSelection(s2, 2, 1)
  const b = selectionBounds(s2)!
  check('lifecycle: bounds normalize reading order across rows', b.start.row === 1 && b.start.col === 2 && b.end.row === 4 && b.end.col === 8)
  const s3 = createSelectionState()
  startSelection(s3, 8, 2)
  updateSelection(s3, 2, 2)
  const b3 = selectionBounds(s3)!
  check('lifecycle: bounds normalize col order on one row', b3.start.col === 2 && b3.end.col === 8)

  // Clip-band setter edges (:787-800).
  const s4 = createSelectionState()
  setSelectionClipBand(s4, 0, 39, 40)
  check('clip band: full width stores undefined (byte-identical path)', s4.clipLo === undefined && s4.clipHi === undefined)
  setSelectionClipBand(s4, -3, 12, 40)
  check('clip band: negative lo clamps to 0', s4.clipLo === 0 && s4.clipHi === 12)
  setSelectionClipBand(s4, 9, 4, 40)
  check('clip band: hi floors at lo', s4.clipLo === 9 && s4.clipHi === 9)

  // moveFocus (:453-461): needs a focus; drops to char mode; voids the
  // focus clamp debt; preserves accumulators.
  const s5 = createSelectionState()
  startSelection(s5, 1, 1)
  moveFocus(s5, 5, 5)
  check('moveFocus: no-op before any drag motion', s5.focus === null)
  updateSelection(s5, 3, 3)
  s5.anchorSpan = { lo: { col: 1, row: 1 }, hi: { col: 3, row: 3 }, kind: 'word' }
  s5.virtualFocusRow = 12
  s5.virtualAnchorRow = -2
  s5.scrolledOffAbove = ['kept']
  s5.scrolledOffAboveSW = [false]
  moveFocus(s5, 6, 4)
  check(
    'moveFocus: sets focus, drops to char mode, voids ONLY the focus debt, keeps accumulators',
    s5.focus?.col === 6 && s5.focus.row === 4 && s5.anchorSpan === null &&
      s5.virtualFocusRow === undefined && s5.virtualAnchorRow === -2 && s5.scrolledOffAbove[0] === 'kept',
    JSON.stringify(s5),
  )
}

// ════════════════════════════════════════════════════════════════════════════
// The composed copy scene — production wrap/noSelect/CJK through the real
// compose walk (frameHarness), for the differential + overlay laws.
// ════════════════════════════════════════════════════════════════════════════
const CP_W = 26
const CP_H = 7
const copyScene: FrameScene = {
  name: 'geometry-copy',
  cols: CP_W,
  rows: CP_H,
  root: {
    kind: 'box',
    style: { flexDirection: 'column' },
    children: [
      { kind: 'text', text: 'first line of text plus' },
      { kind: 'text', text: 'あい漢字 wide row' }, // あい漢字 wide row
      {
        kind: 'box',
        style: { flexDirection: 'row' },
        children: [
          { kind: 'box', style: { width: 3, noSelect: true }, children: [{ kind: 'text', text: '## ' }] },
          { kind: 'text', text: 'gutter row content' },
        ],
      },
      { kind: 'text', text: 'wrap alpha beta gamma delta' },
      { kind: 'text', text: 'tail line' },
    ],
  },
}

/** Independent char-walk oracle over the PUBLIC screen surface — mirrors the
 *  documented extraction semantics (noSelect skip, spacer skip, soft-wrap
 *  contentEnd clamp + join, trailing trim, clip band). */
function oracleCopy(screen: Screen, s: SelectionState): string {
  const b = selectionBounds(s)
  if (!b) return ''
  const lines: string[] = []
  const joinPush = (text: string, sw: boolean): void => {
    if (sw && lines.length > 0) lines[lines.length - 1] += text
    else lines.push(text)
  }
  for (let i = 0; i < s.scrolledOffAbove.length; i++) joinPush(s.scrolledOffAbove[i]!, s.scrolledOffAboveSW[i] === true)
  const lo = s.clipLo ?? 0
  const hi = s.clipHi ?? screen.width - 1
  for (let row = b.start.row; row <= b.end.row; row++) {
    const rowStart = Math.max(row === b.start.row ? b.start.col : 0, lo)
    const rowEnd = Math.min(row === b.end.row ? b.end.col : screen.width - 1, hi)
    if (rowEnd < rowStart) continue
    const contentEnd = row + 1 < screen.height ? screen.softWrap[row + 1]! : 0
    const lastCol = contentEnd > 0 ? Math.min(rowEnd, contentEnd - 1) : rowEnd
    let line = ''
    for (let col = rowStart; col <= lastCol; col++) {
      if (screen.noSelect[row * screen.width + col] === 1) continue
      const cell = cellAt(screen, col, row)
      if (!cell || cell.width === CellWidth.SpacerTail || cell.width === CellWidth.SpacerHead) continue
      line += cell.char
    }
    joinPush(contentEnd > 0 ? line : line.replace(/\s+$/, ''), screen.softWrap[row]! > 0)
  }
  for (let i = 0; i < s.scrolledOffBelow.length; i++) joinPush(s.scrolledOffBelow[i]!, s.scrolledOffBelowSW[i] === true)
  return lines.join('\n')
}

{
  const frame = composeScene(copyScene, makeContext())
  const screen = frame.screen

  // Scene sanity: the long line wrapped (production softWrap present).
  check('copy scene: production soft-wrap composed', screen.softWrap.some(v => v > 0), JSON.stringify([...screen.softWrap]))

  const drag = (c0: number, r0: number, c1: number, r1: number, band?: [number, number]): SelectionState => {
    const s = createSelectionState()
    startSelection(s, c0, r0)
    if (band) setSelectionClipBand(s, band[0], band[1], screen.width)
    updateSelection(s, c1, r1)
    finishSelection(s)
    return s
  }

  // Fixed goldens.
  check('copy: full first row', getSelectedText(drag(0, 0, CP_W - 1, 0), screen) === 'first line of text plus', JSON.stringify(getSelectedText(drag(0, 0, CP_W - 1, 0), screen)))
  check('copy: noSelect gutter excluded from a full-row drag', getSelectedText(drag(0, 2, CP_W - 1, 2), screen) === 'gutter row content', JSON.stringify(getSelectedText(drag(0, 2, CP_W - 1, 2), screen)))
  {
    const wrapped = getSelectedText(drag(0, 3, CP_W - 1, 4), screen)
    check('copy: wrapped rows join into ONE logical line', wrapped === 'wrap alpha beta gamma delta', JSON.stringify(wrapped))
  }

  // LCG differential: random drags (± clip band) vs the char-walk oracle,
  // plus the SEE-WHAT-YOU-COPY overlay-set law on every draw.
  const selBg: AnsiCode = { type: 'ansi', code: '\x1b[48;2;7;7;7m', endCode: '\x1b[49m' }
  const rand = lcg(0x93e0e781)
  let diffFails = 0
  let overlayFails = 0
  for (let rep = 0; rep < 80; rep++) {
    const c0 = Math.floor(rand() * CP_W)
    const r0 = Math.floor(rand() * CP_H)
    const c1 = Math.floor(rand() * CP_W)
    const r1 = Math.floor(rand() * CP_H)
    const band: [number, number] | undefined =
      rep % 2 === 0 ? undefined : ([Math.floor(rand() * 10), 10 + Math.floor(rand() * (CP_W - 10))] as [number, number])
    const s = drag(c0, r0, c1, r1, band)
    const got = getSelectedText(s, screen)
    const want = oracleCopy(screen, s)
    if (got !== want) {
      diffFails++
      if (diffFails === 1) console.log(`  [diff] rep ${rep} (${c0},${r0})→(${c1},${r1}) band=${JSON.stringify(band)} got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)
    }

    // Overlay-set law on a fresh compose (the overlay mutates styles). The
    // production shape: the SAME pool the screen was composed with, so a
    // derived overlay id can never collide with a base id.
    const octx = makeContext()
    const oscreen = composeScene(copyScene, octx).screen
    const before: number[][] = []
    for (let y = 0; y < CP_H; y++) {
      const rowIds: number[] = []
      for (let x = 0; x < CP_W; x++) rowIds.push(cellAt(oscreen, x, y)!.styleId)
      before.push(rowIds)
    }
    octx.stylePool.setSelectionBg(selBg)
    applySelectionOverlay(oscreen, s, octx.stylePool)
    const bounds = selectionBounds(s)
    const bandLo = s.clipLo ?? 0
    const bandHi = s.clipHi ?? CP_W - 1
    for (let y = 0; y < CP_H; y++) {
      for (let x = 0; x < CP_W; x++) {
        const restyled = cellAt(oscreen, x, y)!.styleId !== before[y]![x]
        if (!restyled) continue
        // Every restyled cell is inside the normalized selection ∩ band,
        // never noSelect, never a spacer.
        const cell = cellAt(oscreen, x, y)!
        const inRange =
          bounds !== null &&
          y >= bounds.start.row &&
          y <= bounds.end.row &&
          !(y === bounds.start.row && x < bounds.start.col) &&
          !(y === bounds.end.row && x > bounds.end.col) &&
          x >= bandLo &&
          x <= bandHi
        const legal =
          inRange &&
          oscreen.noSelect[y * CP_W + x] !== 1 &&
          cell.width !== CellWidth.SpacerTail &&
          cell.width !== CellWidth.SpacerHead
        if (!legal) {
          overlayFails++
          if (overlayFails === 1) console.log(`  [overlay] rep ${rep} illegal restyle at (${x},${y})`)
        }
      }
    }
    // And every cell the copy walked (non-space contribution) is restyled.
    if (bounds) {
      for (let row = bounds.start.row; row <= bounds.end.row; row++) {
        const rowStart = Math.max(row === bounds.start.row ? bounds.start.col : 0, bandLo)
        const rowEnd = Math.min(row === bounds.end.row ? bounds.end.col : CP_W - 1, bandHi)
        const contentEnd = row + 1 < CP_H ? oscreen.softWrap[row + 1]! : 0
        const lastCol = contentEnd > 0 ? Math.min(rowEnd, contentEnd - 1) : rowEnd
        for (let col = rowStart; col <= lastCol; col++) {
          if (oscreen.noSelect[row * CP_W + col] === 1) continue
          const cell = cellAt(oscreen, col, row)
          if (!cell || cell.width === CellWidth.SpacerTail || cell.width === CellWidth.SpacerHead) continue
          if (cell.char !== ' ' && cell.char !== '') {
            const restyled = cell.styleId !== before[row]![col]
            if (!restyled) {
              overlayFails++
              if (overlayFails === 1) console.log(`  [overlay] rep ${rep} contributing cell NOT restyled at (${col},${row})`)
            }
          }
        }
      }
    }
  }
  check('copy: 80-rep LCG differential vs the char-walk oracle', diffFails === 0, `${diffFails} mismatches`)
  check('see-what-you-copy: overlay set ≡ contribution set on every draw', overlayFails === 0, `${overlayFails} violations`)
}

// ════════════════════════════════════════════════════════════════════════════
// LAW OVERLAY STYLE — withSelectionBg semantics through the overlay
// (selection.ts:930-958 + cell-grid.ts:206-231, :552-563)
// ════════════════════════════════════════════════════════════════════════════
{
  const { screen, styles } = mkScreen(8, 1)
  const FG: AnsiCode = { type: 'ansi', code: '\x1b[31m', endCode: '\x1b[39m' }
  const BG: AnsiCode = { type: 'ansi', code: '\x1b[44m', endCode: '\x1b[49m' }
  const INV: AnsiCode = { type: 'ansi', code: '\x1b[7m', endCode: '\x1b[27m' }
  const fgId = styles.intern([FG])
  const bgId = styles.intern([BG])
  const invId = styles.intern([INV])
  const bothId = styles.intern([FG, BG])
  putText(screen, styles, 0, 0, 'a', fgId)
  putText(screen, styles, 1, 0, 'b', bgId)
  putText(screen, styles, 2, 0, 'c', invId)
  putText(screen, styles, 3, 0, 'd', bothId)
  putText(screen, styles, 4, 0, '漢', fgId) // wide head at 4, tail at 5
  putText(screen, styles, 6, 0, 'e')

  const SEL: AnsiCode = { type: 'ansi', code: '\x1b[48;2;1;2;3m', endCode: '\x1b[49m' }
  styles.setSelectionBg(SEL)
  const s = createSelectionState()
  startSelection(s, 0, 0)
  updateSelection(s, 7, 0)
  finishSelection(s)
  const tailIdBefore = cellAt(screen, 5, 0)!.styleId
  applySelectionOverlay(screen, s, styles)

  const codesAt = (x: number): string[] => styles.get(cellAt(screen, x, 0)!.styleId).map(c => c.code)
  check('overlay: fg preserved + selection bg appended', JSON.stringify(codesAt(0)) === JSON.stringify([FG.code, SEL.code]), JSON.stringify(codesAt(0)))
  check('overlay: base bg replaced by the selection bg', JSON.stringify(codesAt(1)) === JSON.stringify([SEL.code]), JSON.stringify(codesAt(1)))
  check('overlay: base inverse dropped (no striping)', JSON.stringify(codesAt(2)) === JSON.stringify([SEL.code]), JSON.stringify(codesAt(2)))
  check('overlay: fg kept, bg swapped on a combined style', JSON.stringify(codesAt(3)) === JSON.stringify([FG.code, SEL.code]), JSON.stringify(codesAt(3)))
  check('overlay: wide head restyled', codesAt(4).includes(SEL.code), JSON.stringify(codesAt(4)))
  check('overlay: spacer tail untouched (setCellStyleId refuses spacers)', cellAt(screen, 5, 0)!.styleId === tailIdBefore)
  check('overlay: unstyled cell gains exactly the selection bg', JSON.stringify(codesAt(6)) === JSON.stringify([SEL.code]), JSON.stringify(codesAt(6)))

  // Null selection bg falls back to inverse; an already-inverse base is
  // unchanged (cell-grid.ts:220, :174-183).
  const fresh = mkScreen(4, 1)
  const fFG = fresh.styles.intern([FG])
  const fINV = fresh.styles.intern([INV])
  putText(fresh.screen, fresh.styles, 0, 0, 'a', fFG)
  putText(fresh.screen, fresh.styles, 1, 0, 'b', fINV)
  const s2 = createSelectionState()
  startSelection(s2, 0, 0)
  updateSelection(s2, 1, 0)
  applySelectionOverlay(fresh.screen, s2, fresh.styles)
  const fCodes = (x: number): string[] => fresh.styles.get(cellAt(fresh.screen, x, 0)!.styleId).map(c => c.code)
  check('overlay: null bg falls back to base+inverse', JSON.stringify(fCodes(0)) === JSON.stringify([FG.code, INV.code]), JSON.stringify(fCodes(0)))
  check('overlay: already-inverse base never stacks SGR 7', JSON.stringify(fCodes(1)) === JSON.stringify([INV.code]), JSON.stringify(fCodes(1)))

  // Hyperlink cells copy as plain chars (whole-glyph, link invisible).
  const link = mkScreen(12, 1)
  putText(link.screen, link.styles, 0, 0, 'go 漢x', link.styles.none, 'https://l.example')
  const s3 = createSelectionState()
  startSelection(s3, 0, 0)
  updateSelection(s3, 5, 0)
  check('copy: hyperlinked wide text copies whole glyphs, link invisible', getSelectedText(s3, link.screen) === 'go 漢x', JSON.stringify(getSelectedText(s3, link.screen)))
}

// ════════════════════════════════════════════════════════════════════════════
// LAW CLIPPED SOFT-WRAP (T3-audit F4-4) — a wrapped logical line straddling a
// ScrollBox viewport top, composed through the production walk
// (compose-buffer.ts:359-371 writes the through-clip record;
//  selection.ts:727-755 + :761-771 consume it)
// ════════════════════════════════════════════════════════════════════════════
const SW_W = 24
const SW_H = 5
const LONG = 'alpha bravo charlie delta echo foxtrot golf hotel india'
function scrollScene(scrollTop: number): FrameScene {
  return {
    name: 'geometry-scroll',
    cols: SW_W,
    rows: SW_H,
    root: {
      kind: 'box',
      style: { flexDirection: 'column' },
      children: [
        { kind: 'text', text: 'HEADER' },
        {
          kind: 'box',
          style: { height: SW_H - 1, width: '100%', overflow: 'scroll', flexDirection: 'column' },
          children: [
            {
              kind: 'box',
              style: { flexDirection: 'column', flexGrow: 1, flexShrink: 0, width: '100%' },
              children: [
                { kind: 'text', text: LONG },
                { kind: 'text', text: 'plain second' },
                { kind: 'text', text: 'plain third' },
                { kind: 'text', text: 'plain fourth' },
              ],
            },
          ],
        },
      ],
    },
  }
}
/** Compose the scroll scene with the given scrollTop pinned on the box. */
function composeScrolled(scrollTop: number): Screen {
  const scene = scrollScene(scrollTop)
  // buildDom runs inside composeScene; pin scroll state via a wrapper that
  // finds the scrollbox after the tree is built — composeScene builds its
  // own tree, so replicate its steps here with the scroll pinned pre-render.
  const ctx = makeContext()
  const root = createNode('ink-root')
  applySceneStyle(root, { width: scene.cols, height: scene.rows, flexDirection: 'column' })
  appendChildNode(root, buildDom(scene.root))
  const column = root.childNodes[0] as DOMElement
  const scrollBox = column.childNodes[1] as DOMElement
  scrollBox.scroll = { scrollTop, lastStableAtBottom: false }
  root.layoutNode!.calculateLayout(scene.cols, scene.rows)
  const render = createRenderer(root, ctx.stylePool)
  const front = emptyFrame(scene.rows, scene.cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
  const back = emptyFrame(scene.rows, scene.cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
  return render({
    frontFrame: front,
    backFrame: back,
    isTTY: true,
    terminalWidth: scene.cols,
    terminalRows: scene.rows,
    altScreen: true,
    prevFrameContaminated: true,
  }).frame.screen
}

{
  const screen = composeScrolled(1)
  const lines = screenLines(screen)
  check('f4-4 scene: header row intact above the scrollbox', lines[0] === 'HEADER', JSON.stringify(lines))
  // The through-clip softWrap record: screen row 1 is the SECOND wrap row of
  // LONG (the first is scrolled above the viewport) and carries the clipped
  // previous row's content end (compose-buffer.ts:365-367).
  // NEGATIVE by the T7 encoding: through-clip — the predecessor was
  // clipped above the viewport and never painted (a positive record means
  // row-1 is the true on-screen predecessor).
  check('f4-4: through-clip softWrap record exists at the viewport top, NEGATED', screen.softWrap[1]! < 0, JSON.stringify([...screen.softWrap]))
  check('f4-4: mid-viewport wrap row still marked', screen.softWrap[2]! > 0, JSON.stringify([...screen.softWrap]))

  const drag = (c0: number, r0: number, c1: number, r1: number, band?: [number, number]): string => {
    const s = createSelectionState()
    startSelection(s, c0, r0)
    if (band) setSelectionClipBand(s, band[0], band[1], SW_W)
    updateSelection(s, c1, r1)
    finishSelection(s)
    return getSelectedText(s, screen)
  }

  // Copying the visible remainder of the wrapped line yields ONE logical
  // line whose words are a contiguous suffix of the source — the separator
  // space at each join survives via the contentEnd clamp (selection.ts:
  // 735-736, :754) and no character is lost or duplicated.
  const remainder = drag(0, 1, SW_W - 1, 2)
  check('f4-4: visible remainder copies as one logical line', !remainder.includes('\n'), JSON.stringify(remainder))
  check('f4-4: remainder is a contiguous suffix of the source line', LONG.endsWith(remainder) && remainder.length > 0, JSON.stringify(remainder))

  // The wrap row mid-viewport joins the same way when selected alone with
  // the row after it (a settled plain line): newline separates them.
  const midJoin = drag(0, 2, SW_W - 1, 3)
  check('f4-4: wrap tail + plain line keep the newline between logical lines', midJoin.split('\n').length === 2 && midJoin.endsWith('plain second'), JSON.stringify(midJoin))

  // FIXED during the T7 cut (the through-clip sign bit — compose-buffer
  // negates a record whose predecessor was never painted; extraction joins
  // only on POSITIVE records or, for a negative one, onto the accumulator
  // flow): a selection spanning the scrollbox top boundary keeps the
  // newline between the static header and the first visible wrap row, and
  // the header trims normally instead of padding to the misattributed
  // contentEnd.
  const headerJoin = drag(0, 0, SW_W - 1, 1)
  check('f4-4 fixed: boundary-spanning copy keeps the header on its own line',
    headerJoin.split('\n').length === 2 && headerJoin.split('\n')[0] === 'HEADER',
    JSON.stringify(headerJoin))

  // Clip band over wrapped rows: per-row band clamps compose with the
  // soft-wrap join — pinned by oracle equality (each ROW contributes at
  // most band-width chars; the join then concatenates the contributions).
  {
    const s = createSelectionState()
    startSelection(s, 0, 1)
    setSelectionClipBand(s, 0, 11, SW_W)
    updateSelection(s, SW_W - 1, 2)
    finishSelection(s)
    const banded = getSelectedText(s, screen)
    check('f4-4: banded wrap extraction matches the char-walk oracle', banded === oracleCopy(screen, s), JSON.stringify(banded))
  }

  // The capture→shift flow across the wrap seam: capture the viewport-top
  // wrap row, shift, recompose one row further — the captured continuation
  // re-joins the on-screen wrap row through the accumulator (the F4-4 loop
  // closed end-to-end: scroll-while-selected preserves the logical line).
  const s = createSelectionState()
  startSelection(s, 0, 1)
  updateSelection(s, SW_W - 1, 3)
  finishSelection(s)
  const before = getSelectedText(s, screen)
  captureScrolledRows(s, screen, 1, 1, 'above')
  check('f4-4: captured wrap row records its soft-wrap bit', s.scrolledOffAboveSW[0] === true, JSON.stringify(s.scrolledOffAboveSW))
  shiftSelection(s, -1, 1, SW_H - 1, SW_W)
  const screen2 = composeScrolled(2)
  const after = getSelectedText(s, screen2)
  check('f4-4: capture→shift over the wrap seam preserves the copied text', after === before, JSON.stringify({ before, after }))
}

// ════════════════════════════════════════════════════════════════════════════
// LAW CAPTURE-BOUNDARY — anchor col reset exactly once + BOTH span cols +
// clip band + the below side (selection.ts:845-912, :836-840)
// ════════════════════════════════════════════════════════════════════════════
{
  const W = 20
  const H = 6
  const { screen, styles } = mkScreen(W, H)
  for (let y = 0; y < H; y++) putText(screen, styles, 0, y, `row${y} abcdefghij`)

  // side='above': anchor col reset to 0 after its row is captured (:886-895).
  {
    const s = createSelectionState()
    startSelection(s, 5, 1)
    updateSelection(s, 8, 4)
    captureScrolledRows(s, screen, 0, 1, 'above')
    check('capture above: only selection-intersecting rows captured', s.scrolledOffAbove.length === 1, JSON.stringify(s.scrolledOffAbove))
    check('capture above: the anchor row honored its col at capture time', s.scrolledOffAbove[0] === 'row1 abcdefghij'.slice(5), JSON.stringify(s.scrolledOffAbove))
    check('capture above: anchor col reset to the full-width edge', s.anchor?.col === 0 && s.anchor.row === 1, JSON.stringify(s.anchor))
    // A second capture of a NON-anchor row leaves the (already reset)
    // anchor untouched — the reset consumed the constraint exactly once.
    captureScrolledRows(s, screen, 2, 2, 'above')
    check('capture above: second row captured full-width', s.scrolledOffAbove[1] === 'row2 abcdefghij', JSON.stringify(s.scrolledOffAbove))
  }

  // side='below': dragging upward, the anchor is the END — col resets to
  // W-1 (:901-910); newest rows land at the FRONT (:897-900).
  {
    const s = createSelectionState()
    startSelection(s, 7, 4)
    updateSelection(s, 2, 1)
    captureScrolledRows(s, screen, 4, 5, 'below')
    check('capture below: anchor-side row clipped at the anchor col', s.scrolledOffBelow[0] === 'row4 abc', JSON.stringify(s.scrolledOffBelow))
    check('capture below: anchor col reset to width-1', s.anchor?.col === W - 1, JSON.stringify(s.anchor))
    captureScrolledRows(s, screen, 3, 3, 'below')
    check('capture below: newer rows unshift to the FRONT', s.scrolledOffBelow[0] === 'row3 abcdefghij' && s.scrolledOffBelow[1] === 'row4 abc', JSON.stringify(s.scrolledOffBelow))
  }

  // Clip band binds captured rows (:866-874).
  {
    const s = createSelectionState()
    startSelection(s, 5, 1)
    setSelectionClipBand(s, 6, 9, W)
    updateSelection(s, 8, 4)
    captureScrolledRows(s, screen, 1, 2, 'above')
    check(
      'capture: clip band binds accumulator rows',
      s.scrolledOffAbove.length === 2 && s.scrolledOffAbove.every(t => t.length <= 4),
      JSON.stringify(s.scrolledOffAbove),
    )
  }

  // BOTH anchorSpan cols reset (:888-894): after a word-mode capture at the
  // anchor row, a direction flip reads the OPPOSITE span side — it must not
  // retain the original word boundary (the blocked-reversal case :836-840).
  {
    const s = createSelectionState()
    selectWordAt(s, wu.screen, 5, 0) // span 0..22 on the word fixture
    updateSelection(s, 8, 3)
    captureScrolledRows(s, wu.screen, 0, 0, 'above')
    check(
      'capture: BOTH anchorSpan cols reset to the full-width edges',
      s.anchorSpan?.lo.col === 0 && s.anchorSpan.hi.col === WU_W - 1,
      JSON.stringify(s.anchorSpan),
    )
  }

  // No selection / disjoint range: no-ops.
  {
    const s = createSelectionState()
    captureScrolledRows(s, screen, 0, 2, 'above')
    check('capture: no selection is a no-op', s.scrolledOffAbove.length === 0)
    startSelection(s, 1, 4)
    updateSelection(s, 5, 5)
    captureScrolledRows(s, screen, 0, 2, 'above')
    check('capture: disjoint range is a no-op', s.scrolledOffAbove.length === 0)
  }
}

// ════════════════════════════════════════════════════════════════════════════
// LAW DEBT-ROUND-TRIP — the differential ledger model over scripted journeys
// (selection.ts:481-576 shiftSelection · :584-613 shiftAnchor ·
//  :636-685 shiftSelectionForFollow · :845-912 capture)
// ════════════════════════════════════════════════════════════════════════════
{
  const W = 16
  const H = 6
  const DOC: string[] = []
  for (let i = 0; i < 20; i++) DOC.push(`L${String(i).padStart(2, '0')} w${i % 10}x`)

  const docLine = (r: number): string => (r >= 0 && r < DOC.length ? DOC[r]! : '')
  const extractDoc = (r: number, c0: number, c1: number): string =>
    docLine(r).padEnd(c1 + 1).slice(0, c1 + 1).slice(c0).replace(/\s+$/, '')

  function paintDoc(t: number): Screen {
    const { screen, styles } = mkScreen(W, H)
    for (let y = 0; y < H; y++) putText(screen, styles, 0, y, docLine(t + y))
    return screen
  }

  type MPoint = { doc: number; col: number }
  type Model = {
    anchor: MPoint | null
    focus: MPoint | null
    above: string[]
    below: string[]
    cleared: boolean
    clipLo?: number
    clipHi?: number
  }
  const clampN = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
  const screenRowOf = (p: MPoint, t: number): number => clampN(p.doc - t, 0, H - 1)

  function modelBounds(m: Model, t: number): { start: { row: number; col: number }; end: { row: number; col: number }; anchorIsStart: boolean } {
    const a = { row: screenRowOf(m.anchor!, t), col: m.anchor!.col }
    const f = { row: screenRowOf(m.focus!, t), col: m.focus!.col }
    const aFirst = a.row < f.row || (a.row === f.row && a.col <= f.col)
    return aFirst ? { start: a, end: f, anchorIsStart: true } : { start: f, end: a, anchorIsStart: false }
  }

  function modelExpectedText(m: Model, t: number): string {
    if (m.cleared || !m.anchor || !m.focus) return ''
    const { start, end } = modelBounds(m, t)
    const lo = m.clipLo ?? 0
    const hi = m.clipHi ?? W - 1
    const lines: string[] = [...m.above]
    for (let r = start.row; r <= end.row; r++) {
      const c0 = Math.max(r === start.row ? start.col : 0, lo)
      const c1 = Math.min(r === end.row ? end.col : W - 1, hi)
      if (c1 < c0) continue
      lines.push(extractDoc(t + r, c0, c1))
    }
    lines.push(...m.below)
    return lines.join('\n')
  }

  function modelCapture(m: Model, t: number, first: number, last: number, side: 'above' | 'below'): void {
    if (m.cleared || !m.anchor || !m.focus) return
    const { start, end } = modelBounds(m, t)
    const lo = Math.max(first, start.row)
    const hi = Math.min(last, end.row)
    if (lo > hi) return
    const bandLo = m.clipLo ?? 0
    const bandHi = m.clipHi ?? W - 1
    const block: string[] = []
    for (let r = lo; r <= hi; r++) {
      const c0 = Math.max(r === start.row ? start.col : 0, bandLo)
      const c1 = Math.min(r === end.row ? end.col : W - 1, bandHi)
      block.push(c1 >= c0 ? extractDoc(t + r, c0, c1) : '')
    }
    if (side === 'above') {
      m.above.push(...block)
      if (screenRowOf(m.anchor, t) === start.row && lo === start.row) m.anchor.col = 0
    } else {
      m.below.unshift(...block)
      if (screenRowOf(m.anchor, t) === end.row && hi === end.row) m.anchor.col = W - 1
    }
  }

  function modelShiftSelection(m: Model, tOld: number, tNew: number): void {
    if (m.cleared || !m.anchor || !m.focus) return
    const aRow = m.anchor.doc - tNew
    const fRow = m.focus.doc - tNew
    if ((aRow < 0 && fRow < 0) || (aRow > H - 1 && fRow > H - 1)) {
      m.cleared = true
      m.anchor = null
      m.focus = null
      m.above = []
      m.below = []
      return
    }
    if (aRow < 0) m.anchor.col = 0
    else if (aRow > H - 1) m.anchor.col = W - 1
    if (fRow < 0) m.focus.col = 0
    else if (fRow > H - 1) m.focus.col = W - 1
    // CHARACTERIZED (selection.ts:516-547): the debt-shrink POP removes the
    // newest entries (END for above, FRONT for below — the rows returning
    // on-screen), while the invariant-restore TRUNCATE keeps the newest
    // (END for above, FRONT for below). The two branches drop from OPPOSITE
    // ends of the above-accumulator; both are correct for their case.
    const minDoc = Math.min(m.anchor.doc, m.focus.doc)
    const maxDoc = Math.max(m.anchor.doc, m.focus.doc)
    const oldAbove = Math.max(0, tOld - minDoc)
    const oldBelow = Math.max(0, maxDoc - (tOld + H - 1))
    const newAbove = Math.max(0, tNew - minDoc)
    const newBelow = Math.max(0, maxDoc - (tNew + H - 1))
    if (newAbove < oldAbove) m.above.length = Math.max(0, m.above.length - (oldAbove - newAbove))
    if (newBelow < oldBelow) m.below.splice(0, oldBelow - newBelow)
    if (m.above.length > newAbove) m.above = newAbove > 0 ? m.above.slice(-newAbove) : []
    if (m.below.length > newBelow) m.below = m.below.slice(0, newBelow)
  }

  function modelFollow(m: Model, tNew: number): boolean {
    if (m.cleared || !m.anchor) return false
    const aRow = m.anchor.doc - tNew
    const fRow = m.focus ? m.focus.doc - tNew : undefined
    if (aRow < 0 && fRow !== undefined && fRow < 0) {
      m.cleared = true
      m.anchor = null
      m.focus = null
      m.above = []
      m.below = []
      return true
    }
    return false
  }

  type Env = { sel: SelectionState; m: Model; t: number; screen: Screen }
  function mkEnv(t: number): Env {
    return { sel: createSelectionState(), m: { anchor: null, focus: null, above: [], below: [], cleared: false }, t, screen: paintDoc(t) }
  }
  function dragTo(env: Env, c0: number, r0: number, c1: number, r1: number): void {
    startSelection(env.sel, c0, r0)
    updateSelection(env.sel, c1, r1)
    env.m.anchor = { doc: env.t + r0, col: c0 }
    env.m.focus = { doc: env.t + r1, col: c1 }
    env.m.cleared = false
  }
  function stepPgDn(env: Env, k: number): void {
    captureScrolledRows(env.sel, env.screen, 0, k - 1, 'above')
    modelCapture(env.m, env.t, 0, k - 1, 'above')
    shiftSelection(env.sel, -k, 0, H - 1, W)
    const tOld = env.t
    env.t += k
    modelShiftSelection(env.m, tOld, env.t)
    env.screen = paintDoc(env.t)
  }
  function stepPgUp(env: Env, k: number): void {
    captureScrolledRows(env.sel, env.screen, H - k, H - 1, 'below')
    modelCapture(env.m, env.t, H - k, H - 1, 'below')
    shiftSelection(env.sel, k, 0, H - 1, W)
    const tOld = env.t
    env.t -= k
    modelShiftSelection(env.m, tOld, env.t)
    env.screen = paintDoc(env.t)
  }
  function stepDragTickDown(env: Env, mouseRow: number): void {
    captureScrolledRows(env.sel, env.screen, 0, 0, 'above')
    modelCapture(env.m, env.t, 0, 0, 'above')
    shiftAnchor(env.sel, -1, 0, H - 1)
    env.t += 1
    if (env.m.focus) env.m.focus.doc = env.t + mouseRow // focus is screen-pinned during drag
    env.screen = paintDoc(env.t)
  }
  function stepFollow(env: Env, delta: number): boolean {
    captureScrolledRows(env.sel, env.screen, 0, delta - 1, 'above')
    modelCapture(env.m, env.t, 0, delta - 1, 'above')
    const cleared = shiftSelectionForFollow(env.sel, -delta, 0, H - 1)
    env.t += delta
    const mCleared = modelFollow(env.m, env.t)
    env.screen = paintDoc(env.t)
    check('ledger: follow clear verdicts agree', cleared === mCleared, `impl=${cleared} model=${mCleared}`)
    return cleared
  }
  function assertLedger(env: Env, tag: string): void {
    const got = getSelectedText(env.sel, env.screen)
    const want = modelExpectedText(env.m, env.t)
    check(`ledger ${tag}: copy text ≡ model`, got === want, JSON.stringify({ got, want }))
    check(
      `ledger ${tag}: accumulator lengths ≡ ledger debts`,
      env.sel.scrolledOffAbove.length === env.m.above.length && env.sel.scrolledOffBelow.length === env.m.below.length,
      JSON.stringify({ above: [env.sel.scrolledOffAbove.length, env.m.above.length], below: [env.sel.scrolledOffBelow.length, env.m.below.length] }),
    )
    check(`ledger ${tag}: presence agrees`, hasSelection(env.sel) === !env.m.cleared && (env.m.cleared || env.m.anchor !== null))
    if (!env.m.cleared && env.m.anchor && env.m.focus && env.sel.anchor && env.sel.focus) {
      check(
        `ledger ${tag}: endpoint rows+cols ≡ model`,
        env.sel.anchor.row === screenRowOf(env.m.anchor, env.t) &&
          env.sel.anchor.col === env.m.anchor.col &&
          env.sel.focus.row === screenRowOf(env.m.focus, env.t) &&
          env.sel.focus.col === env.m.focus.col,
        JSON.stringify({ sel: { a: env.sel.anchor, f: env.sel.focus }, m: env.m, t: env.t }),
      )
      const aOut = env.m.anchor.doc - env.t < 0 || env.m.anchor.doc - env.t > H - 1
      check(
        `ledger ${tag}: virtual rows track true positions`,
        (env.sel.virtualAnchorRow !== undefined) === aOut &&
          (!aOut || env.sel.virtualAnchorRow === env.m.anchor.doc - env.t),
        JSON.stringify({ v: env.sel.virtualAnchorRow, doc: env.m.anchor.doc, t: env.t }),
      )
    }
  }

  // J1 — keyboard round trip with anchor-edge consumption.
  {
    const env = mkEnv(0)
    dragTo(env, 5, 2, 8, 4)
    finishSelection(env.sel)
    assertLedger(env, 'J1 s0')
    stepPgDn(env, 3)
    assertLedger(env, 'J1 pgdn3')
    check('J1: anchor clamped with virtual debt', env.sel.anchor?.row === 0 && env.sel.virtualAnchorRow === -1)
    stepPgUp(env, 3)
    assertLedger(env, 'J1 pgup3 (round trip)')
    check('J1: accumulators empty after the full return', env.sel.scrolledOffAbove.length === 0 && env.sel.scrolledOffBelow.length === 0)
    // CHARACTERIZED QUIRK (selection.ts:469-472, :551-555): the anchor's col
    // constraint was CONSUMED by the boundary capture — after the round trip
    // the copy grows to the full-width edge at the anchor row. Highlight and
    // copy still agree (both read col 0); only the original col is absent.
    check('J1 quirk: anchor col stays edge-consumed after the round trip', env.sel.anchor?.col === 0, JSON.stringify(env.sel.anchor))
    stepPgDn(env, 4)
    assertLedger(env, 'J1 pgdn4')
    check('J1: two rows of above debt', env.sel.scrolledOffAbove.length === 2, JSON.stringify(env.sel.scrolledOffAbove))
    stepPgUp(env, 1)
    assertLedger(env, 'J1 partial pop (pgup1)')
    check('J1: partial pop dropped exactly one entry', env.sel.scrolledOffAbove.length === 1, JSON.stringify(env.sel.scrolledOffAbove))
    stepPgUp(env, 3)
    assertLedger(env, 'J1 full return')
    stepPgDn(env, 8)
    check('J1: both ends past the top clears (down direction)', hasSelection(env.sel) === false && env.m.cleared, JSON.stringify(env.sel))
    check('J1: clear empties accumulators', env.sel.scrolledOffAbove.length === 0)
  }

  // J1b — upward drag, below-side accumulator order + pops.
  {
    const env = mkEnv(4)
    dragTo(env, 7, 4, 2, 1) // anchor is the END (drag upward)
    finishSelection(env.sel)
    stepPgUp(env, 2)
    assertLedger(env, 'J1b pgup2')
    check('J1b: focus row intact, anchor clamped below', env.sel.anchor?.row === H - 1 && env.sel.virtualAnchorRow === 6, JSON.stringify(env.sel.anchor))
    stepPgUp(env, 2)
    assertLedger(env, 'J1b pgup4')
    stepPgDn(env, 4)
    assertLedger(env, 'J1b round trip')
    check('J1b: below accumulator drained', env.sel.scrolledOffBelow.length === 0)
    stepPgUp(env, 4)
    assertLedger(env, 'J1b re-scroll')
    // Both ends past the bottom clears (up direction).
    const env2 = mkEnv(5)
    dragTo(env2, 1, 1, 5, 2)
    finishSelection(env2.sel)
    stepPgUp(env2, 5)
    check('J1b: both ends past the bottom clears (up direction)', hasSelection(env2.sel) === false && env2.m.cleared, JSON.stringify(env2.sel))
  }

  // J2 — the drag→follow handoff: drag-to-scroll seeds virtual rows so the
  // follow phase and the final keyboard return compute debt from TRUE rows
  // (selection.ts:591-597).
  {
    const env = mkEnv(0)
    dragTo(env, 2, 1, 4, 5)
    stepDragTickDown(env, 5)
    assertLedger(env, 'J2 tick1')
    stepDragTickDown(env, 5)
    assertLedger(env, 'J2 tick2')
    check('J2: drag tick seeded the virtual anchor row', env.sel.virtualAnchorRow === -1, String(env.sel.virtualAnchorRow))
    stepDragTickDown(env, 5)
    assertLedger(env, 'J2 tick3')
    finishSelection(env.sel)
    stepFollow(env, 2)
    assertLedger(env, 'J2 follow2')
    stepPgUp(env, 5)
    assertLedger(env, 'J2 keyboard return')
    check('J2: above accumulator fully popped on return', env.sel.scrolledOffAbove.length === 0, String(env.sel.scrolledOffAbove.length))
  }

  // J3/J4 — follow-scroll clears: both-above-top clears and returns true;
  // landing AT the top edge survives (selection.ts:655-658).
  {
    const env = mkEnv(0)
    dragTo(env, 1, 0, 5, 1)
    finishSelection(env.sel)
    const cleared = stepFollow(env, 3)
    check('J4: follow with both ends above the top clears and reports', cleared === true && hasSelection(env.sel) === false)

    const env2 = mkEnv(0)
    dragTo(env2, 1, 0, 5, 3)
    finishSelection(env2.sel)
    const cleared2 = stepFollow(env2, 3)
    check('J4: landing AT the top edge survives', cleared2 === false && env2.sel.focus?.row === 0, JSON.stringify(env2.sel.focus))
    assertLedger(env2, 'J4 at-edge')
  }

  // J5 — moveFocus voids the focus clamp debt; the NEXT shift's
  // invariant-restore truncates the orphaned accumulator (selection.ts:
  // 528-547). Also the keep-direction: above keeps END, below keeps FRONT.
  {
    const env = mkEnv(3)
    dragTo(env, 2, 1, 7, 4)
    finishSelection(env.sel)
    stepPgUp(env, 2)
    assertLedger(env, 'J5 pgup2')
    check('J5: below debt established', env.sel.scrolledOffBelow.length === 1)
    moveFocus(env.sel, 3, 3)
    env.m.focus = { doc: env.t + 3, col: 3 }
    // Transient: the accumulator still holds the stale row until the next
    // shift runs the invariant-restore (characterized, :528-535).
    check('J5: stale below entry lingers until the next shift', env.sel.scrolledOffBelow.length === 1)
    captureScrolledRows(env.sel, env.screen, H - 1, H - 1, 'below') // production pairs capture+shift; range misses the selection
    modelCapture(env.m, env.t, H - 1, H - 1, 'below')
    shiftSelection(env.sel, 0, 0, H - 1, W)
    modelShiftSelection(env.m, env.t, env.t)
    check('J5: invariant-restore truncated the orphaned below entry', env.sel.scrolledOffBelow.length === 0, JSON.stringify(env.sel.scrolledOffBelow))
    assertLedger(env, 'J5 post-restore')

    // Keep-direction law, above side: a bogus oldest entry is dropped, the
    // newest (closest-to-screen) survive (slice(-newDebt), :536-542).
    const env2 = mkEnv(0)
    dragTo(env2, 2, 1, 7, 4)
    finishSelection(env2.sel)
    stepPgDn(env2, 3) // above debt 2 (rows 1,2 captured)
    check('J5b: two above entries', env2.sel.scrolledOffAbove.length === 2, JSON.stringify(env2.sel.scrolledOffAbove))
    env2.sel.scrolledOffAbove.unshift('BOGUS-STALE')
    env2.sel.scrolledOffAboveSW.unshift(false)
    shiftSelection(env2.sel, 0, 0, H - 1, W)
    check(
      'J5b: truncation keeps the newest above entries (END)',
      env2.sel.scrolledOffAbove.length === 2 && !env2.sel.scrolledOffAbove.includes('BOGUS-STALE'),
      JSON.stringify(env2.sel.scrolledOffAbove),
    )
    assertLedger(env2, 'J5b post-truncate')
  }

  // J6 — clip band rides the whole journey: captures + extraction clipped.
  {
    const env = mkEnv(0)
    startSelection(env.sel, 5, 1)
    setSelectionClipBand(env.sel, 4, 11, W)
    updateSelection(env.sel, 8, 4)
    env.m.anchor = { doc: 1, col: 5 }
    env.m.focus = { doc: 4, col: 8 }
    env.m.clipLo = 4
    env.m.clipHi = 11
    finishSelection(env.sel)
    assertLedger(env, 'J6 s0')
    stepPgDn(env, 3)
    assertLedger(env, 'J6 pgdn3')
    check('J6: captured rows obey the band', env.sel.scrolledOffAbove.every(x => x.length <= 8), JSON.stringify(env.sel.scrolledOffAbove))
    stepPgUp(env, 3)
    assertLedger(env, 'J6 return')
  }

  // shiftAnchor/shiftSelection guards: no anchor / no focus are no-ops.
  {
    const s = createSelectionState()
    shiftSelection(s, -2, 0, H - 1, W)
    shiftAnchor(s, -2, 0, H - 1)
    check('shift guards: empty state no-ops', s.anchor === null && s.focus === null)
    const cleared = shiftSelectionForFollow(s, -2, 0, H - 1)
    check('shift guards: follow with no anchor returns false', cleared === false)
    startSelection(s, 3, 2)
    shiftSelection(s, -2, 0, H - 1, W) // focus null → no-op (:488)
    check('shift guards: shiftSelection without focus no-ops', s.anchor?.row === 2)
    shiftAnchor(s, -2, 0, H - 1) // anchor-only IS shifted (:590)
    check('shift guards: shiftAnchor moves a focus-less anchor', s.anchor?.row === 0, JSON.stringify(s.anchor))
  }
}

// ════════════════════════════════════════════════════════════════════════════
// LAW READ-ONLY+ — every selection op mutates zero screen cells; the overlay
// changes ONLY style bits (extends B6's read-only law to the full surface)
// ════════════════════════════════════════════════════════════════════════════
{
  const snapshot = (screen: Screen): string =>
    JSON.stringify([[...screen.cells], [...screen.noSelect], [...screen.softWrap]])
  const before = snapshot(wu.screen)

  const s = createSelectionState()
  startSelection(s, 2, 0)
  updateSelection(s, 9, 3)
  selectWordAt(s, wu.screen, 5, 0)
  selectLineAt(s, wu.screen, 1)
  extendSelection(s, wu.screen, 8, 3)
  moveFocus(s, 4, 4)
  findPlainTextUrlAt(wu.screen, 8, 3)
  getSelectedText(s, wu.screen)
  captureScrolledRows(s, wu.screen, 0, 1, 'above')
  captureScrolledRows(s, wu.screen, 10, 11, 'below')
  shiftSelection(s, -1, 0, WU_H - 1, WU_W)
  shiftAnchor(s, 1, 0, WU_H - 1)
  shiftSelectionForFollow(s, -1, 0, WU_H - 1)
  hasSelection(s)
  selectionBounds(s)
  setSelectionClipBand(s, 2, 9, WU_W)
  getSelectedText(s, wu.screen)
  check('read-only: the full selection-op battery mutates zero screen bytes', snapshot(wu.screen) === before)

  // Overlay: chars + widths + noSelect + softWrap byte-identical; only
  // styleIds may differ, and only inside the selection.
  const { screen, styles } = mkScreen(10, 3)
  putText(screen, styles, 0, 0, 'abc 漢 def')
  putText(screen, styles, 0, 1, 'second row')
  const charsBefore: string[] = []
  for (let y = 0; y < 3; y++) for (let x = 0; x < 10; x++) charsBefore.push(charInCellAt(screen, x, y) ?? '')
  const nsBefore = JSON.stringify([...screen.noSelect])
  const swBefore = JSON.stringify([...screen.softWrap])
  const s2 = createSelectionState()
  startSelection(s2, 1, 0)
  updateSelection(s2, 6, 1)
  styles.setSelectionBg({ type: 'ansi', code: '\x1b[48;2;9;9;9m', endCode: '\x1b[49m' })
  applySelectionOverlay(screen, s2, styles)
  const charsAfter: string[] = []
  for (let y = 0; y < 3; y++) for (let x = 0; x < 10; x++) charsAfter.push(charInCellAt(screen, x, y) ?? '')
  check('overlay: chars byte-identical', JSON.stringify(charsAfter) === JSON.stringify(charsBefore))
  check('overlay: noSelect/softWrap untouched', JSON.stringify([...screen.noSelect]) === nsBefore && JSON.stringify([...screen.softWrap]) === swBefore)
  // NOTE (an earlier read said "damage NOT tracked"): setCellStyleId DOES track
  // damage (cell-grid.ts:563) — the overlay marks the screen damaged. The
  // T6 full-damage backstop makes this redundant, not absent.
  check('overlay: damage IS tracked through setCellStyleId', screen.damage !== undefined)
}

if (failures > 0) {
  console.log(`\nnative-core geometry contract: RED (${failures}/${checks} checks failed)`)
  process.exit(1)
}
console.log(`\nnative-core geometry contract: green (${checks} checks)`)
