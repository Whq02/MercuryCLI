#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { checker } from '../engine-durability/harness.ts'

const t = checker()
const { keyHintLabel, MAC_MODIFIER_GLYPHS } = await import('../../src/components/mercury-ui/keyHintLabel.js')
const manifest = await import('../../src/components/concourse/controlManifest.js')

type Platform = 'macos' | 'windows' | 'wsl' | 'linux' | 'unknown'
const OFF_MAC: Platform[] = ['windows', 'wsl', 'linux', 'unknown']

const AUTHORED: ReadonlyArray<string> = [
  '⌃r retry',
  '⌃g ground',
  '⌃s coordinator model',
  '⌃a',
  '⇧↵/⌃j',
  '⇧tab chat mode',
  '⇧tab manager',
  '⇧← back',
  '⇧→ concourse',
  '⌥←→ flip · /sessions',
  'Empty prompt: ⌥←→ flips sessions.',
  '↵ send · ⇧↵ newline · tab panes',
  '(⌃g trusts it)',
  'manager mode needs a coordinator model — ⌃s (or the rail’s coordinator chip) picks one',
]

t.section('§1 — macOS identity (the liked look never moves)')
{
  for (const s of AUTHORED) {
    t.check(`identity: ${JSON.stringify(s.slice(0, 34))}`, keyHintLabel(s, 'macos') === s)
  }
}

t.section('§2 — the off-mac words (the registry vocabulary, one spelling per host family)')
{
  const expect: ReadonlyArray<[string, string]> = [
    ['⌃r retry', 'ctrl+r retry'],
    ['⌃g ground', 'ctrl+g ground'],
    ['⌃a', 'ctrl+a'],
    ['⇧↵/⌃j', 'shift+↵/ctrl+j'],
    ['⇧tab chat mode', 'shift+tab chat mode'],
    ['⇧← back', 'shift+← back'],
    ['⌥←→ flip · /sessions', 'alt+←→ flip · /sessions'],
    ['↵ send · ⇧↵ newline · tab panes', '↵ send · shift+↵ newline · tab panes'],
    ['(⌃g trusts it)', '(ctrl+g trusts it)'],
  ]
  for (const [authored, windows] of expect) {
    t.check(`windows: ${JSON.stringify(authored.slice(0, 28))} → ${JSON.stringify(windows.slice(0, 30))}`, keyHintLabel(authored, 'windows') === windows, keyHintLabel(authored, 'windows'))
  }
  t.check('the three off-mac families spell identically (one off-mac dialect)',
    AUTHORED.every(s => keyHintLabel(s, 'windows') === keyHintLabel(s, 'linux') && keyHintLabel(s, 'linux') === keyHintLabel(s, 'wsl')))
}

t.section('§3 — totality over the LIVE manifest rows + the vocabulary')
{
  const rows: string[] = [
    ...manifest.COORDINATOR_SURFACE_KEYS.map(k => k.keys),
    manifest.CONCOURSE_HELP_KEY.keys,
    ...(['rail', 'list', 'coordinator', 'live', 'chat'] as const).flatMap(r =>
      manifest.regionKeysFor(r, { newSession: true }).map(k => k.keys)),
    ...manifest.browseKeysFor({ chatPresent: true }).map(k => k.keys),
    ...manifest.browseKeysFor({ chatPresent: false }).map(k => k.keys),
    ...AUTHORED,
  ]
  t.check('the sweep sees a real population', rows.length >= 25, String(rows.length))
  for (const p of OFF_MAC) {
    const survivors = rows.filter(s => MAC_MODIFIER_GLYPHS.some(g => keyHintLabel(s, p).includes(g)))
    t.check(`${p}: NO Mac modifier glyph survives the fold`, survivors.length === 0, survivors.join(' | ') || 'none')
  }
}

t.section('§4 — host-neutral vocabulary passes untouched everywhere')
{
  const neutral = ['↵', '↵↵', '←', '→', '↑↓', 'tab', 'esc', 'space', '?', '[ ]', 's', 'pgup/pgdn', 'type']
  for (const p of ['macos', ...OFF_MAC] as Platform[]) {
    t.check(`${p}: neutral chips are identity`, neutral.every(s => keyHintLabel(s, p) === s))
  }
}

t.section('§5 — the seams are WIRED product-wide (every painted glyph hint routes through the fold)')
{
  const ALLOW: ReadonlyArray<{ file: string; mark: string }> = [
    { file: 'mercury-ui/glyphs.ts', mark: 'branch:' },
    { file: 'ConcourseLayout.tsx', mark: "keys === '⌃g'" },
    { file: 'managerMode.ts', mark: 'coordinator chip or ⌃s picks one' },
  ]
  const ALLOW_FILES: ReadonlyArray<string> = [
    'src/components/concourse/controlManifest.ts',
    'src/components/mercury-ui/keyHintLabel.ts',
  ]
  const files: string[] = []
  for await (const p of new Bun.Glob('src/**/*.{ts,tsx}').scan('.')) {
    if (!ALLOW_FILES.some(a => p === a)) files.push(p)
  }
  const offenders: string[] = []
  for (const p of files.sort()) {
    const body = await Bun.file(p).text()
    let inBlock = false
    const lines = body.split('\n')
    for (let i = 0; i < lines.length; i++) {
      let rest = lines[i]!
      let code = ''
      for (;;) {
        if (inBlock) {
          const end = rest.indexOf('*/')
          if (end === -1) break
          rest = rest.slice(end + 2)
          inBlock = false
          continue
        }
        const start = rest.indexOf('/*')
        const lineComment = rest.indexOf('//')
        if (lineComment !== -1 && (start === -1 || lineComment < start)) {
          code += rest.slice(0, lineComment)
          break
        }
        if (start === -1) {
          code += rest
          break
        }
        code += rest.slice(0, start)
        rest = rest.slice(start + 2)
        inBlock = true
      }
      if (!MAC_MODIFIER_GLYPHS.some(g => code.includes(g))) continue
      const window = lines.slice(Math.max(0, i - 2), i + 1).join('\n')
      if (window.includes('keyHintLabel(')) continue
      if (ALLOW.some(a => p.endsWith(a.file) && code.includes(a.mark))) continue
      offenders.push(`${p}:${i + 1}`)
    }
  }
  t.check('every painted glyph hint in src folds (named allow rows only)', offenders.length === 0, offenders.join(' | ') || 'none')
  const mm = await Bun.file('src/services/concourse/managerMode.ts').text()
  t.check(
    "managerMode folds BOTH resolution constructions (the authored const stays pin-stable)",
    (mm.match(/keyHintLabel\(/g) ?? []).length >= 3 && /keyHintLabel\(MANAGER_NEEDS_MODEL_LINE\)/.test(mm),
    'per-call folds present',
  )
  const atlasHost = await Bun.file('src/components/concourse/ConcourseScreen.tsx').text()
  t.check(
    'the atlas key column measures the RENDERED spelling (no fixed 12 clipping ctrl+ words)',
    /displayWidth\(keyHintLabel\(k\.keys\)\)/.test(atlasHost) && /width=\{keyCol\}/.test(atlasHost),
    'measured column',
  )
}

t.finish('prove-key-hint-labels')
