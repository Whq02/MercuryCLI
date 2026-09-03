#!/usr/bin/env bun
// ============================================================================
//  scripts/winreg/prove-capture-grammar.ts — vshot-win.py must speak vshot.py's
//  exact scenario grammar.
//
//  The Windows capture plane replays the SAME scenario configs and feeds the
//  SAME semantic oracle as every other platform. That only holds if the two
//  drivers read the same cfg surface and emit the same payload. This prover
//  pins the contract STRUCTURALLY (both sources handle every grammar token) —
//  the behavioral half runs on the windows-ui workflow, where a real ConPTY
//  exists. A macOS-side structural break here means the grammar drifted and
//  the hosted Windows receipts would silently diverge from the POSIX ones.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { checker } from '../engine-durability/harness.ts'

const t = checker()

const posix = readFileSync('scripts/ui/vshot.py', 'utf8')
const win = readFileSync('scripts/winreg/vshot-win.py', 'utf8')

// The cfg keys and send-gating tokens vshot.py reads. Sourced as literals so a
// NEW token added to vshot.py fails here until vshot-win.py learns it too.
const CFG_KEYS = [
  '"cols"', '"rows"', '"total"', '"argv"', '"sends"', '"out"',
  '"readyText"', '"readySettleTicks"', '"stableTicks"', '"resizes"', '"cwd"',
  '"stableRegion"', '"requireStable"',
]
// A resize step's moment: the tick schedule, or the sub-tick/observed forms
// (ms after start · ms after a named mark's send · ms after the previous
// resize). Both drivers read every one.
const RESIZE_KEYS = ['"atTick"', '"atMs"', '"afterMark"', '"afterMs"', '"afterPrevMs"']
const SEND_KEYS = [
  '"atTick"', '"afterPrevTicks"', '"awaitText"', '"awaitRaw"',
  '"minTick"', '"awaitSettleTicks"', '"awaitStableTicks"', '"data"', '"mark"',
  '"requireAwait"', '"awaitStableRegion"', '"targetText"', '"targetDx"',
  // (R7 F9): POSIX signal delivery to the child (SIGTSTP/SIGCONT —
  // the suspend/resume first-key trace). The Windows driver PARSES the
  // token and refuses LOUDLY (exit 6, SIGNAL-UNSUPPORTED): ConPTY has no
  // honest equivalent, and a silently-skipped suspension would pass a fake
  // journey.
  '"signal"',
]
const PAYLOAD_KEYS = [
  '"readyAt"', '"endedAtTick"', '"endReason"', '"readyTextDeclared"',
  '"stages"', '"sendReceipts"', '"marks"',
]

t.section('every vshot.py grammar token is handled by vshot-win.py')
{
  for (const k of [...CFG_KEYS, ...SEND_KEYS, ...RESIZE_KEYS]) {
    t.check(`posix driver reads ${k}`, posix.includes(k), 'grammar source of truth')
    t.check(`windows driver reads ${k}`, win.includes(k), win.includes(k) ? 'ok' : 'MISSING')
  }
  for (const k of PAYLOAD_KEYS) {
    t.check(`windows payload carries ${k}`, win.includes(k), win.includes(k) ? 'ok' : 'MISSING')
  }
}

t.section('the shared capture laws crossed the port')
{
  t.check('wall-clock tick constant (0.2s)', win.includes('TICK_S = 0.2'), 'ticks are seconds/0.2')
  t.check('kitty CSI-u strip', win.includes('_KITTY_SEQ'), 'pyte literalizes kitty sequences otherwise')
  t.check('fork-bomb guard', win.includes('VSHOT_ACTIVE'), 'refuse to nest')
  t.check('NEVER-READY refusal (exit 3)', win.includes('NEVER-READY') && win.includes('sys.exit(3)'), 'wrong-frame class')
  t.check('UNDELIVERED-SENDS refusal (exit 4)', win.includes('UNDELIVERED-SENDS') && win.includes('sys.exit(4)'), 'silently-shorter-journey class')
  t.check('NEVER-STABLE refusal (exit 5)', win.includes('NEVER-STABLE') && win.includes('sys.exit(5)'), 'stale-layout-anchor class')
  t.check('bounded drain epilogue', win.includes('drain_hard_deadline'), 'never end mid-burst')
  t.check(
    'host profiles are driver parameters (WT_SESSION / TERM_PROGRAM=vscode)',
    win.includes('WT_SESSION') && win.includes('vscode'),
    'operator ruling 3 — first-class hosts',
  )
  // Phase-2 honest-lane relabel: the drivers must carry the
  // truthful lane label — the fingerprints simulate the WT environment; the
  // Windows Terminal renderer never runs on this lane. A rewrite that
  // re-claims "Windows Terminal" as this lane's evidence class reds here.
  const campaign = readFileSync('scripts/winreg/campaign-win.py', 'utf8')
  t.check(
    "the lane label is honest: vshot-win names 'ConPTY + simulated WT environment'",
    win.includes('ConPTY + simulated WT environment'),
    'the WT fingerprint is a simulation, never the WT renderer',
  )
  t.check(
    'campaign-win carries the simulated-fingerprint honesty note',
    campaign.includes('simulated WT') && campaign.includes('renderer never runs'),
    'WT-rendering claims belong to the field box',
  )
}

t.section('every Windows driver parses (a syntax error must never cost a 2× billed run)')
{
  // Review finding: nothing syntax-checked the .py drivers locally — the
  // first parse was the paid windows-latest dispatch.
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
  for (const f of ['scripts/ui/vshot.py', 'scripts/winreg/vshot-win.py', 'scripts/winreg/bringup-win.py', 'scripts/winreg/campaign-win.py']) {
    const r = spawnSync('/usr/bin/python3', ['-c', `import ast; ast.parse(open('${f}').read())`], { encoding: 'utf8' })
    t.check(`${f} parses`, r.status === 0, (r.stderr || 'ok').slice(0, 120))
  }
}

t.section('vshot.py did NOT grow tokens this prover does not pin')
{
  // Inverse guard: scan vshot.py for cfg.get("...") / nxt.get("...") tokens
  // and require each to be in the pinned lists — a grammar addition must
  // update this prover (and the Windows driver) in the same change.
  const seen = new Set<string>()
  // Scan LIVE code only — vshot.py's fork-bomb note says `cfg["env"] is not
  // applied` in a comment, which is documentation of a non-token, not grammar.
  const code = posix
    .split('\n')
    .map(l => l.replace(/#.*$/, ''))
    .join('\n')
  for (const m of code.matchAll(/(?:cfg|nxt|step)\.get\("([A-Za-z]+)"/g)) seen.add(`"${m[1]}"`)
  for (const m of code.matchAll(/cfg\["([A-Za-z]+)"\]/g)) seen.add(`"${m[1]}"`)
  const pinned = new Set([...CFG_KEYS, ...SEND_KEYS, ...RESIZE_KEYS, '"cols"', '"rows"'])
  const unpinned = [...seen].filter(k => !pinned.has(k))
  t.check(
    'no unpinned grammar token in vshot.py',
    unpinned.length === 0,
    unpinned.join(', ') || `${seen.size} tokens, all pinned`,
  )
}

t.finish('prove-capture-grammar')
