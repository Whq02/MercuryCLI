#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { checker } from '../engine-durability/harness.ts'

const t = checker()
const { keyHintLabel, MAC_MODIFIER_GLYPHS } = await import('../../src/screen/widgets/keyHintLabel.js')
const manifest = await import('../../src/screen/concourse/controlManifest.js')

type Platform = 'macos' | 'windows' | 'wsl' | 'linux' | 'unknown'
const OFF_MAC: Platform[] = ['windows', 'wsl', 'linux', 'unknown']

const AUTHORED: ReadonlyArray<string> = [
  '⌃r retry',
  '⌃g ground',
  '⌃a',
  '⇧↵/⌃j',
  '⇧tab previous',
  '⇧← back',
  '⇧→ concourse',
  '⌥←→ flip · /sessions',
  'Empty prompt: ⌥←→ flips sessions.',
  '↵ send · ⇧↵ newline · tab panes',
  '(⌃g trusts it)',
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
    manifest.CONCOURSE_HELP_KEY.keys,
    ...(['rail', 'list', 'live', 'chat'] as const).flatMap(r =>
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


t.finish('prove-key-hint-labels')
