#!/usr/bin/env bun
// ============================================================================
//  scripts/agents/prove-lifecycle-vocabulary.ts — the subagent lifecycle
//  vocabulary (spec 03-C2): one derivation, four states, Mercury's revival
//  truth per state, and the worktree-fallback honesty on revival.
//
//    §A the derivation truth-table — running/idle/parked/aborted from the
//       owning facts; the idle TTL bucket is the cache-warm window
//    §B the reconciliation — aborted agents STAY revivable from transcript
//       (Mercury's law is more capable than aborted-is-terminal; the
//       divergence is documented in the module head)
//    §C the revival honesty (structural) — a resumed agent whose worktree
//       is gone reports cwdFallback and BOTH SendMessage resume arms
//       surface it verbatim (the ground shifted; the sender must know)
//
//  Run: ~/.bun/bin/bun run scripts/agents/prove-lifecycle-vocabulary.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const { deriveAgentLifecycle, IDLE_TTL_MS } = await import(
  '../../src/services/agentResults/lifecycle.ts'
)

const NOW = 1_000_000_000

// ============================================================================
section('§A the derivation truth-table')
// ============================================================================
{
  const running = deriveAgentLifecycle({ taskStatus: 'running', transcriptExists: true, now: NOW })
  check('running: not revivable, messages queue', running.state === 'running' && !running.revivable && running.basis.includes('queue'))
  const pending = deriveAgentLifecycle({ taskStatus: 'pending', transcriptExists: false, now: NOW })
  check('pending counts as running', pending.state === 'running')
  const idle = deriveAgentLifecycle({ taskStatus: 'completed', finishedAtMs: NOW - IDLE_TTL_MS + 1000, transcriptExists: true, now: NOW })
  check('completed within the TTL: idle, revivable WARM', idle.state === 'idle' && idle.revivable && idle.basis.includes('warm'))
  const parked = deriveAgentLifecycle({ taskStatus: 'completed', finishedAtMs: NOW - IDLE_TTL_MS - 1000, transcriptExists: true, now: NOW })
  check('completed past the TTL: parked, revivable COLD', parked.state === 'parked' && parked.revivable && parked.basis.includes('cold'))
  const diskOnly = deriveAgentLifecycle({ transcriptExists: true, now: NOW })
  check('registry row gone + transcript on disk: parked (a resumed session rediscovers it)', diskOnly.state === 'parked' && diskOnly.revivable)
  const nothing = deriveAgentLifecycle({ transcriptExists: false, now: NOW })
  check('no transcript anywhere: aborted, NOT revivable, honest basis', nothing.state === 'aborted' && !nothing.revivable && nothing.basis.includes('nothing to revive'))
}

// ============================================================================
section('§B the reconciliation — Mercury keeps aborted revivable')
// ============================================================================
{
  const killed = deriveAgentLifecycle({ taskStatus: 'killed', transcriptExists: true, now: NOW })
  check('killed + transcript: aborted AND revivable (the documented divergence)', killed.state === 'aborted' && killed.revivable && killed.basis.includes('revives'))
  const failedNoTranscript = deriveAgentLifecycle({ taskStatus: 'failed', transcriptExists: false, now: NOW })
  check('failed without a transcript: aborted, not revivable', failedNoTranscript.state === 'aborted' && !failedNoTranscript.revivable)
  const moduleHead = readFileSync(join(ROOT, 'src/services/agentResults/lifecycle.ts'), 'utf8')
  check('the divergence is documented where the vocabulary lives', moduleHead.includes('MORE capable') && moduleHead.includes('never-reduce'))
}

// ============================================================================
section('§C the revival honesty (structural pins)')
// ============================================================================
{
  const resume = readFileSync(join(ROOT, 'src/tools/AgentTool/resumeAgent.ts'), 'utf8')
  check('a gone worktree reports cwdFallback on the result', resume.includes("cwdFallback: 'parent-checkout'"))
  const send = readFileSync(join(ROOT, 'src/tools/SendMessageTool/SendMessageTool.ts'), 'utf8')
  const fallbackClauses = send.split('its worktree is gone').length - 1
  check('BOTH SendMessage resume arms surface the fallback verbatim', fallbackClauses === 2, `clauses=${fallbackClauses}`)
  check('the surfaced words say WHERE edits land now', send.includes('anything it edits lands in the real tree'))
}

// ============================================================================
section('§D the consumers — the vocabulary is SPOKEN (no orphan module)')
// ============================================================================
{
  const bridge = readFileSync(join(ROOT, 'src/components/tasks/taskStatusUtils.tsx'), 'utf8')
  check('taskStatusUtils bridges rows to the ONE derivation (agentLifecycleOf)', bridge.includes('deriveAgentLifecycle(') && bridge.includes('export function agentLifecycleOf'))
  check('the bridge feeds owner-held facts (status, endTime, the terminal transcript promise)', bridge.includes('finishedAtMs: row.endTime') && bridge.includes('transcriptExists: isTerminalStatus(row.status)'))
  const dialog = readFileSync(join(ROOT, 'src/components/tasks/AsyncAgentDetailDialog.tsx'), 'utf8')
  check('the agent detail dialog SPEAKS the vocabulary (state + basis verbatim)', dialog.includes('agentLifecycleOf(agent)') && dialog.includes('lifecycle.basis'))
  check('running rows stay on the live status line (no doubled words)', dialog.includes("lifecycle.state !== 'running'"))
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
