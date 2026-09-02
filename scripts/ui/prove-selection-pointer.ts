#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-selection-pointer.ts — ONE selection-pointer spelling
//  The estate's canonical selection pointer is
//  figures.pointer (design-system ListItem paints it for every Select; it
//  degrades to '>' on legacy non-unicode consoles). The census found five
//  surfaces hand-rolling a literal '❯ ' in their focused-row ternaries —
//  the same picture on modern terminals, but NO degradation on legacy
//  conhost (mojibake where every ListItem row degrades cleanly), and a
//  second spelling for the one affordance.
//
//    §1 the five re-pointed sites ride figures.pointer;
//    §2 the RATCHET — no selection ternary in src/components hands a
//       hardcoded '❯' literal anywhere (the prompt-echo role — glyphs.ts
//       `prompt:` and the welcome specimen — is a different affordance and
//       does not match the ternary shape).
//  cpu-pure; no PTY, no boot.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { checker } from '../engine-durability/harness.ts'

const t = checker()

t.section('§1 — the re-pointed nine')
{
  const sites: ReadonlyArray<[string, string]> = [
    ['src/components/MessageSelector.tsx', 'focused ? `${figures.pointer} `'],
    ['src/components/Settings/Config.tsx', 'isSelected ? `${figures.pointer} `'],
    ['src/components/tasks/BackgroundTasksDialog.tsx', 'isSelected ? `${figures.pointer} `'],
    ['src/components/mcp/ElicitationDialog.tsx', 'focused ? `${figures.pointer} `'],
    ['src/components/Spinner/TeammateSpinnerLine.tsx', 'isSelected ? `${figures.pointer} `'],
    ['src/components/MercuryTeammateTree.tsx', 'i===sel?`${figures.pointer} `'],
    ['src/components/MercuryModelPicker.tsx', 'on ? `${figures.pointer} `'],
    ['src/components/MercuryExport.tsx', 'i===sel?`${figures.pointer} `'],
    ['src/components/Spinner/TeammateSpinnerTree.tsx', 'leaderSelected ? `${figures.pointer} `'],
  ]
  for (const [file, needle] of sites) {
    const body = await Bun.file(file).text()
    t.check(`${file.split('/').pop()} rides figures.pointer`, body.includes(needle) && body.includes("import figures from 'figures'"))
  }
}

t.section('§2 — the ratchet: no hardcoded ❯ selection ternary in src/components')
{
  const offenders: string[] = []
  for await (const p of new Bun.Glob('src/components/**/*.tsx').scan('.')) {
    const body = await Bun.file(p).text()
    const lines = body.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (/\?\s*['"`]❯/.test(lines[i]!)) offenders.push(`${p}:${i + 1}`)
    }
  }
  t.check('zero hardcoded ❯ selection ternaries', offenders.length === 0, offenders.join(' | ') || 'none')
}

t.finish('prove-selection-pointer')
