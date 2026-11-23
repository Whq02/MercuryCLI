#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { checker } from '../engine-durability/harness.ts'
import {
  getTerminalFocusState,
  getTerminalFocused,
  resetTerminalFocusState,
  setTerminalFocused,
  subscribeTerminalFocus,
} from '../../src/screen/renderer/terminal-session/terminalFocusStore.ts'

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


t.finish('prove-notify-focus')
