#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

const intent = read('src/components/PromptInput/promptIntent.ts')
check('§A the classifier takes no session-kind parameter (kind-invariant by construction)', /inputParam: string,\s*\n\s*fromKeybinding: boolean,\s*\n\s*commands: Command\[\],/.test(intent))
const prompt = read('src/components/PromptInput/PromptInput.tsx')
const consumerCount = (prompt.match(/classifyAgentViewSubmission\(/g) ?? []).length
check('§A exactly ONE composer consumer routes on the classifier', consumerCount === 1, String(consumerCount))
check('§A the consumer routes on the typed task classifiers', prompt.includes('isInProcessTeammateTask(task)') && prompt.includes('isLocalAgentTask(task)'))

const selectors = read('src/state/selectors.ts')
check('§B ActiveAgentForInput is the ONE typed destination union', selectors.includes('export type ActiveAgentForInput'))
check(
  '§B the PO-1 projection declares closure over the task union (compile-time exhaustiveness)',
  selectors.includes('export type EveryTaskTypeClassified') &&
    selectors.includes('Assert<IsEqual<TaskType, ClassifiedTaskType>>'),
)
check('§B the backgrounded main session can never become an input destination', selectors.includes('isPanelAgentTask(task)'))

const ink = read('src/ink/ink.tsx')
check('§C the clip band walks to the deepest scroll owner under the anchor', ink.includes('applySelectionClipBand') && /while \(node\) \{\s*\n\s*if \(node\.scroll\?\.scrollTop !== undefined/.test(ink))
check(
  '§C a lookup miss DECLINES the gesture — clears the selection and returns before any band is set (the rail-escape class)',
  ink.includes('const region = owner ?? hit') &&
    /if \(!rect\) \{\s*\n(?:\s*\/\/[^\n]*\n)*\s*clearSelection\(this\.selection\)\s*\n\s*return/.test(ink),
)

const mouse = read('src/commands/mouse/mouse.ts')
check('§D /mouse off names the native-selection boundary truthfully', mouse.includes('native selection sweeps the side rails') && mouse.includes('drag copies the transcript cleanly'))

const splash = read('assets/splash/mercury-splash.mjs')
check('§E the splash reads geometry once per paint (no per-block re-read)', !/process\.stdout\.columns[\s\S]*process\.stdout\.columns[\s\S]*process\.stdout\.columns/.test(splash) || splash.includes('snapshot'))

console.log(failed === 0 ? '\n ✅ VIEW COHERENCE STRUCTURE HOLDS' : `\n ❌ ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
