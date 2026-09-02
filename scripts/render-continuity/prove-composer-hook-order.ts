#!/usr/bin/env bun
// ============================================================================
//  prove-composer-hook-order — "after every hook" stays true.
//
//  The composer's overlay branches (palette, file-open, content-search,
//  model picker, thinking toggle, tasks, teams, cap-offer) EARLY-RETURN a
//  JSX subtree. Its section marker declares the law: those returns come
//  after every hook. A hook declared BELOW the marker runs only on the
//  no-overlay render — an inter-render hook-count change, the React #300
//  class that ends the session the moment an overlay opens (the win-triage
//  field crash). One ref (the banded-viewport ref) had landed below the
//  marker; it is hoisted, and this pin keeps the region hook-free.
//
//  §1 the marker exists, exactly once
//  §2 from the marker to the component's closing brace, zero hook calls
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const FILE = join(import.meta.dir, '..', '..', 'src', 'components', 'PromptInput', 'PromptInput.tsx')
const MARKER = 'composer-scoped overlays (after every hook)'
const HOOK = /\buse(State|Ref|Effect|LayoutEffect|InsertionEffect|Memo|Callback|Context|Reducer|SyncExternalStore|DeferredValue|Transition|Id|ImperativeHandle|Keybinding|Input|AppState)\b\s*[(<]/

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const lines = readFileSync(FILE, 'utf8').split('\n')
const markerAt = lines.findIndex(l => l.includes(MARKER))
t('§1 the after-every-hook marker exists', markerAt >= 0)
t('§1 the marker appears exactly once', lines.filter(l => l.includes(MARKER)).length === 1)

if (markerAt >= 0) {
  // The component's own closing brace is the first column-0 `}` after the
  // marker; everything between is the early-return region + the final JSX.
  let end = lines.length
  for (let i = markerAt + 1; i < lines.length; i++) {
    if (/^\}/.test(lines[i] ?? '')) { end = i; break }
  }
  const offenders: string[] = []
  for (let i = markerAt + 1; i < end; i++) {
    const line = lines[i] ?? ''
    if (HOOK.test(line)) offenders.push(`${i + 1}: ${line.trim().slice(0, 90)}`)
  }
  t('§2 no hook call below the marker (the React #300 class)', offenders.length === 0, offenders.join(' · '))
  t('§2 the region is real (the overlay returns live inside it)', end - markerAt > 100, `${end - markerAt} lines`)
}

console.log(failures === 0 ? 'COMPOSER HOOK ORDER: ALL PASS' : 'COMPOSER HOOK ORDER: RED')
process.exit(failures)
