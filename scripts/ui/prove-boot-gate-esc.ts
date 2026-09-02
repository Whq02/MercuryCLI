#!/usr/bin/env bun

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
