#!/usr/bin/env bun
// ============================================================================
//  scripts/consistency-census/prove-view-coherence.ts — W5 (UN-26/27/28/30/32/33):
//  the coherence laws landed, ratcheted as compile-closed structure.
//  The BEHAVIORAL journeys live in scripts/render-continuity/ (the retained D1–D7 suite —
//  registry×context matrix, PTY routing journey, view-target parity, 8-spec
//  selection drags, boot placement); this prover pins the STRUCTURE that
//  keeps a new session kind, surface, or region from falling through them.
//
//  §A ONE intent classifier, kind-INVARIANT — classifyAgentViewSubmission
//     takes input × keybinding × roster and NO session-kind parameter, and
//     exactly ONE composer consumer routes on it (a second local dialect
//     cannot exist).
//  §B COMPILE-CLOSED destinations — ActiveAgentForInput is a discriminated
//     union at one selector; the PO-1 view-target projection declares
//     closure over the task union (a new task kind is a compile error until
//     classified) — workflow agents, local background agents, and party
//     seats are TASKS, so they cannot silently gain their own routing.
//  §C SELECTION is region-bounded by the GENERAL law — the clip band walks
//     to the deepest scroll owner under the anchor and DECLINES on a lookup
//     miss. /health columns,
//     tables, and panels are yoga boxes under the same law; no surface is
//     special-cased.
//  §D /mouse honesty — the OFF copy names the real boundary (native
//     selection sweeps rails; Mercury's in-app drag is the bounded path).
//  §E BOOT placement has one owner (the splash double-read pin's
//     structural sibling).
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

// §A — one classifier, kind-invariant, one consumer
const intent = read('src/components/PromptInput/promptIntent.ts')
check('§A the classifier takes no session-kind parameter (kind-invariant by construction)', /inputParam: string,\s*\n\s*fromKeybinding: boolean,\s*\n\s*commands: Command\[\],/.test(intent))
const prompt = read('src/components/PromptInput/PromptInput.tsx')
const consumerCount = (prompt.match(/classifyAgentViewSubmission\(/g) ?? []).length
check('§A exactly ONE composer consumer routes on the classifier', consumerCount === 1, String(consumerCount))
check('§A the consumer routes on the typed task classifiers', prompt.includes('isInProcessTeammateTask(task)') && prompt.includes('isLocalAgentTask(task)'))

// §B — compile-closed destinations
const selectors = read('src/state/selectors.ts')
check('§B ActiveAgentForInput is the ONE typed destination union', selectors.includes('export type ActiveAgentForInput'))
check(
  '§B the PO-1 projection declares closure over the task union (compile-time exhaustiveness)',
  selectors.includes('export type EveryTaskTypeClassified') &&
    selectors.includes('Assert<IsEqual<TaskType, ClassifiedTaskType>>'),
)
check('§B the backgrounded main session can never become an input destination', selectors.includes('isPanelAgentTask(task)'))

// §C — the general region law
const ink = read('src/ink/ink.tsx')
check('§C the clip band walks to the deepest scroll owner under the anchor', ink.includes('applySelectionClipBand') && /while \(node\) \{\s*\n\s*if \(node\.scroll\?\.scrollTop !== undefined/.test(ink))
check(
  '§C a lookup miss DECLINES the gesture — clears the selection and returns before any band is set (the rail-escape class)',
  ink.includes('const region = owner ?? hit') &&
    /if \(!rect\) \{\s*\n(?:\s*\/\/[^\n]*\n)*\s*clearSelection\(this\.selection\)\s*\n\s*return/.test(ink),
)

// §D — /mouse honesty
const mouse = read('src/commands/mouse/mouse.ts')
check('§D /mouse off names the native-selection boundary truthfully', mouse.includes('native selection sweeps the side rails') && mouse.includes('drag copies the transcript cleanly'))

// §E — boot placement one-owner (structural sibling of the splash double-read pin)
const splash = read('assets/splash/mercury-splash.mjs')
check('§E the splash reads geometry once per paint (no per-block re-read)', !/process\.stdout\.columns[\s\S]*process\.stdout\.columns[\s\S]*process\.stdout\.columns/.test(splash) || splash.includes('snapshot'))

console.log(failed === 0 ? '\n ✅ VIEW COHERENCE STRUCTURE HOLDS' : `\n ❌ ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
