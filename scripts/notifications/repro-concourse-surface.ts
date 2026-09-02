#!/usr/bin/env bun
// ============================================================================
//  scripts/notifications/repro-concourse-surface.ts — the expect-red
//  reproducer: the Session Concourse Boot opt-in does not exist — no
//  registered flag, no STARTUP_MENU row.
//
//  The demanded contract: one
//  registered `MERCURY_CONCOURSE` flag plus one STARTUP_MENU enum row with
//  exactly the non-default choices {auto, always} (Off = the leave-unset
//  default per the MenuRow law "options = non-default values only"). The
//  splash-REBAKE + prove-startup-menu laws bite through the existing
//  substrate suite once the row exists; this reproducer pins the two
//  canonical registration points. Exit 3 until lands the row; the
//  runner holds this file to the recorded status.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { checker, scratchRoot } from '../engine-durability/harness.ts'

const t = checker()
scratchRoot('concourse-surface')
const { getFlagSpec } = await import('../../src/substrate/flagRegistry.js')
const { STARTUP_MENU } = await import('../../src/substrate/startupMenu.js')

t.section('§1 — the flag is registered')
{
  const spec = getFlagSpec('MERCURY_CONCOURSE')
  t.check(
    'MERCURY_CONCOURSE is a registered flag',
    spec != null,
    spec ? `tier=${String((spec as { tier?: unknown }).tier)}` : 'absent from FLAG_REGISTRY',
  )
}

t.section('§2 — the Boot Menu carries the Off/Auto/Always row')
{
  const row = STARTUP_MENU.find(r => r.env === 'MERCURY_CONCOURSE')
  t.check('STARTUP_MENU has a MERCURY_CONCOURSE row', row != null, row ? row.kind : 'no row')
  // Shape-agnostic projection (rot repair): MenuRow.options carries
  // the non-default VALUES as plain strings — the original object mapping
  // predates the owner and could never match.
  const options = (row?.options ?? []).map(o => (typeof o === 'string' ? o : (o as { value: string }).value)).sort()
  t.check(
    "the row is an enum over exactly the non-default choices {always, auto}",
    row?.kind === 'enum' && JSON.stringify(options) === JSON.stringify(['always', 'auto']),
    row ? `kind=${row.kind} options=${JSON.stringify(options)}` : 'unreachable while the row is absent',
  )
}

t.finish('repro-concourse-surface')
