#!/usr/bin/env bun
// ============================================================================
//  scripts/swarm/prove-self-address.ts
//  PROOF: the SendMessage self-address guard, driven through the REAL
//  tool call. A message to this session's own name never leaves the
//  session — the refusal names the confusion and the reachable teammates —
//  while every legitimate address keeps flowing:
//    • teammate → own name (plain)      ⇒ refused BEFORE local routing
//    • teammate → own name (question)   ⇒ refused at recipient resolution,
//                                          refusal lists the OTHER teammates
//    • teammate → peer                  ⇒ delivered (no overblocking)
//    • teammate → lead                  ⇒ delivered (the lead short-circuit
//                                          sits BEHIND the self guard)
//    • lead     → the lead name         ⇒ refused (the lead seat self-matches)
//
//  Run:  ~/.bun/bin/bun run scripts/swarm/prove-self-address.ts
// ============================================================================

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Sandbox the config home BEFORE importing (mailbox + roster IO resolve
// through getMercuryHome, memoized off this env var).
const TMP = mkdtempSync(join(tmpdir(), 'hermes-swarm-selfaddr-'))
process.env.MERCURY_CONFIG_DIR = TMP
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { SendMessageTool } = await import('../../src/tools/SendMessageTool/SendMessageTool.js')
const { TEAM_LEAD_NAME } = await import('../../src/utils/swarm/constants.js')
const { createTeammateContext, runWithTeammateContext } = await import(
  '../../src/utils/teammateContext.js'
)

let failures = 0
function check(cond: boolean, label: string, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}

// ── fixture: a two-worker roster on disk ────────────────────────────────────
const TEAM = 'selfaddr-team'
const teamDir = join(TMP, 'teams', TEAM)
mkdirSync(teamDir, { recursive: true })
writeFileSync(
  join(teamDir, 'config.json'),
  JSON.stringify({
    name: TEAM,
    createdAt: Date.now(),
    leadAgentId: 'lead-1',
    members: [
      { agentId: 'lead-1', name: TEAM_LEAD_NAME },
      { agentId: 'a-1', name: 'worker-a' },
      { agentId: 'b-1', name: 'worker-b' },
    ],
  }),
)

const context = {
  getAppState: () => ({
    teamContext: { teamName: TEAM, leadAgentId: 'lead-1' },
    tasks: {},
    agentNameRegistry: new Map<string, string>(),
  }),
  setAppState: () => {},
} as never

const parentAssistant = { requestId: 'req-selfaddr' } as never
const noopCanUse = (async () => ({ behavior: 'allow' })) as never

type CallOutput = { data: { success: boolean; message: string } }
async function callTool(to: string, message: unknown, summary?: string): Promise<CallOutput['data']> {
  const result = (await SendMessageTool.call(
    { to, message, ...(summary !== undefined ? { summary } : {}) } as never,
    context,
    noopCanUse,
    parentAssistant,
  )) as CallOutput
  return result.data
}

const asWorkerA = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTeammateContext(
    createTeammateContext({
      agentId: 'a-1',
      agentName: 'worker-a',
      teamName: TEAM,
      planModeRequired: false,
      parentSessionId: 'sess-1',
      abortController: new AbortController(),
    }),
    fn,
  )

console.log('SendMessage self-address guard — the refusal law and its bounds')

// teammate → own name, plain: refused before any routing
{
  const r = await asWorkerA(() => callTool('worker-a', 'note to self', 's'))
  check(!r.success && /own address/.test(r.message), 'teammate plain send to own name is refused by name', r.message)
}

// teammate → own name, question: refused at resolution, names the others
{
  const r = await asWorkerA(() => callTool('worker-a', { type: 'question', content: 'am I here?' }))
  check(!r.success && /own address/.test(r.message), 'teammate question to own name is refused by name', r.message)
  check(/worker-b/.test(r.message) && !/Teammates you can address:.*worker-a/.test(r.message), 'the refusal lists the OTHER teammates, never the sender', r.message)
}

// teammate → peer: delivered
{
  const r = await asWorkerA(() => callTool('worker-b', 'real work', 's'))
  check(r.success === true, 'teammate send to a peer still delivers', r.message)
}

// teammate → lead: delivered (the short-circuit sits behind the guard)
{
  const r = await asWorkerA(() => callTool(TEAM_LEAD_NAME, 'report', 's'))
  check(r.success === true, 'teammate send to the lead still delivers', r.message)
}

// lead → the lead name: refused (no teammate context ⇒ the lead seat)
{
  const r = await callTool(TEAM_LEAD_NAME, 'lead note to self', 's')
  check(!r.success && /own address/.test(r.message), 'the lead messaging the lead name is refused as self', r.message)
}

rmSync(TMP, { recursive: true, force: true })
console.log(failures === 0 ? '✅ self-address guard holds' : `❌ ${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
