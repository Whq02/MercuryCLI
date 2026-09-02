#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '../..')

type Entry = {
  file: string
  allow?: string[]
  reason?: string
  roles?: boolean
}

const REGISTRY: Entry[] = [
  { file: 'src/components/mercury-ui/InteractiveRow.tsx' },
  { file: 'src/components/mercury-ui/NavigablePanes.tsx' },
  { file: 'src/components/mercury-ui/RailPanel.tsx' },
  { file: 'src/components/MercuryCommandPalette.tsx' },
  { file: 'src/components/tasks/WorkflowsBoard.tsx' },
  { file: 'src/components/LedgerView.tsx' },
  { file: 'src/components/mercury-ui/screens/MonitorView.tsx' },
  { file: 'src/components/diff/DiffDialog.tsx' },
  { file: 'src/components/IdleReturnDialog.tsx' },
  { file: 'src/components/CostThresholdDialog.tsx' },
  { file: 'src/components/diff/DiffFileList.tsx' },
  { file: 'src/components/diff/DiffDetailView.tsx' },
  { file: 'src/components/mercury-ui/toolCardMeta.tsx', roles: true },
  { file: 'src/components/messages/AssistantToolUseMessage.tsx', roles: true },
  { file: 'src/components/messages/CollapsedReadSearchContent.tsx', roles: true },
  { file: 'src/components/mercury-ui/InteractiveDisclosure.tsx', roles: true },
  { file: 'src/components/mercury-ui/components.tsx' },
  { file: 'src/components/MercuryFrame.tsx' },
  { file: 'src/components/MercuryHome.tsx' },
  { file: 'src/components/HelmCenterHeader.tsx' },
  { file: 'src/components/HelmTelemetryRail.tsx' },
  {
    file: 'src/components/HelmLanesRail.tsx',
    allow: ['TERRA'],
    reason: 'V-R-03 §8.7 — the resting ask-row ❯ sigil is brand art (TERRA, the named constant per UI-093); composing rides the live accent',
  },
  { file: 'src/components/FullscreenLayout.tsx' },
  { file: 'src/components/Deck.tsx' },
  { file: 'src/components/DeckPane.tsx' },
  { file: 'src/components/Spinner/StreamingHoldRow.tsx' },
  { file: 'src/components/mercury-ui/WorkCapsule.tsx' },
  { file: 'src/components/MercurySetupFrame.tsx' },
  { file: 'src/components/TerminalProfileCard.tsx' },
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
