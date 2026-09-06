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
  const { render } = (await import('../../src/ink.js')) as {
    render: (n: React.ReactNode) => Promise<unknown>
  }
  const { Box } = await import('../../src/ink.js')
  const inspect = await import('../../src/tools/InspectTool/UI.js')
  const workshop = await import('../../src/tools/WorkshopTool/UI.js')
  const service = await import('../../src/tools/ServiceTool/UI.js')
  const debug = await import('../../src/tools/DebugTool/UI.js')
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
    workshop.renderToolResultMessage(
      {
        cells: [
          {
            cellId: 'cell-js-g1-1',
            title: 'WORKSHOPCARD',
            language: 'js',
            state: 'succeeded',
            generation: 1,
            runtimeKilled: false,
            durationMs: 42,
            valuePreview: LONG,
            outputTail: [`out ${LONG}`],
            displays: [],
            nestedCalls: 0,
          },
        ],
        result: 'unused',
      } as never,
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
  const check = (label: string, cond: boolean, detail = ''): void => {
    if (!cond) failures++
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
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
        total: 15,
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
    check(`@${cols}: the Inspect card header renders on the grammar (● + title)`, /●.*INSPECTCARD/.test(grid))
    check(`@${cols}: the Workshop cell header renders (● + cell id)`, /●.*cell-js-g1-1/.test(grid))
    check(`@${cols}: the Service card reads IN-MOTION for running (◐)`, /◐.*SERVICECARD|◐.*describe/.test(grid))
    check(`@${cols}: the Debug card reads indeterminate (?)`, /\?.*stack|\? *stack/.test(grid))
    check(`@${cols}: hostile long tokens TRUNCATE inside the width (no ENDMARK)`, !grid.includes('ENDMARK'))
    check(`@${cols}: NO emoji in the grid`, !EMOJI.test(grid))
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
