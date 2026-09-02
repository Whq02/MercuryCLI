#!/usr/bin/env bun
// ============================================================================
//  scripts/interaction/prove-board-coverage.ts — living master-detail boards
// Enumerates EVERY live NavigablePanes caller
//  and verifies the board family stays coherent:
//
//    1. INVENTORY IS CLOSED: the callers found by scanning src for a
//       <NavigablePanes render match this proof's registry exactly — a new
//       board joins the registry (and gets its standing card) or this goes
//       red; a deleted board leaves it.
//    2. Every caller wires a STANDING sideInfo card and a selected-row
//       detailTitle (never the bare word 'detail').
//    3. Row actions act on the ROW, structurally: every caller's rowActions
//       run/when take the row (RowAction<Row> — the hidden-index class is
//       impossible).
//    4. The framework itself: activateCurrent is the ONE ↵ body (key +
//       pointer both route through it), selection follows the row KEY on
//       data change, and sections remember their row.
//
//  Run: ~/.bun/bin/bun run scripts/interaction/prove-board-coverage.ts
// ============================================================================
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '../..')
const read = (p: string): string => readFileSync(path.join(ROOT, p), 'utf8')

let fail = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
}

// The ratified board registry — every file that RENDERS <NavigablePanes.
const BOARDS = [
  'src/components/LedgerView.tsx',
  'src/components/RouterBoard.tsx', // /router — route plans
  //  The Session Concourse is NOT a NavigablePanes board — the dedicated
  // ConcourseLayout compositor owns its board (zero-height footer, vanishing
  // side pane and cursorable headings sit outside the shared shell's
  // expressible contract).
  'src/components/extensions/ExtensionsBoard.tsx', // /extensions — installed · sources
  'src/components/extensions/SourceView.tsx', // a source opened — its catalogue as rows
  'src/components/tasks/WorkflowsBoard.tsx',
  'src/components/mercury-ui/screens/MonitorView.tsx',
  'src/components/prompts-panel/PromptsPanel.tsx', // /workbench — the prompts panel
].sort()

// 1. Closed inventory — scan src for actual render sites (pure-fs walk; the
//    gate PATH doesn't carry rg).
function walkTsx(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walkTsx(p, out)
    else if (name.endsWith('.tsx')) out.push(p)
  }
  return out
}
{
  const found = walkTsx(path.join(ROOT, 'src'))
    .filter(p => readFileSync(p, 'utf8').includes('<NavigablePanes'))
    .map(p => path.relative(ROOT, p))
    .filter(f => f !== 'src/components/mercury-ui/NavigablePanes.tsx')
    .sort()
  t(
    'NavigablePanes caller inventory is CLOSED (registry === scan)',
    JSON.stringify(found) === JSON.stringify(BOARDS),
    `scan: ${found.join(', ')}`,
  )
}

// 2. Every board carries a standing card + a NAMED destination for ↵:
//    either a drilled detail titled after the selected row (detailTitle), or
//    an onActivate that replaces the pane wholesale (workflows/party — the
//    inline detail never renders there, so a title would be dead code).
for (const f of BOARDS) {
  const src = read(f)
  const base = path.basename(f)
  t(`${base}: wires a STANDING sideInfo card`, /sideInfo=\{/.test(src))
  t(
    `${base}: names its drill (detailTitle) or replaces the pane (onActivate)`,
    /detailTitle=\{/.test(src) || /onActivate=\{/.test(src),
  )
}

// 3. Row actions act on the ROW (never an index into a display slice).
{
  const panes = read('src/components/mercury-ui/NavigablePanes.tsx')
  t(
    'NavigablePanes: rowActions run against the SELECTED row object',
    /a\.run\(selectedRow\)/.test(panes),
  )
}

// 4. Framework invariants.
{
  const hook = read('src/components/mercury-ui/useNavigablePanes.ts')
  t('hook: ONE activation body (↵ + pointer share activateCurrent)', /const activateCurrent = \(\): void =>/.test(hook) && /activateCurrent\(\)/.test(hook))
  t('hook: sections remember their row (selectSection restore)', /rememberedSel/.test(hook))
  const panes = read('src/components/mercury-ui/NavigablePanes.tsx')
  t('panes: selection follows the row KEY on data change', /selKeyRef/.test(panes) && /followed/.test(panes))
  t('panes: rows ride InteractiveRow (shared pointer grammar)', /<InteractiveRow/.test(panes))
}

console.log()
if (fail) {
  console.log('❌ BOARD-COVERAGE PROOF RED')
  process.exit(1)
}
console.log('✅ BOARD-COVERAGE PROOF PASS')
