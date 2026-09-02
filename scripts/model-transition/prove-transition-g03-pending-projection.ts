#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/prove-transition-g03-pending-projection.ts —
//  a parked pending switch projects `current → next` through the ONE
//  displayed-session-model owner (resolveDisplayedSessionModel), so every
//  consumer (frame statusline, deck vitals, boot card, monitor) shows the
//  queued transition and clears it on settlement.
//
//  The pure-resolver truth matrix (React-free by the owner's own design):
//    §A no pending → labels byte-identical to the legacy form (no regression)
//    §B pending model → compact carries `current → next`; label adds (queued);
//       pendingNext structured
//    §C pending Default row (setting null) → `→ Default`
//    §D settlement (pending null again) → §A form exactly (the chip clears)
//    §E the hook layer subscribes the ONE pending slot (source law: the
//       repro's absent-consumer sweep inverts — the owner now reads it)
//
//  The rendered 80/120 capture leg rides the transition-preview journey work
//  (pendingModelSwitch is in-memory transient — only a choreographed
//  active-turn pick can arm it in a real PTY; the row stays open for that).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ctm-g03p-config-'))
process.env.MERCURY_HOME = mkdtempSync(join(tmpdir(), 'ctm-g03p-home-'))
process.env.ANTHROPIC_API_KEY = 'fixture-key'

const ROOT = join(import.meta.dir, '..', '..')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { resolveDisplayedSessionModel } = await import(
  '../../src/hooks/useDisplayedSessionModel.ts'
)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

// §A — no pending: the legacy label form exactly.
const plain = resolveDisplayedSessionModel('claude-opus-5')
check('§A no pending: compact is the plain chip', !plain.compact.includes('→'), plain.compact)
check('§A no pending: pendingNext null', plain.pendingNext === null)

// §B — pending model: current → next everywhere.
const pending = resolveDisplayedSessionModel('claude-opus-5', { setting: 'gpt-5.2' })
check(
  '§B pending: compact carries current → next',
  pending.compact.includes('→') && pending.compact.startsWith(plain.compact),
  pending.compact,
)
check('§B pending: label marks (queued)', pending.label.includes('(queued)'), pending.label)
check('§B pending: structured pendingNext', pending.pendingNext !== null, String(pending.pendingNext))

// §C — pending Default row.
const pendingDefault = resolveDisplayedSessionModel('claude-opus-5', { setting: null })
check('§C pending Default: → Default', pendingDefault.compact.endsWith('→ Default'), pendingDefault.compact)

// §D — settlement clears: byte-identical to §A.
const settled = resolveDisplayedSessionModel('claude-opus-5', null)
check(
  '§D settlement clears the projection (byte-identical to no-pending)',
  settled.compact === plain.compact && settled.label === plain.label && settled.pendingNext === null,
)

// §E — the hook subscribes the ONE pending slot (the repro's absent-consumer
// sweep, inverted at the owner).
const hookSrc = readFileSync(join(ROOT, 'src/hooks/useDisplayedSessionModel.ts'), 'utf8')
const connectorSrc = readFileSync(join(ROOT, 'src/services/engine-connector/daemonConnector.ts'), 'utf8')
check(
  "§E the displayed-model owner reads the parked switch through the focused connector (modelFacts().pendingSwitch ← the session's facts feed)",
  hookSrc.includes('modelFacts().pendingSwitch') &&
    connectorSrc.includes('pendingSwitch: this.facts?.pendingModel !== undefined && this.facts.pendingModel !== null ? { setting: this.facts.pendingModel } : null'),
)

console.log(
  failures === 0
    ? '\n ✅ PENDING PROJECTION AT THE ONE DISPLAY OWNER (capture leg rides the preview journey)'
    : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
