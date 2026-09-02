#!/usr/bin/env bun
// ============================================================================
//  scripts/prompts-panel/prove-detail-footer-honesty.ts — the workbench
//  panel's drilled-in footer and its delete-confirm warning stay honest
//  (FC-130 · FC-131).
//
//  FC-131: drilled into a saved prompt, the packed footer line still
//  advertised all eight row verbs — every one dead there — while `a`, the
//  one live key, appeared nowhere: the clickable rail gates actions by nav
//  level, the packed text line did not. The gates now match, and a new
//  detailFooterHints prop lets a caller advertise the verbs it KEEPS armed
//  at detail (PromptsPanel's section-scoped `a new`).
//  FC-130: a tab switch disarmed the delete confirm but not its warning —
//  the panel kept printing `d again confirms` while the d it named deleted
//  nothing. The section-switch effect now clears the note exactly when a
//  confirm was pending (a ref mirror tells a standing warning from an
//  innocent receipt note).
//
//  The panel's PTY drive family is base-red on this box (predecessor's
//  census), so these are call-shaped teeth over the two gates plus the
//  framework's tail composition; the live drive is field-owed.
//
//  Run: ~/.bun/bin/bun run scripts/prompts-panel/prove-detail-footer-honesty.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const ROOT = join(import.meta.dir, '..', '..')
const panes = readFileSync(join(ROOT, 'src', 'components', 'mercury-ui', 'NavigablePanes.tsx'), 'utf-8')
const panel = readFileSync(join(ROOT, 'src', 'components', 'prompts-panel', 'PromptsPanel.tsx'), 'utf-8')

console.log('§1 FC-131 — the packed line gates by level like the rail')
{
  check(
    "row-action hints are gated on nav.level !== 'detail'",
    /const actionHints =\s*\n\s*listNavLive && !composerOwnsInput && nav\.level !== 'detail'/.test(panes),
  )
  check(
    'the list head (↵/→ view) is level-gated too',
    (panes.match(/nav\.level !== 'detail' && liveRowCount > 0/g) ?? []).length === 2,
  )
  check(
    'the detail tail composes select · caller detail hints · back',
    panes.includes("['↑↓ select', resizeActive ? '+/- size' : undefined, detailFooterHints, '←/esc back']"),
  )
  check(
    'detailFooterHints is a declared prop with the armed-law docblock',
    panes.includes('detailFooterHints?: string') && panes.includes('DETAIL-level hotkeys (FC-131)'),
  )
  check(
    "PromptsPanel advertises its one live detail verb (a new), section-scoped",
    panel.includes("detailFooterHints={section === 'saved' ? 'a new' : undefined}"),
  )
}

console.log('\n§2 FC-130 — the warning dies with its arming')
{
  check(
    'the section-switch effect clears the note exactly when a confirm was pending',
    /useEffect\(\(\) => \{\s*\n\s*setConfirmDelete\(null\)\s*\n\s*if \(confirmDeleteLive\.current !== null\) \{\s*\n\s*confirmDeleteLive\.current = null\s*\n\s*setNote\(null\)/.test(panel),
  )
  check(
    'the ref mirrors the live confirm id at render',
    panel.includes('confirmDeleteLive.current = confirmDelete'),
  )
}

console.log(failures === 0 ? '\nprove-detail-footer-honesty: all green' : `\nprove-detail-footer-honesty: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
