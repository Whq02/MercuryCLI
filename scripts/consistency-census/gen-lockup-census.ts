import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { codeOnlyLines } from '../lib/codeText.ts'

const DEFAULT_ROOT = join(import.meta.dir, '..', '..')

interface Site {
  file: string
  kind: 'crab' | 'wordmark' | 'session-mark' | 'accent-mercury-text'
  excerpt: string
}

export const ROLE_BY_FILE: Record<string, { role: string; why: string }> = {
  'src/screen/widgets/components.tsx': {
    role: 'product-identity-header',
    why: 'CommandCenter — THE shared crab+wordmark lockup owner',
  },
  'src/screen/widgets/assets.tsx': {
    role: 'product-identity-header',
    why: 'the Crab/Wordmark primitives themselves (the ramp lives here)',
  },
  'src/commands/model/picker/MercuryModelPicker.tsx': {
    role: 'product-identity-header',
    why: '/model header — routes through the shared ProductLockup (UN-23)',
  },
  'src/boot/first-run/MercurySetupFrame.tsx': {
    role: 'mission-focal-title',
    why: 'setup/onboarding frame — focal mission surface',
  },
  'src/screen/fullscreen-layout/MercuryHome.tsx': {
    role: 'mission-focal-title',
    why: 'home/boot composition — the splash-adjacent focal surface',
  },
  'src/screen/fullscreen-layout/CompactIdentityBand.tsx': {
    role: 'product-identity-header',
    why: "the compact chat's identity band — the cockpit header's small-terminal form: the Wordmark primitive on one line beside the session critter",
  },
  'src/screen/frame-chips/MercuryFrame.tsx': {
    role: 'compact-status-inline',
    why: 'statusbar chrome — intentionally quiet; session mark carries identity',
  },
  'src/commands/exit/MercuryExitConfirm.tsx': {
    role: 'compact-status-inline',
    why: 'exit confirm row — quiet inline mention',
  },
  'src/screen/session-chooser/SessionBrowser.tsx': {
    role: 'product-identity-header',
    why: 'sessions manager — CommandCenter consumer',
  },
  'src/commands/context/ContextVisualization.tsx': {
    role: 'session-identity',
    why: 'context view — session mark, not product crab',
  },
  'src/commands/context/context.tsx': {
    role: 'session-identity',
    why: 'the /context card while the chart is counted — the same context lockup as the view',
  },
  'src/screen/widgets/NavigablePanes.tsx': {
    role: 'product-identity-header',
    why: 'pane shell riding the CommandCenter grammar',
  },
  'src/commands/verbs/setupTokenAndHealth.tsx': {
    role: 'compact-status-inline',
    why: 'CLI handler text output — flat by design',
  },
  'src/screen/messages/ChatLine.tsx': {
    role: 'session-identity',
    why: 'the transcript nameplate — critter accent IS session identity',
  },
  'src/boot/first-run/Onboarding.tsx': {
    role: 'compact-status-inline',
    why: 'onboarding prose mention — flat by design',
  },
  'src/screen/deck-pane/deckPaneView.tsx': {
    role: 'compact-status-inline',
    why: 'deck vitals anchor — the live-accent Crab primitive as compact chrome (single-brand law: no product word; migrated from a hand-drawn static-palette copy in W4)',
  },
}

export function lockupCensus(root = DEFAULT_ROOT): {
  sites: Array<Site & { role: string; why: string }>
} {
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
      const rel = relative(root, full)
      const lines = codeOnlyLines(rel, readFileSync(full, 'utf8'))
      for (const text of lines) {
        const push = (kind: Site['kind']): void => {
          sites.push({ file: rel, kind, excerpt: text.trim().slice(0, 160) })
        }
        if (/<Crab\b/.test(text)) push('crab')
        if (/<Wordmark\b/.test(text)) push('wordmark')
        if (/<SessionMark\b/.test(text)) push('session-mark')
        if (/color=\{[A-Z_]+\}[^<]*>\s*Mercury\b/.test(text) || (/Mercury<\/Text>/.test(text) && /color=/.test(text))) {
          push('accent-mercury-text')
        }
      }
    }
  }
  const srcDir = join(root, 'src')
  if (existsSync(srcDir)) walk(srcDir)
  return {
    sites: sites.map(s => {
      const entry = ROLE_BY_FILE[s.file]
      return {
        ...s,
        role: entry?.role ?? 'UNCLASSIFIED',
        why: entry?.why ?? 'no classification — the UN-24 ratchet fails on this',
      }
    }),
  }
}
