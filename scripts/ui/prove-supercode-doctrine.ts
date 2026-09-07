#!/usr/bin/env bun
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-supercode-doctrine-'))

const ROOT = join(import.meta.dir, '..', '..')
const src = (...p: string[]) => readFileSync(join(ROOT, 'src', ...p), 'utf-8')
const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

function textOf(messages: unknown[]): string {
  return messages
    .map(m => {
      const content = (m as { message?: { content?: unknown } }).message?.content
      if (typeof content === 'string') return content
      if (Array.isArray(content)) return content.map(b => (typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('\n')
      return ''
    })
    .join('\n')
}

console.log('============================================================')
console.log(' supercode doctrine — the criterion, the cadence, the cost')
console.log('============================================================')

section('the full reminder')
const full = textOf(normalizeAttachmentForAPI({ type: 'ultra_effort', reminderType: 'full' } as never))
check('it opens with the mode heading', full.includes('## Supercode is on'))
check('the criterion: delegate proactively when parallel agents would materially improve speed or quality', full.includes('Delegate proactively when parallel agents would materially improve speed or quality'))
check('otherwise solo at max', full.includes('Otherwise work solo at max'))
check('the lead runs at max; sub-agents keep the configured default (never multiplied to max)', full.includes('you run at max') && full.includes('Sub-agents run at the configured sub-agent default effort, not at max'))
check('the verify pass stays', full.includes('Verify before you declare') && full.includes('loop until the checks come back clean'))
check('the no-new-risk line stays', full.includes('No new risk license') && full.includes('still need the usual confirmation'))
check('the phase loop stays', full.includes('Stay in the loop between phases'))
check('the three delegation surfaces are named (Workflow, Agent, LaunchFleet)', full.includes('Workflow tool') && full.includes('Agent-tool subagent') && full.includes('LaunchFleet'))
check('GONE: delegation "for anything multi-part" and "orchestrate by default"', !/multi-part/i.test(full) && !/Orchestrate by default/i.test(full) && !/Solo only conversational/i.test(full))
check('the standing opt-in line stays', full.includes('standing until it is turned off'))
check('fewer rules: no numbered list of imperatives', !/^\d+\. \*\*/m.test(full))

section('the sparse reminder and the exit line')
const sparse = textOf(normalizeAttachmentForAPI({ type: 'ultra_effort', reminderType: 'sparse' } as never))
check('the sparse reminder is one short paragraph pointing back at the full one', sparse.includes('Supercode is still on') && sparse.includes('full instructions earlier') && sparse.length < 400)
check('the sparse reminder repeats the criterion and the solo default', sparse.includes('delegate where parallel agents would materially improve speed or quality') && sparse.includes('otherwise work solo at max'))
check('GONE from the sparse reminder: "for substantive work" and "solo only trivial turns"', !/substantive work/.test(sparse) && !/solo only trivial/.test(sparse))
const exit = textOf(normalizeAttachmentForAPI({ type: 'ultra_effort_exit' } as never))
check('the exit line says the mode is off and the ordinary opt-in rules return', exit.includes('Supercode is off') && exit.includes('opt-in rules apply again'))

section('the same criterion on every describing surface')
const workflowPrompt = src('tools', 'WorkflowTool', 'workflowPrompt.ts')
check("the workflow prompt's supercode paragraph carries the criterion and the solo default", workflowPrompt.includes('whenever parallel agents would materially improve the speed or the quality of the answer') && workflowPrompt.includes('Where they would not, work solo at max'))
check('GONE from the workflow prompt: "for any task of substance" and "agentless only for conversational replies"', !/any task of substance/.test(workflowPrompt) && !/Go agentless only/.test(workflowPrompt))
const view = src('components', 'mercury-ui', 'SupercodeModeView.tsx')
check('the /supercode view says the same', view.includes('wherever parallel agents would materially improve speed or quality') && view.includes('solo at max otherwise') && !/for substantive work by default/.test(view))
const effortCmd = src('commands', 'effort', 'effort.tsx')
check('the /effort words say the same and name the sub-agent default', effortCmd.includes('wherever parallel agents would materially improve speed or quality') && effortCmd.includes('Sub-agents keep the configured sub-agent default effort') && !/standing expectation of dynamic orchestration/.test(effortCmd))
check('the /supercode command description says the same', src('commands', 'supercode', 'index.ts').includes('proactive delegation where parallel agents help'))
const effortModel = src('utils', 'cockpit', 'effortModel.ts')
check("the cockpit model's summary says the same and can carry the provider's delegation-lead flag", effortModel.includes('max reasoning + proactive delegation where parallel agents help') && effortModel.includes('export const DELEGATION_LEAD_NOTE'))

section('the cost of the mode is visible in the transcript')
const receipt = src('utils', 'cockpit', 'turnReceipt.ts')
check('the turn receipt counts Agent launches and folds the settled results\' tokens and list price', /const DELEGATE_TOOLS = new Set\(\['Agent'\]\)/.test(receipt) && /delegatedTokens/.test(receipt) && /delegatedCostUSD/.test(receipt) && /export function delegatedSpendLine/.test(receipt))
check('the receipt row prints the delegated line', /delegatedSpendLine\(c\)/.test(src('components', 'messages', 'TurnReceiptRow.tsx')))
check("the Agent tool's result carries the ledger's list price", /costUSD: ledger\.costUSD/.test(src('tools', 'AgentTool', 'agentToolUtils.ts')))

console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('✅ SUPERCODE-DOCTRINE PROOFS PASS')
else console.log(`❌ ${failures} SUPERCODE-DOCTRINE PROOF(S) FAILED`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
