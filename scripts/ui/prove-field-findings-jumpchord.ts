#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('§1 ctr-4 — the advertised chord fires')
{
  const { parseKeystroke } = await import('../../src/keybindings/parser.ts')
  const { matchesKeystroke } = await import('../../src/keybindings/match.ts')
  const key = { ctrl: false, meta: true, shift: false, super: false, downArrow: true } as unknown as Parameters<typeof matchesKeystroke>[1]
  check('the wire fact: alt+down arrives as meta+↓ and the matcher folds alt/meta into one', matchesKeystroke('', key, parseKeystroke('alt+down')))
  const bindings = read('src/keybindings/defaultBindings.ts')
  const scroll = bindings.slice(bindings.indexOf("context: 'Scroll'"), bindings.indexOf("context: 'Help'"))
  check("the Scroll context binds alt+down to scroll:bottom (beside the ctrl+end the pill's drill already proved live)", scroll.includes("'alt+down': 'scroll:bottom',") && scroll.includes("'ctrl+end': 'scroll:bottom',"))
  const layout = read('src/components/FullscreenLayout.tsx')
  check('the pill still advertises the chord it now has', layout.includes("'[ back to the bottom · alt+↓ ]'") && layout.includes('· alt+↓ ]`'))
}

process.exit(failures === 0 ? 0 : 1)
