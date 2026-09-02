#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-adaptive-ink.ts — the ADAPTIVE-INK ratchet (interaction-
//  finish). The surfaces migrated to the Mercury semantic token layer
//  (useMercuryTokens) must never drift back to direct fixed-palette imports:
//  a dark-brand IVORY/FAINT literal in a live adaptive surface makes light /
//  daltonized / ansi families read as leftovers again.
//
//  Contract per registered file:
//    1. it imports NOTHING from mercuryPalette (brand hues are for logo/art —
//       an exception needs an explicit allow entry with a reason);
//    2. it consumes the semantic layer (useMercuryTokens or the
//       MercuryThemeTokens type — subcomponents may take tokens as a prop).
//
//  The registry GROWS as slices migrate surfaces — add the file when you
//  migrate it, never before (a red row here means a regression, not a TODO).
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-adaptive-ink.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '../..')

type Entry = {
  file: string
  /** Named mercuryPalette imports this file is ALLOWED to keep (brand art). */
  allow?: string[]
  /** Why the allowance exists — required when allow is non-empty. */
  reason?: string
  /** Adaptive via THEME-ROLE strings (ThemedText resolves them per family —
   *  the transcript idiom) instead of useMercuryTokens. Still forbids
   *  fixed-palette imports; asserts a role string is actually used. */
  roles?: boolean
}

// The adaptive-surface registry (set + the slice-2 boards; slices
// 4/6 extend it further as they migrate their surfaces).
const REGISTRY: Entry[] = [
  { file: 'src/components/mercury-ui/InteractiveRow.tsx' },
  { file: 'src/components/mercury-ui/NavigablePanes.tsx' },
  { file: 'src/components/mercury-ui/RailPanel.tsx' },
  { file: 'src/components/MercuryCommandPalette.tsx' },
  { file: 'src/components/tasks/WorkflowsBoard.tsx' },
  { file: 'src/components/LedgerView.tsx' },
  { file: 'src/components/mercury-ui/screens/MonitorView.tsx' },
  { file: 'src/components/diff/DiffDialog.tsx' },
  // the two unavoidable chat-flow modals — migrated off the
  // fixed IVORY/FAINT palette (illegible on light families).
  { file: 'src/components/IdleReturnDialog.tsx' },
  { file: 'src/components/CostThresholdDialog.tsx' },
  { file: 'src/components/diff/DiffFileList.tsx' },
  { file: 'src/components/diff/DiffDetailView.tsx' },
  { file: 'src/components/mercury-ui/toolCardMeta.tsx', roles: true },
  { file: 'src/components/messages/AssistantToolUseMessage.tsx', roles: true },
  { file: 'src/components/messages/CollapsedReadSearchContent.tsx', roles: true },
  { file: 'src/components/mercury-ui/InteractiveDisclosure.tsx', roles: true },
  // the PRIMITIVE KIT itself — CommandCenter + ~23 primitives all
  // resolve through useMercuryTokens (85 consumer surfaces inherit); the
  // adaptive state spine lives in theme.ts stateStyleOf/gaugeColorOf.
  { file: 'src/components/mercury-ui/components.tsx' },
  // the cockpit-home chrome owners — the frame captures' family
  // truth (statusbar · home furniture · center header · telemetry rail ·
  // deck · fullscreen chrome).
  { file: 'src/components/MercuryFrame.tsx' },
  { file: 'src/components/MercuryHome.tsx' },
  { file: 'src/components/HelmCenterHeader.tsx' },
  { file: 'src/components/HelmTelemetryRail.tsx' },
  // the LAST cockpit chrome holdout — 97 sites migrated
  // off raw dark-family ink; zero palette imports remain (the viewed-agent
  // mark rides the session accent, the status spine rides
  // success/warning/failure roles).
  // V-R-03 (§8.7 REPL quality floor, 3-3-3 gate fold): the resting
  // 'ask minerva' ❯ sigil wears the FIXED brand red — Mercury's own
  // composer invitation carries brand identity regardless of the session
  // critter; only composing follows the live session accent. The paint side
  // is independently enforced by the concourse vision matrix
  // (criteriaManifest.ts V-R-03: transcript ❯ = the brand accent family).
  {
    file: 'src/components/HelmLanesRail.tsx',
    allow: ['TERRA'],
    reason: 'V-R-03 §8.7 — the resting ask-row ❯ sigil is brand art (TERRA, the named constant per UI-093); composing rides the live accent',
  },
  { file: 'src/components/FullscreenLayout.tsx' },
  { file: 'src/components/Deck.tsx' },
  { file: 'src/components/DeckPane.tsx' },
  // the high-frequency consumer wave (census §5) — the per-turn
  // strip (streaming hold + work chassis + turn rollup), the onboarding frame
  // (must repaint under the theme preview), the quick-open siblings, the error
  // card, the composer steering hint (hook-free: resolveMercuryTokens), and
  // the system-row/resume-recap transcript surfaces. Status spine rides
  // tokens.success/warning/failure (per-family; dark byte-equal).
  { file: 'src/components/Spinner/StreamingHoldRow.tsx' },
  { file: 'src/components/mercury-ui/WorkCapsule.tsx' },
  { file: 'src/components/MercurySetupFrame.tsx' },
  // the full-profile requirement surface — born adaptive.
  { file: 'src/components/TerminalProfileCard.tsx' },
  // HZ3's /keys atlas — born adaptive (useMercuryTokens ×4, InteractiveRow
  // rows, zero palette imports); registered so it can never drift (review
  // finding 11).
  { file: 'src/components/MercuryInputAtlas.tsx' },
  { file: 'src/components/MercuryFileOpen.tsx' },
  { file: 'src/components/MercuryContentSearch.tsx' },
  { file: 'src/components/MercuryTurnRollup.tsx' },
  { file: 'src/components/FallbackToolUseErrorMessage.tsx' },
  { file: 'src/components/messages/ResumeRecapCard.tsx' },
  { file: 'src/components/messages/SystemTextMessage.tsx' },
]

