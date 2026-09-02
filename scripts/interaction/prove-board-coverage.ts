#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '../..')
const read = (p: string): string => readFileSync(path.join(ROOT, p), 'utf8')

let fail = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
}

const BOARDS = [
  'src/components/LedgerView.tsx',
  'src/components/RouterBoard.tsx',
  'src/components/extensions/ExtensionsBoard.tsx',
  'src/components/extensions/SourceView.tsx',
  'src/components/tasks/WorkflowsBoard.tsx',
  'src/components/mercury-ui/screens/MonitorView.tsx',
  'src/components/prompts-panel/PromptsPanel.tsx',
].sort()

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

for (const f of BOARDS) {
  const src = read(f)
  const base = path.basename(f)
  t(`${base}: wires a STANDING sideInfo card`, /sideInfo=\{/.test(src))
  t(
    `${base}: names its drill (detailTitle) or replaces the pane (onActivate)`,
    /detailTitle=\{/.test(src) || /onActivate=\{/.test(src),
  )
}

{
  const panes = read('src/components/mercury-ui/NavigablePanes.tsx')
  t(
    'NavigablePanes: rowActions run against the SELECTED row object',
    /a\.run\(selectedRow\)/.test(panes),
  )
}

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
