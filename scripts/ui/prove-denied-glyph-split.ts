#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-denied-glyph-split.ts
//  PROOF: the transcript status glyph splits DENIAL from ORDINARY FAILURE
// The CRIMSON ✕ is reserved for a denial —
//  a rejected permission, an interrupt, a kill — where the operator said no.
//  A tool that merely ERRORED (a non-zero bash exit, an ENOENT) is ordinary
//  work-in-progress and wears the AMBER ▲ warn lead, so half the transcript
//  never reads as an alarm.
//
//  Legs:
//   A. UNIT — isDenialResultText() classifies every denial canon TRUE and
//      every ordinary-failure shape FALSE (the single source of the split).
//   B. SOURCE — the split is wired across all five surfaces (lookups builds
//      deniedToolUseIDs; ToolUseLoader + FallbackToolUseErrorMessage branch
//      glyph+tone on it; Assistant + Collapsed rows feed it in).
//   C. RENDER (the ships-in-dist proof — real binary, real PTY, denied-
//      transcript at 80): a DENIED Edit leads with ✕ fg CRIMSON; an ERRORED
//      Edit leads with ▲ fg AMBER at BOTH the status glyph AND the fallback
//      error-card body headline; and NO ✕ survives on the errored rows.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-denied-glyph-split.ts
// ============================================================================
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AMBER, CRIMSON } from '../../src/components/mercuryPalette.ts'
import {
  AUTO_REJECT_MESSAGE,
  CANCEL_MESSAGE,
  DONT_ASK_REJECT_MESSAGE,
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  PLAN_REJECTION_PREFIX,
  REJECT_MESSAGE,
  REJECT_MESSAGE_WITH_REASON_PREFIX,
  SUBAGENT_REJECT_MESSAGE,
  SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX,
  isDenialResultText,
} from '../../src/utils/messages/rejectionText.ts'
import { CONFIG_HOME, cleanupScenario, scenario } from './renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const src = (p: string) => readFileSync(p, 'utf8')
const hexEq = (a: string | undefined, hex: string) =>
  (a ?? '').replace('#', '').toLowerCase() === hex.replace('#', '').toLowerCase()

console.log('============================================================')
console.log(' denied-glyph split — ✕ crimson (denial) vs ▲ amber (error)')
console.log('============================================================')

// ── A. UNIT: the classifier is the whole split ──────────────────────────────
console.log('\n(A) isDenialResultText — denial canon TRUE, ordinary failure FALSE')
const DENIALS: Array<[string, string]> = [
  ['interrupt', INTERRUPT_MESSAGE],
  ['interrupt(tool-use)', INTERRUPT_MESSAGE_FOR_TOOL_USE],
  ['cancel', CANCEL_MESSAGE],
  ['reject', REJECT_MESSAGE],
  ['reject+reason', REJECT_MESSAGE_WITH_REASON_PREFIX + 'do it the other way'],
  ['subagent-reject', SUBAGENT_REJECT_MESSAGE],
  ['subagent-reject+reason', SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX + 'nope'],
  ['plan-rejection', PLAN_REJECTION_PREFIX + 'the rejected plan body'],
  ['auto-mode-classifier', 'Permission for this action has been denied. Reason: unsafe path'],
  ['auto-reject(fn)', AUTO_REJECT_MESSAGE('Bash')],
  ['dont-ask-reject(fn)', DONT_ASK_REJECT_MESSAGE('Write')],
]
for (const [name, text] of DENIALS) {
  check(`denial: ${name} ⇒ TRUE`, isDenialResultText(text) === true)
}
const ORDINARY: Array<[string, string]> = [
  ['ENOENT', "Error: ENOENT: no such file or directory, open '/x/y.ts'\n    at openSync (node:fs)"],
  ['bash exit 1', 'Error: command failed with exit code 1'],
  ['generic fail', 'Tool execution failed'],
  ['invalid params', 'Invalid tool parameters'],
  ['empty', ''],
  // A near-miss: has "denied" but NOT the workaround tail ⇒ not our denial canon.
  ['bare-denied-noise', 'the request was denied by the upstream API'],
]
for (const [name, text] of ORDINARY) {
  check(`ordinary: ${name} ⇒ FALSE`, isDenialResultText(text) === false)
}

