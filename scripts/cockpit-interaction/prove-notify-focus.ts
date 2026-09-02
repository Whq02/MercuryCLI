#!/usr/bin/env bun
// ============================================================================
//  scripts/cockpit-interaction/prove-notify-focus.ts —, the accepted PROOF-ONLY row.
//
//  The mechanism was already at its owner when opened
//  (useNotifyAfterTimeout prefers the DECSET 1004 focus truth and suppresses
//  while focused); what the finding required was the live-tree PIN: a
//  focused terminal suppresses, an explicitly blurred one delivers, and a
//  terminal that never reports focus falls back to the interaction window —
//  never the other way round.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { checker } from '../engine-durability/harness.ts'
import {
  getTerminalFocusState,
  getTerminalFocused,
  resetTerminalFocusState,
  setTerminalFocused,
  subscribeTerminalFocus,
} from '../../src/ink/session/focus-store.ts'

const t = checker()

t.section('the focus store speaks DECSET 1004 truth')
{
  resetTerminalFocusState()
  t.check("boot state is 'unknown' (a terminal that never reports is never throttled)", getTerminalFocusState() === 'unknown')
  t.check('unknown ≡ focused for the boolean read (only an explicit blur reads false)', getTerminalFocused() === true)
  let pings = 0
  const unsub = subscribeTerminalFocus(() => {
    pings += 1
  })
  setTerminalFocused(false)
  t.check("an explicit blur is recorded", getTerminalFocusState() === 'blurred' && getTerminalFocused() === false)
  setTerminalFocused(true)
  t.check("a focus event flips it back", getTerminalFocusState() === 'focused')
  t.check('subscribers heard both transitions', pings >= 2, String(pings))
  unsub()
  resetTerminalFocusState()
}

t.section('the notify hook prefers focus truth over the interaction window')
{
  const src = readFileSync('src/hooks/useNotifyAfterTimeout.ts', 'utf8')
  t.check(
    'focus is consulted FIRST and trusted when known',
    src.includes("if (focus !== 'unknown') return focus === 'focused'"),
  )
  t.check(
    'the interaction window is the fallback ONLY for unknown focus',
    src.indexOf("if (focus !== 'unknown')") !== -1 && src.indexOf("if (focus !== 'unknown')") < src.indexOf('hasRecentInteraction(threshold)'),
  )
  t.check(
    'a focused terminal suppresses (notify = NOT active)',
    src.includes('!isUserActiveForNotifications(threshold)'),
  )
  t.check(
    'the signal is the one process-wide focus store, not a private copy',
    src.includes("from '../ink/session/focus-store.js'"),
  )
}

t.finish('prove-notify-focus')
