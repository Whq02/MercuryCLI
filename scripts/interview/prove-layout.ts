#!/usr/bin/env bun
// ============================================================================
//  scripts/interview/prove-layout.ts — the B2 layout owner's laws (
//  decision half; the rendered halves ride the width-matrix captures).
//
//    §1  NO NEGATIVE CELL EVER — across the full width×height sweep every
//        emitted dimension is ≥ 1 (the inherited `columns − 34` class dead
//        by construction).
//    §2  MODE MONOTONICITY — growing width never downgrades the mode
//        (side-by-side ⇒ never stacked/minimal at MORE columns, same rows).
//    §3  READABILITY FLOORS — side-by-side only when BOTH panes hold their
//        floors; below them the preview stacks with the full width.
//    §4  DISPLAY-CELL TRUTH — a CJK (wide-glyph) label measures wider than
//        its .length and widens the option pane accordingly.
//    §5  HEIGHT — very short terminals resolve minimal (controls survive);
//        preview line budgets stay ≥ 1.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { checker } from '../engine-durability/harness.ts'
import {
  measureOptionPane,
  resolveInterviewLayout,
} from '../../src/components/permissions/AskUserQuestionPermissionRequest/interviewLayout.ts'
import type { InterviewQuestion } from '../../src/services/interview/contracts.ts'

const t = checker()

const q = (labels: string[], preview = true): InterviewQuestion => ({
  id: 'iq_l',
  decisionId: 'id_l',
  text: 'Which shape?',
  header: 'Shape',
  multiSelect: false,
  options: labels.map((label, i) => ({
    id: `io_${i}`,
    label,
    description: 'd',
    ...(preview ? { preview: '### p\ncontent' } : {}),
  })),
})

const QP = q(['Layered', 'Flat'])
const MODE_RANK = { minimal: 0, stacked: 1, 'side-by-side': 2 } as const

t.section('§1 — no negative cell across the sweep')
{
  let bad = ''
  for (let columns = 1; columns <= 220 && !bad; columns++) {
    for (const rows of [4, 8, 12, 24, 44, 80]) {
      const l = resolveInterviewLayout({ columns, rows, question: QP })
      if (
        l.optionPaneWidth < 1 ||
        l.previewContentWidth < 1 ||
        l.previewMaxLines < 1 ||
        l.notesInputWidth < 1
      ) {
        bad = `${columns}x${rows}: ${JSON.stringify(l)}`
        break
      }
    }
  }
  t.check('every dimension ≥ 1 for all 1..220 × heights', bad === '', bad)
}

t.section('§2 — width growth never downgrades the mode')
{
  let prev = -1
  let bad = ''
  for (let columns = 20; columns <= 220; columns++) {
    const l = resolveInterviewLayout({ columns, rows: 44, question: QP })
    const rank = MODE_RANK[l.mode]
    if (rank < prev) {
      bad = `downgrade at ${columns} cols`
      break
    }
    prev = rank
  }
  t.check('mode rank is monotonic in width (rows=44)', bad === '', bad)
}

t.section('§3 — readability floors decide side-by-side')
{
  const wide = resolveInterviewLayout({ columns: 120, rows: 44, question: QP })
  t.check('120 cols goes side-by-side', wide.mode === 'side-by-side')
  t.check('both panes hold their floors', wide.optionPaneWidth >= 18 && wide.previewContentWidth >= 24)
  const narrow = resolveInterviewLayout({ columns: 44, rows: 44, question: QP })
  t.check('44 cols stacks instead of starving the preview', narrow.mode === 'stacked')
  t.check('the stacked preview takes the full width', narrow.previewContentWidth >= 44 - 4)
  const noPreview = resolveInterviewLayout({ columns: 120, rows: 44, question: q(['A', 'B'], false) })
  t.check('a preview-less question never claims side-by-side', noPreview.mode !== 'side-by-side')
}

t.section('§4 — display cells, not .length')
{
  // Labels long enough to clear the MIN_OPTION_PANE floor: same .length,
  // different display cells.
  const ascii = measureOptionPane(q(['abcdefghijklmnop', 'x'])) // 16 chars = 16 cells
  const cjk = measureOptionPane(q(['配置配置配置配置配置配置配置配置', 'x'])) // 16 wide glyphs = 32 cells
  t.check('a wide-glyph label widens the pane beyond its .length', cjk > ascii, `${cjk} vs ${ascii}`)
}

t.section('§5 — height floors')
{
  const short = resolveInterviewLayout({ columns: 120, rows: 8, question: QP })
  t.check('rows=8 resolves minimal (controls survive)', short.mode === 'minimal')
  const squeezed = resolveInterviewLayout({ columns: 120, rows: 13, question: QP })
  t.check('a squeezed height keeps a ≥1 preview budget', squeezed.previewMaxLines >= 1)
}

t.finish('prove-layout')
