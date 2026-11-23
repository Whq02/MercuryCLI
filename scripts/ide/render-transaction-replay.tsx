import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0', IS_DEV: false }
const root = resolve(import.meta.dir, '../..')
if (process.argv[2] === '--child') {
  const sourceRoot = process.argv[3] ?? root
  const { enableConfigs } = await import(join(sourceRoot, 'src/platform/settings/config.js'))
  enableConfigs()
  const React = await import('react')
  const { render, Box, Text } = await import(join(sourceRoot, 'src/screen/themedRenderer.js'))
  const ui = await import(join(sourceRoot, 'src/tools/transaction/rows.tsx'))
  const h = React.createElement
  const opts = { verbose: false }
  const uses = [
    { op: 'begin', intent: 'x' }, { op: 'step', kind: 'apply', outcome: 'failed', id: 'tx-1' },
    { op: 'resume', id: 'tx-1' }, { op: 'list' }, { op: 'finish', verdict: 'completed' },
  ]
  const result = { op: 'step', result: 'Noted [ok] apply on tx-1 (1 step(s)).', outcome: 'succeeded' }
  await render(h(Box, { flexDirection: 'column' },
    h(Text, null, 'TRANSACTION REPLAY'),
    ...uses.map((input, index) => h(Text, { key: index }, ui.renderToolUseMessage(input, opts))),
    ui.renderToolResultMessage(result, [], opts),
    ui.renderToolResultMessage({ op: 'status', result: 'unsaved record [open] auto: 1 change(s) in 1 file(s) — cart.ts\nChanges (newest last):\n  [ok] file.edit: cart.ts\nChecks since the last change:\n  [ok] test: bun test — green\n"completed" can land now: { op: "finish", verdict: "completed" }.', outcome: 'no-change' }, [], opts),
    h(Text, null, 'TRANSACTION REPLAY END')))
  setTimeout(() => process.exit(0), 1200)
} else {
  const scratch = mkdtempSync(join(tmpdir(), 'transaction-frames-'))
  const comparison = process.argv[2]
  let failures = 0
  const check = (label: string, ok: boolean, detail = '') => { if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` - ${detail}` : ''}`) }
  try {
    const { resolveCaptureDriver, captureEngineEntry, vshotBudgetMs } = await import('../lib/captureDriver.js')
    const driver = resolveCaptureDriver()
    if (driver.kind === 'unavailable') throw new Error(`${driver.reason}: ${driver.remedy}`)
    for (const cols of [120, 80]) {
      const capture = (source: string, label: string) => {
        const config = join(scratch, `${label}-${cols}.json`)
        writeFileSync(config, JSON.stringify({ argv: [process.execPath, import.meta.path, '--child', source], sends: [], total: 30, readyText: ['TRANSACTION REPLAY END'],
          cols, rows: 35, out: join(scratch, `${label}-${cols}-grid.json`) }))
        return execFileSync(driver.python, [captureEngineEntry(driver, root), config], { encoding: 'utf8', timeout: vshotBudgetMs(120_000), env: process.env })
      }
      const grid = capture(root, 'tip')
      console.log(grid)
      check(`T13 @${cols} historical inputs and results render`, grid.includes('begin x') && grid.includes('step apply [failed] tx-1') &&
        grid.includes('resume tx-1') && grid.includes('Noted [ok] apply on tx-1 (1 step(s)).') && grid.includes('TRANSACTION REPLAY END'),
        'hint: the grid printed above lacks a historical use or result line; fix renderToolUseMessage and renderToolResultMessage in src/tools/transaction/rows.tsx')
      check(`@${cols} automatic status is visible`, grid.includes('unsaved record [open]') && grid.includes('test: bun test'),
        'hint: the grid printed above lacks the automatic status text; fix renderToolResultMessage for op status in src/tools/transaction/rows.tsx')
      if (comparison) check(`@${cols} frames match the base renderer exactly`, capture(comparison, 'base') === grid,
        'hint: the frame from the base source tree differs from the one printed above; compare src/tools/transaction/rows.tsx between the two trees')
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  console.log(`render-transaction-replay: ${failures ? `${failures} RED` : 'GREEN'}`)
  process.exit(failures ? 1 : 0)
}
