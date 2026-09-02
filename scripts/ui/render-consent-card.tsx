#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/render-consent-card.tsx — render-verify for the Mercury CONSENT
//  CARD (the shared PermissionDialog + PermissionPrompt shell every tool
//  approval flows through; joins the ui suite under UI_RENDER=1).
//
//  A REAL permission prompt only mounts mid-turn on an unapproved tool call —
//  timing-hostile and API-coupled — so this direct-mounts the real components
//  (PermissionDialog → PermissionPrompt → CustomSelect) under AppStateProvider
//  with a seeded toolPermissionContext.mode, at 80 AND 120 cols:
//    · default mode  → accent card, no mode chip
//    · plan mode     → planMode-tinted card + "plan mode" chip
//    · bypass mode   → error-tinted card + "bypass permissions" chip
//  Asserts the card grammar: round card corners, the ⦿ gated glyph, the bold
//  ask, the kit footer hints (↑↓ choose · ↵ confirm · esc cancel), the Mercury
//  (never Hermes/Claude) feedback copy path, and NO emoji.
//
//  Run:  UI_RENDER=1 ~/.bun/bin/bun run scripts/ui/render-consent-card.tsx
// ============================================================================
process.env.NODE_ENV = 'test' // ThemeProvider/getTheme read getGlobalConfig at mount
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
const VSHOT = join(dirname(SELF), 'vshot.py')
// The proof's config home (scripts/lib/proofHome.ts): the inherited pin, else
// a fresh seeded scratch — never another program's directory.
const CONFIG_HOME = resolveProofHome([process.cwd()])

// ── child: mount the real consent stack, then exit ──────────────────────────
if (process.env.CONSENT_RENDER_CHILD) {
  const React = await import('react')
  const { render } = (await import('../../src/ink.js')) as {
    render: (n: React.ReactNode) => Promise<unknown>
  }
  const { Box, Text } = await import('../../src/ink.js')
  const { AppStateProvider } = await import('../../src/state/AppState.js')
  const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
  const { PermissionDialog } = await import(
    '../../src/components/permissions/PermissionDialog.js'
  )
  const { PermissionPrompt } = await import(
    '../../src/components/permissions/PermissionPrompt.js'
  )

  const mode = process.env.CONSENT_MODE || 'default'
  const base = getDefaultAppState()
  const initialState = {
    ...base,
    toolPermissionContext: { ...base.toolPermissionContext, mode },
  }
  const h = React.createElement
  void render(
    h(
      AppStateProvider,
      { initialState: initialState as never },
      h(
        Box,
        { flexDirection: 'column' },
        h(
          PermissionDialog,
          {
            title: 'Bash command',
            subtitle: 'git push origin main',
          },
          h(
            Box,
            { flexDirection: 'column', marginBottom: 1 },
            h(Text, { color: 'text' }, 'git push origin main'),
            h(Text, { color: 'subtle' }, 'Push commits to the remote'),
          ),
          h(PermissionPrompt, {
            options: [
              { value: 'yes', label: 'Yes' },
              {
                value: 'yes-session',
                label: 'Yes, allow git push for this session',
              },
              {
                value: 'no',
                label: 'No, and tell Mercury what to do differently (esc)',
                feedbackConfig: { type: 'reject' as const },
              },
            ],
            onSelect: () => {},
            onCancel: () => {},
          }),
        ),
      ),
    ),
  )
  setTimeout(() => process.exit(0), 1500)
} else {
  // ── parent: drive vshot on self, assert the card grammar ──────────────────
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

  const capture = (cols: number, mode: string): string => {
    const cfg = `/tmp/vs-consent-${mode}-${cols}.json`
    writeFileSync(
      cfg,
      JSON.stringify({
        argv: [process.execPath, 'run', SELF],
        sends: [],
        total: 15, // 0.2s ticks (~3s ceiling); child exits at 1.5s → EOF-break
        cols,
        rows: 16,
        out: `/tmp/consent-${mode}-${cols}.json`,
      }),
    )
    return execFileSync('/usr/bin/python3', [VSHOT, cfg], {
      encoding: 'utf-8',
      timeout: 30000,
      env: {
        ...process.env,
    // Split-home guard: bun-side writers and the stamp-defaulted dist must
    // resolve ONE home even outside the gate unit's pin (pinned home).
    MERCURY_CONFIG_DIR: CONFIG_HOME,
        CONSENT_RENDER_CHILD: '1',
        CONSENT_MODE: mode,
      },
    })
  }

  console.log('============================================================')
  console.log(' Mercury consent card render-verify (PermissionDialog shell)')
  console.log('============================================================')

  for (const cols of [120, 80]) {
    console.log(`\n  ── default mode @ ${cols} ──`)
    const grid = capture(cols, 'default')
    check(`@${cols}: round card top corner (╭)`, /╭/.test(grid))
    check(`@${cols}: round card bottom corner (╰)`, /╰/.test(grid))
    check(`@${cols}: gated glyph ⦿ leads the title`, /⦿/.test(grid))
    check(`@${cols}: title present`, /Bash command/.test(grid))
    check(`@${cols}: the ask`, /Do you want to proceed\?/.test(grid))
    check(
      `@${cols}: kit footer hints (↑↓ choose · ↵ confirm · esc cancel)`,
      /↑↓ choose/.test(grid) && /esc cancel/.test(grid),
    )
    check(`@${cols}: Mercury copy (never Hermes/Claude)`, /Mercury/.test(grid) && !/Hermes|Claude/.test(grid))
    check(`@${cols}: no mode chip in default mode`, !/plan mode|bypass permissions|accept edits/i.test(grid))
    check(`@${cols}: NO emoji`, !EMOJI.test(grid))
    check(
      `@${cols}: Select pointer ❯ on the focused row (kitty CSI-u strip holds)`,
      /❯ 1\./.test(grid),
    )
    if (cols === 120) {
      const first = grid.split('\n').find(l => l.includes('⦿')) ?? ''
      console.log(`  header @120: ${first.trim().slice(0, 100)}`)
    }
  }

  console.log(`\n  ── plan mode @ 120 ──`)
  const plan = capture(120, 'plan')
  check('plan: mode chip renders ("plan mode")', /plan mode/i.test(plan))
  check('plan: card still carries the ask + options', /Do you want to proceed\?/.test(plan))

  console.log(`\n  ── bypass mode @ 120 ──`)
  const bypass = capture(120, 'sovereign')
  check('bypass: mode chip renders ("bypass permissions")', /bypass permissions/i.test(bypass))

  console.log(`\n${failures === 0 ? 'GREEN' : `RED — ${failures} failure(s)`}: consent-card render-verify`)
  process.exit(failures === 0 ? 0 : 1)
}
