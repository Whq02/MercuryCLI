#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '1.0.0',
  ISSUES_EXPLAINER: '',
  PACKAGE_URL: '',
  README_URL: '',
  IS_DEV: false,
  MERCURY_DEMO: false,
}

import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveProofHome } from '../lib/proofHome.ts'

const SELF = fileURLToPath(import.meta.url)
const VSHOT = join(dirname(SELF), '..', 'ui', 'vshot.py')
const CONFIG_HOME = resolveProofHome([process.cwd()])
const LONG = 'W'.repeat(200) + 'ENDMARK'

if (process.env.VANGUARD_CARDS_CHILD) {
  const React = await import('react')
  const { render } = (await import('../../src/screen/themedRenderer.js')) as {
    render: (n: React.ReactNode) => Promise<unknown>
  }
  const { Box } = await import('../../src/screen/themedRenderer.js')
  const inspect = await import('../../src/tools/inspect/rows.js')
  const service = await import('../../src/tools/service/rows.js')
  const debug = await import('../../src/tools/debug/rows.js')
  const h = React.createElement
  const opts = { verbose: false }
  const tree = h(
    Box as never,
    { flexDirection: 'column' } as never,
    inspect.renderToolResultMessage(
      {
        ref: 'mercury://run/current',
        state: 'ok',
        result: `run rcpt-fixture (active)\n${LONG}\nline three`,
        kind: 'run',
        title: 'INSPECTCARD',
      },
      [],
      opts,
    ),
    service.renderToolResultMessage(
      {
        op: 'describe',
        name: 'SERVICECARD',
        state: 'running',
        result: `SERVICECARD — running (pid 123)\ncommand: node ${LONG}`,
      } as never,
      [],
      opts,
    ),
    debug.renderToolResultMessage(
      {
        op: 'stack',
        outcome: 'indeterminate',
        result: `DEBUGCARD frame\n#0 main (${LONG}:3)`,
      } as never,
      [],
      opts,
    ),
  )
  void render(tree)
  setTimeout(() => process.exit(0), 1500)
} else {
  let failures = 0
  const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
    if (!cond) failures++
    const shownDetail = cond ? detail : [detail, hint].filter(Boolean).join(' — ')
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shownDetail ? ` — ${shownDetail}` : ''}`)
  }
  if (!existsSync(VSHOT)) {
    console.error(`vshot.py not found at ${VSHOT} — the render-verify harness (scripts/ui/vshot.py) is required.`)
    process.exit(1)
  }
  const EMOJI = /[\u{1F000}-\u{1FAFF}\u{FE0F}]/u

  const capture = (cols: number): string => {
    const cfg = `/tmp/vs-vg-cards-${cols}.json`
    writeFileSync(
      cfg,
      JSON.stringify({
        argv: [process.execPath, 'run', SELF],
        sends: [],
        total: 100,
        cols,
        rows: 30,
        out: `/tmp/vg-cards-${cols}.json`,
      }),
    )
    return execFileSync('/usr/bin/python3', [VSHOT, cfg], {
      encoding: 'utf-8',
      timeout: 30000,
      env: {
        ...process.env,
        MERCURY_CONFIG_DIR: CONFIG_HOME,
        VANGUARD_CARDS_CHILD: '1',
      },
    })
  }

  console.log('============================================================')
  console.log(' vanguard tool cards render-verify (shared grammar)')
  console.log('============================================================')

  for (const cols of [120, 80]) {
    console.log(`\n  ── cards @ ${cols} ──`)
    const grid = capture(cols)
    check(`@${cols}: the Inspect card header renders on the grammar (● + title)`, /●.*INSPECTCARD/.test(grid), '', 'check renderToolResultMessage in src/tools/inspect/rows.tsx and the card glyphs in src/screen/widgets/toolCardGrammar.ts')
    check(`@${cols}: the Service card reads IN-MOTION for running (◐)`, /◐.*SERVICECARD|◐.*describe/.test(grid), '', 'check renderToolResultMessage in src/tools/service/rows.tsx and the running-state glyph in src/screen/widgets/toolCardGrammar.ts')
    check(`@${cols}: the Debug card reads indeterminate (?)`, /\?.*stack|\? *stack/.test(grid), '', 'check renderToolResultMessage in src/tools/debug/rows.tsx and the indeterminate glyph in src/screen/widgets/toolCardGrammar.ts')
    check(`@${cols}: hostile long tokens TRUNCATE inside the width (no ENDMARK)`, !grid.includes('ENDMARK'), '', 'a card line is no longer truncated; check the wrap="truncate-end" lines in renderToolResultMessage of src/tools/inspect/rows.tsx, ServiceTool/UI.tsx and DebugTool/UI.tsx')
    check(`@${cols}: NO emoji in the grid`, !EMOJI.test(grid), '', 'an emoji reaches a card; look in the three tool UI.tsx files above and src/screen/widgets/toolCardGrammar.ts')
  }

  console.log('\n' + '='.repeat(60))
  if (failures === 0) {
    console.log(' ✅ vanguard cards — one grammar, width-true @120 + @80')
    process.exit(0)
  } else {
    console.log(` ❌ vanguard cards — ${failures} check(s) failed`)
    process.exit(1)
  }
}
