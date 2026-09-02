#!/usr/bin/env bun
// prove-interaction-grammar.ts — the ONE-INTERACTION-GRAMMAR contract across
// the flat operator boards (proposal, executed by the trust-cockpit
// program). Mechanical source-level locks (mechanical source-level locks), so a board can't
// silently drift back to a private grammar:
//   1. ↵ is the row's PRIMARY action on every flat list (promote/ratify/expand)
//      — the letter verb stays as a secondary spelling.
//   2. Every board arms action keys behind the mount-TIMESTAMP buffer (the
//      STALE-PAINT discipline) — and NOBODY reintroduces a setTimeout→setState
//      ready-flag on an input path.
//   3. Footers speak one token grammar: `keys verb · keys verb · …`, with ↵
//      listed before its letter twin.
//   4. NavigablePanes composes rowAction hints from when(selectedRow) between
//      the nav tokens and the section/close tokens.

import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '../..')
const read = (p: string): string => readFileSync(path.join(ROOT, p), 'utf8')

let fail = 0
const t = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
}

// The setTimeout→setState ready-flag regression lock: a setTimeout whose body
// sets state consumed by an input gate. Approximation that catches the shipped
// bug shape (setTimeout(...set...Ready/set...Buffered...)) without false
// positives on unrelated timers.
const READY_FLAG_RE = /setTimeout\s*\(\s*\(\)\s*=>\s*set\w*(Ready|Buffer|Armed)/i

// ---- the shared flat-list engine -------------------------------------------
{
  const src = read('src/components/mercury-ui/useFlatList.ts')
  // /3 re-anchor: ↵ decodes through the ONE vocabulary
  // ('activate'); the launch gate is EVENT-IDENTITY (useOpenEventGate — the
  // doctrine-correct successor to the mount-TIMESTAMP comparator, which
  // could swallow a legitimate fast first key); esc/← decode 'cancel'
  // ungated (the close branch precedes the gate check).
  t('useFlatList: ↵ dispatches the primary (activate)', src.includes("action === 'activate'"))
  t(
    'useFlatList: event-identity launch gate (not wall-clock, not a ready flag)',
    src.includes('useOpenEventGate') && !src.includes('Date.now() - mountedAt'),
  )
  t('useFlatList: no setTimeout ready-flag', !READY_FLAG_RE.test(src))
  t(
    "useFlatList: esc/← close ungated (before the gate check)",
    src.indexOf("action === 'cancel'") !== -1 && src.indexOf("action === 'cancel'") < src.indexOf('pastGate()'),
  )
}

// ---- the flat boards ride the engine + speak the ↵-first footer ------------
for (const [file, verb] of [
  ['src/components/CardsView.tsx', 'promote'],
  ['src/components/ScribeCandidatesView.tsx', 'ratify'],
] as const) {
  const src = read(file)
  t(`${path.basename(file)}: rides useFlatList`, src.includes('useFlatList'))
  t(
    `${path.basename(file)}: footer says ↵/p ${verb} (↵ primary, letter secondary)`,
    src.includes(`↵/p ${verb}`),
  )
  t(`${path.basename(file)}: no private useInput left`, !src.includes('useInput('))
  t(`${path.basename(file)}: error ≠ empty (loadError rendered)`, src.includes('loadError'))
}

// ---- /health stays bespoke but must satisfy the same grammar ---------------
{
  const src = read('src/commands/health/HealthCertificate.tsx')
  t('HealthCertificate: ↵ is the primary (expand evidence)', src.includes('key.return'))
  t(
    'HealthCertificate: mount-TIMESTAMP buffer',
    src.includes('mountedAt') && /Date\.now\(\) - mountedAt\.current/.test(src),
  )
  t('HealthCertificate: no setTimeout ready-flag', !READY_FLAG_RE.test(src))
  t(
    'HealthCertificate: footer leads nav then ↵ primary (gated on rows to select)',
    // The nav lead is CONDITIONAL since the product-study r2 fix: a failed
    // certificate has zero checks, so advertising ↑↓/↵ there was the
    // class — the footer drops the nav fragment entirely on empty. The
    // grammar invariant survives inside the gate: nav first (↑↓ then the
    // viewport page verbs), ↵ primary next. The n/N position
    // marker is INFO, not a verb — it rides the TAIL, never the lead.
    /checks\.length > 0 \? '↑↓ select · ⇞⇟ page · ↵ evidence · '/.test(src),
  )
}

// ---- /daemon board rides the ONE open-event-gate seam --------------------------
{
  const src = read('src/components/mercury-ui/parity/DaemonSupervisorView.tsx')
  t('DaemonSupervisorView: useOpenEventGate (the one seam)', src.includes('useOpenEventGate('))
  t('DaemonSupervisorView: no setTimeout ready-flag', !READY_FLAG_RE.test(src))
}

// ---- /authority panel (flips BYPASS + safety toggles) rides the one seam ----
{
  const src = read('src/components/MercuryPermissionsPanel.tsx')
  t('MercuryPermissionsPanel: useOpenEventGate (the one seam)', src.includes('useOpenEventGate('))
  t('MercuryPermissionsPanel: no setTimeout ready-flag', !READY_FLAG_RE.test(src))
  t(
    'MercuryPermissionsPanel: arrows immediate, ↵/space behind the gate',
    src.indexOf('key.downArrow') !== -1 && src.indexOf('key.downArrow') < src.indexOf('pastOpenEvent()') &&
      src.indexOf('key.return') !== -1 && src.indexOf('key.return') < src.indexOf('pastOpenEvent()'),
  )
}

// ---- NavigablePanes: selection-tracked hints in the contract order ---------
{
  const src = read('src/components/mercury-ui/NavigablePanes.tsx')
  t(
    'NavigablePanes: action hints derive from when(selectedRow)',
    src.includes('a.when(selectedRow)') && src.includes('actionHints'),
  )
  const view = src.indexOf("'↵/→ view'")
  const acts = src.indexOf('actionHints,')
  const section = src.indexOf("'tab/1-9 section'")
  const close = src.indexOf("'esc close'")
  t(
    'NavigablePanes: footer order nav → actions → section → close',
    view > 0 && view < acts && acts < section && section < close,
    `view@${view} actions@${acts} section@${section} close@${close}`,
  )
}

process.exit(fail)
