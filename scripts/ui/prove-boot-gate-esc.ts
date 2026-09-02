#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-boot-gate-esc.ts — BFF-03: the boot
//  gates' esc vocabulary tells the truth, and a PROCESS-ENDING esc is never
//  unadvertised or misworded.
//
//  The finder (TASK-017 supplement 3): esc means six different things
//  across the boot gates, and the cards where it ends the process either
//  mis-advertised it or said nothing. At this tip:
//    §1 the two process-ending cards ADVERTISE the quit, wording = truth:
//       · TerminalProfileCard — Select onCancel → finish('exit'); footer
//         says 'esc exits';
//       · TrustDialog — Select onCancel → "exit"; footer says 'Esc exits'
//         (was 'Esc to cancel' — a quit is not a cancel; POISONED).
//    §2 the Onboarding walk's per-step footers keep naming esc's REAL move
//       (theme exits · provider back · guardrails back · terminal skip) —
//       the vocabulary that already told the truth stays frozen.
//  cpu-pure source needles; no PTY, no boot.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { checker } from '../engine-durability/harness.ts'

const t = checker()
const profile = await Bun.file('src/components/TerminalProfileCard.tsx').text()
const trust = await Bun.file('src/components/TrustDialog/TrustDialog.tsx').text()
const walk = await Bun.file('src/components/Onboarding.tsx').text()

t.section('§1 — process-ending esc is advertised, wording = truth')
{
  t.check(
    'TerminalProfileCard: esc quits (onCancel → exit) AND the footer says so',
    /onCancel=\{\(\) => finish\('exit'\)\}/.test(profile) && profile.includes('footer="↑↓ move · ↵ select · esc exits"'),
    'terminal check card',
  )
  t.check(
    'TrustDialog: esc quits (onCancel → "exit") AND the footer says so',
    // Re-trued: the footer speaks the kit's ONE hint grammar now
    // (KeyboardShortcutHint 'exits' on the Esc chord), never the retired
    // capitalized sentence.
    /onCancel=\{\(\) => onChange\("exit"\)\}/.test(trust) &&
      trust.includes('action="exits"') &&
      trust.includes('shortcut="Esc"'),
    'trust gate',
  )
  t.check("POISON: the trust gate's 'Esc to cancel' mislabel is gone", !trust.includes('Esc to cancel'))
}

t.section('§2 — the walk footers keep naming the real move per step')
{
  t.check("theme: 'esc exits'", walk.includes("theme: '↑↓ preview · ↵ keep · esc exits'"))
  t.check("provider: 'esc back'", walk.includes("provider: '↑↓ move · ↵ choose · esc back'"))
  t.check("guardrails: 'esc back'", walk.includes("guardrails: '↵ continue · esc back'"))
  t.check("terminal: 'esc skip'", walk.includes("terminal: '↑↓ move · ↵ select · esc skip'"))
}

t.section('§B9 — the first-run gates: one refusal code, the fit shed, the settle beat')
{
  const trustSrc = trust
  t.check(
    'every trust refusal leaves with ONE code (no zero-exit arm)',
    !trustSrc.includes('gracefulShutdownSync(0)') && trustSrc.split('gracefulShutdownSync(1)').length >= 3,
    'a declined gate must never read as success to the launcher',
  )
  t.check(
    'short frames shed prose, never the decision (the fit shed)',
    trustSrc.includes('const shortFrame = rows < 18') && trustSrc.includes('Trust this folder?'),
  )
  const invalid = await Bun.file('src/components/InvalidSettingsDialog.tsx').text()
  t.check(
    'the stacked settings gate arms input after a settle beat (the digit-then-Enter fall-through)',
    invalid.includes('inputArmed') && invalid.includes('350') && invalid.includes('if (!inputArmed) return'),
  )
}

t.finish('prove-boot-gate-esc')
