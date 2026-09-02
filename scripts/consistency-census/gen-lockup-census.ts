#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const SRC = join(ROOT, 'src')

interface Site {
  file: string
  line: number
  kind: 'crab' | 'wordmark' | 'session-mark' | 'accent-mercury-text'
  excerpt: string
}

const sites: Site[] = []
const walk = (dir: string): void => {
  for (const name of [...readdirSync(dir)].sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules') continue
      walk(full)
      continue
    }
    if (!name.endsWith('.tsx')) continue
    const rel = relative(ROOT, full)
    const lines = readFileSync(full, 'utf8').split('\n')
    lines.forEach((text, i) => {
      const push = (kind: Site['kind']): void => {
        sites.push({ file: rel, line: i + 1, kind, excerpt: text.trim().slice(0, 160) })
      }
      if (/<Crab\b/.test(text)) push('crab')
      if (/<Wordmark\b/.test(text)) push('wordmark')
      if (/<SessionMark\b/.test(text)) push('session-mark')
      if (/color=\{[A-Z_]+\}[^<]*>\s*Mercury\b/.test(text) || /Mercury<\/Text>/.test(text) && /color=/.test(text)) {
        push('accent-mercury-text')
      }
    })
  }
}
walk(SRC)

const ROLE_BY_FILE: Record<string, { role: string; why: string }> = {
  'src/components/mercury-ui/components.tsx': {
    role: 'product-identity-header',
    why: 'CommandCenter — THE shared crab+wordmark lockup owner',
  },
  'src/components/mercury-ui/assets.tsx': {
    role: 'product-identity-header',
    why: 'the Crab/Wordmark primitives themselves (the ramp lives here)',
  },
  'src/components/MercuryModelPicker.tsx': {
    role: 'product-identity-header',
    why: '/model header — routes through the shared ProductLockup (UN-23)',
  },
  'src/components/MercuryWelcome.tsx': {
    role: 'mission-focal-title',
    why: 'first-run welcome — focal mission surface (big wordmark art)',
  },
  'src/components/MercurySetupFrame.tsx': {
    role: 'mission-focal-title',
    why: 'setup/onboarding frame — focal mission surface',
  },
  'src/components/MercuryHome.tsx': {
    role: 'mission-focal-title',
    why: 'home/boot composition — the splash-adjacent focal surface',
  },
  'src/components/CockpitView.tsx': {
    role: 'product-identity-header',
    why: 'cockpit shell header — shared lockup grammar',
  },
  'src/components/MercuryFrame.tsx': {
    role: 'compact-status-inline',
    why: 'statusbar chrome — intentionally quiet; session mark carries identity',
  },
  'src/components/MercuryExitConfirm.tsx': {
    role: 'compact-status-inline',
    why: 'exit confirm row — quiet inline mention',
  },
  'src/components/MercuryKeybindings.tsx': {
    role: 'product-identity-header',
    why: 'keybindings command-center surface (shared shell)',
  },
  'src/components/LogSelector.tsx': {
    role: 'product-identity-header',
    why: 'sessions manager — CommandCenter consumer',
  },
  'src/components/ContextVisualization.tsx': {
    role: 'session-identity',
    why: 'context view — session mark, not product crab',
  },
  'src/components/mercury-ui/NavigablePanes.tsx': {
    role: 'product-identity-header',
    why: 'pane shell riding the CommandCenter grammar',
  },
  'src/components/tasks/RunDetailPane.tsx': {
    role: 'session-identity',
    why: 'run inspector — the run/session identity mark',
  },
  'src/components/tasks/AgentInspectorPane.tsx': {
    role: 'session-identity',
    why: 'agent inspector — the agent session mark',
  },
  'src/cli/handlers/util.tsx': {
    role: 'compact-status-inline',
    why: 'CLI handler text output — flat by design',
  },
  'src/tools/BriefTool/UI.tsx': {
    role: 'session-identity',
    why: 'brief chat attribution — the session accent labels WHO spoke',
  },
  'src/components/messages/ChatLine.tsx': {
    role: 'session-identity',
    why: 'the transcript nameplate — critter accent IS session identity',
  },
  'src/components/MercuryStatusline.tsx': {
    role: 'product-identity-header',
    why: 'statusline PREVIEW lockup — migrated to the shared Crab primitive in W4 (a preview drawn with different code than the live frame was the imitation class)',
  },
  'src/components/Onboarding.tsx': {
    role: 'compact-status-inline',
    why: 'onboarding prose mention — flat by design',
  },
  'src/components/MercuryTrust.tsx': {
    role: 'compact-status-inline',
    why: 'trust prompt prose — flat by design',
  },
  'src/components/DeckPane.tsx': {
    role: 'compact-status-inline',
    why: 'deck vitals anchor — the live-accent Crab primitive as compact chrome (single-brand law: no product word; migrated from a hand-drawn static-palette copy in W4)',
  },
}

const census = sites.map(s => {
  const entry = ROLE_BY_FILE[s.file]
  return {
    ...s,
    role: entry?.role ?? 'UNCLASSIFIED',
    why: entry?.why ?? 'no classification — the UN-24 ratchet fails on this',
  }
})

const out = {
  generatedBy: 'scripts/consistency-census/gen-lockup-census.ts',
  note: 'GENERATED — regenerate, never hand-edit. The UN-24 ratchet prover fails on UNCLASSIFIED rows.',
  sites: census,
}
const outPath = join(ROOT, 'scripts', 'consistency-census', 'lockup-census.json')
writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n')
const unclassified = census.filter(s => s.role === 'UNCLASSIFIED')
console.log(`lockup census: ${census.length} site(s) across ${new Set(census.map(s => s.file)).size} file(s); ${unclassified.length} unclassified`)
for (const u of unclassified) console.log(`  UNCLASSIFIED ${u.file}:${u.line} (${u.kind}) ${u.excerpt}`)