let fail = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
}

for (const entry of REGISTRY) {
  const src = readFileSync(path.join(ROOT, entry.file), 'utf8')
  const base = path.basename(entry.file)

  // 1. No direct fixed-palette import (outside the explicit allowance).
  const importRe = /import\s*\{([^}]*)\}\s*from\s*'[^']*mercuryPalette\.js'/g
  const imported: string[] = []
  for (const m of src.matchAll(importRe)) {
    for (const name of m[1]!.split(',')) {
      const clean = name.replace(/\btype\b/, '').trim()
      if (clean) imported.push(clean)
    }
  }
  const allowed = new Set(entry.allow ?? [])
  const illegal = imported.filter(n => !allowed.has(n))
  t(
    `${base}: no direct fixed-palette import${allowed.size ? ` (beyond ${[...allowed].join(',')})` : ''}`,
    illegal.length === 0,
    illegal.length ? `imports ${illegal.join(', ')}` : '',
  )
  if (entry.allow?.length) {
    t(`${base}: allowance carries a reason`, !!entry.reason?.trim())
  }

  // 2. Consumes the semantic layer — the token hook OR theme-role strings
  //    (both resolve per family; roles are the transcript idiom).
  if (entry.roles) {
    t(
      `${base}: speaks theme-role strings`,
      /color=["']([a-z][A-Za-z]*)["']|'(text|subtle|inactive|success|userMessageBackgroundHover)'/.test(src),
    )
  } else {
    t(
      `${base}: consumes useMercuryTokens / MercuryThemeTokens`,
      src.includes('useMercuryTokens') || src.includes('MercuryThemeTokens'),
    )
  }
}

console.log()
if (fail) {
  console.log('❌ ADAPTIVE-INK RATCHET RED')
  process.exit(1)
}
console.log('✅ ADAPTIVE-INK RATCHET PASS')
