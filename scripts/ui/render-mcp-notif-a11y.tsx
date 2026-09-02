#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/render-mcp-notif-a11y.tsx — RENDER-VERIFY for (opt-in,
//  joins the ui suite only under UI_RENDER=1).
//
//  Mounts the EXACT production structure: each MCP/LSP notification jsx the hooks
//  produce, wrapped in <Text wrap="truncate"> exactly as Notifications.tsx:293.
//  Self-spawns under vshot's PTY at NO_COLOR + a narrow (truncating) width and
//  ASSERTS the LEADING severity glyph (✕ error / ▲ warning) survives BOTH —
//  the a11y claim — and that the trailing "· /mcp" hint is what truncation clips.
//
//  Run:  ~/.bun/bin/bun run scripts/ui/render-mcp-notif-a11y.tsx
// ============================================================================
process.env.NODE_ENV = 'test' // ThemeProvider reads getGlobalConfig at mount
;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '1.0.0',
  ISSUES_EXPLAINER: '',
  PACKAGE_URL: '',
  README_URL: '',
  IS_DEV: false,
  IS_DEMO: false,
}

import { execFileSync } from 'node:child_process'
import { writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveProofHome } from '../lib/proofHome.ts'

const SELF = fileURLToPath(import.meta.url)
const VSHOT = join(dirname(SELF), 'vshot.py') // the in-repo capturer (was the ephemeral /tmp copy)
// The proof's config home (scripts/lib/proofHome.ts): the inherited pin, else
// a fresh seeded scratch — never another program's directory.
const CONFIG_HOME = resolveProofHome([process.cwd()])

// ── child: render the Ink footer, then exit ────────────────────────────────
if (process.env.A11Y_RENDER_CHILD) {
  const React = await import('react')
  const { render, Box, Text } = (await import('../../src/ink.js')) as {
    render: (n: React.ReactNode) => Promise<unknown>
    Box: React.ComponentType<Record<string, unknown>>
    Text: React.ComponentType<Record<string, unknown>>
  }
  const { GLYPH } = (await import('../../src/components/mercury-ui/glyphs.js')) as {
    GLYPH: Record<string, string>
  }
  const h = React.createElement
  // each line === Notifications.tsx:293 `<Text wrap="truncate">{hook.jsx}</Text>`
  const line = (colored: React.ReactNode, tail: string) =>
    h(Text, { wrap: 'truncate' }, h(React.Fragment, null, colored, h(Text, { dimColor: true }, tail)))
  void render(
    h(
      Box,
      { flexDirection: 'column' },
      line(h(Text, { color: 'error' }, `${GLYPH.fail} 2 MCP servers failed`), ' · /mcp'),
      line(h(Text, { color: 'warning' }, `${GLYPH.warn} 3 MCP servers need auth`), ' · /mcp'),
      line(h(Text, { color: 'error' }, `${GLYPH.fail} LSP for tsserver failed`), ' · /health for details'),
    ),
  )
  setTimeout(() => process.exit(0), 1800)
} else {
  // ── parent: drive vshot on self at NO_COLOR wide + narrow, assert ──────────
  let failures = 0
  const check = (label: string, cond: boolean, detail = ''): void => {
    if (!cond) failures++
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
  }
  if (!existsSync(VSHOT)) {
    console.error(`vshot.py not found at ${VSHOT} — the render-verify harness (scripts/ui/vshot.py) is required. Skipping (UI_RENDER harness).`)
    process.exit(1)
  }
  const capture = (cols: number, tag: string): string => {
    const cfg = `/tmp/vs-notif-${tag}.json`
    writeFileSync(
      cfg,
      JSON.stringify({
        argv: [process.execPath, 'run', SELF],
        sends: [],
        total: 15, // 0.2s ticks (~3s ceiling); the child exits at 1.8s → EOF-break early
        cols,
        rows: 6,
        out: `/tmp/notif-${tag}.json`,
      }),
    )
    // vshot.py never reads cfg.env — the a11y condition (NO_COLOR, FORCE_COLOR=0)
    // and the child-branch marker must ride execFileSync's env option.
    return execFileSync('/usr/bin/python3', [VSHOT, cfg], {
      encoding: 'utf-8',
      timeout: 30000,
      env: {
        ...process.env,
    // Split-home guard: bun-side writers and the stamp-defaulted dist must
    // resolve ONE home even outside the gate unit's pin (pinned home).
    MERCURY_CONFIG_DIR: CONFIG_HOME,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        NODE_ENV: 'test',
        A11Y_RENDER_CHILD: '1',
      },
    })
  }

  console.log('============================================================')
  console.log(' HB-0181 render-verify: notif glyphs survive NO_COLOR + truncate')
  console.log('============================================================')

  const wide = capture(60, 'wide')
  console.log(wide.split('\n').filter(l => /MCP|LSP/.test(l)).join('\n'))
  check('NO_COLOR wide: error notif leads with ✕ (color-stripped, still distinguishable)', /✕ 2 MCP servers failed/.test(wide))
  check('NO_COLOR wide: warning notif leads with ▲ (≠ the error ✕)', /▲ 3 MCP servers need auth/.test(wide))
  check('NO_COLOR wide: LSP-failed leads with ✕', /✕ LSP for tsserver failed/.test(wide))

  const narrow = capture(18, 'narrow')
  console.log(narrow.split('\n').filter(l => /✕|▲/.test(l)).join('\n'))
  // truncation clips the TAIL ("· /mcp") — the LEADING glyph survives.
  check('NO_COLOR narrow: the leading ✕ survives truncation', /✕ 2 MCP servers/.test(narrow))
  check('NO_COLOR narrow: the leading ▲ survives truncation', /▲ 3 MCP servers/.test(narrow))
  check('NO_COLOR narrow: the trailing "· /mcp" hint is what gets clipped (truncated, not the glyph)', !/2 MCP servers failed · \/mcp/.test(narrow))

  console.log('\n' + '='.repeat(60))
  if (failures === 0) {
    console.log(' ✅ HB-0181 render-verify — leading severity glyph survives NO_COLOR + truncation')
    process.exit(0)
  } else {
    console.log(` ❌ HB-0181 render-verify — ${failures} check(s) failed`)
    process.exit(1)
  }
}