// ── B. SOURCE: the split is wired across all five surfaces ───────────────────
console.log('\n(B) source contract — the split threads through every surface')
{
  const lk = src('src/utils/messages/lookups.ts')
  check('lookups builds deniedToolUseIDs from isDenialResultText',
    lk.includes('deniedToolUseIDs') && lk.includes('isDenialResultText('))
  const tul = src('src/components/ToolUseLoader.tsx')
  check('ToolUseLoader branches glyph+tone on isDenied',
    tul.includes('isDenied') &&
      tul.includes("color={isDenied ? 'error' : 'warning'}") &&
      tul.includes('isDenied ? GLYPH.fail : GLYPH.warn'))
  const fb = src('src/components/FallbackToolUseErrorMessage.tsx')
  check('FallbackToolUseErrorMessage headline honors the denial split',
    fb.includes('isDenialResultText(rawText)') &&
      fb.includes('isDenied ? tokens.failure : tokens.warning') &&
      fb.includes("isDenied ? 'error' : 'warning'"))
  const atu = src('src/components/messages/AssistantToolUseMessage.tsx')
  check('AssistantToolUseMessage feeds isDenied from the lookup',
    atu.includes('lookups.deniedToolUseIDs.has(param.id)') && atu.includes('isDenied={denied}'))
  const cr = src('src/components/messages/CollapsedReadSearchContent.tsx')
  check('CollapsedReadSearchContent folds anyDenied through',
    cr.includes('anyDenied') && cr.includes('isDenied={anyDenied}'))
}

// ── C. RENDER: the real binary paints the split (ships-in-dist) ──────────────
console.log('\n(C) render — denied-transcript at 80 (real dist binary, PTY)')
type Cell = { c: string; fg?: string; bold?: boolean }
type Grid = { grid: Cell[][] }
function capture(): Cell[][] | null {
  const cfg = scenario('denied-transcript', 80, 40)
  const gridPath = `/tmp/deny-split-${process.pid}.json`
  const cfgPath = `/tmp/deny-split-cfg-${process.pid}.json`
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: gridPath }))
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, 'vshot.py'), cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(120_000),
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: CONFIG_HOME,
    },
  })
  if (res.status !== 0) {
    check('PTY capture ran', false, res.stderr?.slice(0, 200) ?? '')
    return null
  }
  return (JSON.parse(readFileSync(gridPath, 'utf8')) as Grid).grid
}

const grid = capture()
if (grid) {
  const lineOf = (needle: string) =>
    grid.findIndex(r => r.map(c => c.c).join('').includes(needle))
  const leadOf = (y: number): Cell | undefined =>
    y >= 0 ? grid[y]!.find(c => c.c === '✕' || c.c === '▲') : undefined

  // Denied Edit (prod-rollout.ts): status glyph ✕ CRIMSON.
  const denyY = lineOf('prod-rollout.ts')
  const denyLead = leadOf(denyY)
  check('denied Edit status row present', denyY >= 0)
  check('denied Edit leads with ✕', denyLead?.c === '✕',
    denyLead ? `saw '${denyLead.c}'` : 'no glyph')
  check('denied ✕ is CRIMSON', hexEq(denyLead?.fg, CRIMSON),
    `fg=${denyLead?.fg} want=${CRIMSON}`)

  // Errored Edit (missing-manifest.ts): status glyph ▲ AMBER, NOT ✕.
  const errY = lineOf('missing-manifest.ts')
  const errLead = leadOf(errY)
  check('errored Edit status row present', errY >= 0)
  check('errored Edit leads with ▲ (not ✕)', errLead?.c === '▲',
    errLead ? `saw '${errLead.c}'` : 'no glyph')
  check('errored ▲ is AMBER', hexEq(errLead?.fg, AMBER),
    `fg=${errLead?.fg} want=${AMBER}`)

  // Fallback error-card body headline: ▲ AMBER bold (was ✕ CRIMSON pre-split).
  const bodyY = lineOf('Error: ENOENT')
  const bodyLead = leadOf(bodyY)
  check('errored body headline present', bodyY >= 0)
  check('body headline leads with ▲ (not ✕)', bodyLead?.c === '▲',
    bodyLead ? `saw '${bodyLead.c}'` : 'no glyph')
  check('body headline ▲ is AMBER', hexEq(bodyLead?.fg, AMBER),
    `fg=${bodyLead?.fg} want=${AMBER}`)

  // Loud red: if either status row misses its glyph, print the rows around
  // both needles — a geometry shift must name itself in the log.
  if (denyLead?.c !== '✕' || errLead?.c !== '▲') {
    console.log('  … transcript rows around the needles (first 78 cols):')
    for (const y of [denyY, errY]) {
      if (y < 0) continue
      for (let i = Math.max(0, y - 2); i <= Math.min(grid.length - 1, y + 2); i++) {
        console.log(`  ${String(i).padStart(2)}│${grid[i]!.map(c => c.c).join('').trimEnd().slice(0, 78)}`)
      }
    }
  }

  // Regression lock: no ✕ anywhere on the errored Edit's status row or body
  // headline row — the split must be total, not leave a stray crimson mark.
  const noFailOn = (y: number) =>
    y < 0 || !grid[y]!.some(c => c.c === '✕')
  check('errored status row carries no ✕', noFailOn(errY))
  check('errored body headline row carries no ✕', noFailOn(bodyY))
}
cleanupScenario('denied-transcript')

console.log(
  `\n${failures === 0 ? '✅ denied-glyph split PROVEN' : `❌ ${failures} FAILURE(S)`}`,
)
process.exit(failures === 0 ? 0 : 1)
