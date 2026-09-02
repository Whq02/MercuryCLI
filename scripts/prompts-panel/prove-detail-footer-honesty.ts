#!/usr/bin/env bun
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
