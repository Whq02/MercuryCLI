#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'mercury-crew-selfaddr-'))
process.env.MERCURY_CONFIG_DIR = TMP
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { SendMessageTool } = await import('../../src/tools/SendMessageTool/SendMessageTool.js')
const { CREW_LEAD_NAME } = await import('../../src/utils/crew/constants.js')
const { createCrewmateContext, runWithCrewmateContext } = await import(
  '../../src/utils/crewmateContext.js'
)

let failures = 0
function check(cond: boolean, label: string, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}

const CREW = 'selfaddr-crew'
const crewDir = join(TMP, 'crews', CREW)
mkdirSync(crewDir, { recursive: true })
writeFileSync(
  join(crewDir, 'config.json'),
  JSON.stringify({
    name: CREW,
    createdAt: Date.now(),
    leadAgentId: 'lead-1',
    members: [
      { agentId: 'lead-1', name: CREW_LEAD_NAME, joinedAt: 1, tmuxPaneId: '', cwd: TMP, subscriptions: [] },
      { agentId: 'a-1', name: 'worker-a', joinedAt: 1, tmuxPaneId: '', cwd: TMP, subscriptions: [] },
      { agentId: 'b-1', name: 'worker-b', joinedAt: 1, tmuxPaneId: '', cwd: TMP, subscriptions: [] },
    ],
  }),
)

const context = {
  getAppState: () => ({
    crewContext: { crewName: CREW, leadAgentId: 'lead-1' },
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
  runWithCrewmateContext(
    createCrewmateContext({
      agentId: 'a-1',
      agentName: 'worker-a',
      crewName: CREW,
      parentSessionId: 'sess-1',
      abortController: new AbortController(),
    }),
    fn,
  )

console.log('SendMessage self-address guard — the refusal law and its bounds')

{
  const r = await asWorkerA(() => callTool('worker-a', 'note to self', 's'))
  check(!r.success && /own address/.test(r.message), 'crewmate plain send to own name is refused by name', r.message)
}

{
  const r = await asWorkerA(() => callTool('worker-a', { type: 'question', content: 'am I here?' }))
  check(!r.success && /own address/.test(r.message), 'crewmate question to own name is refused by name', r.message)
  check(/worker-b/.test(r.message) && !/Crewmates you can address:.*worker-a/.test(r.message), 'the refusal lists the OTHER crewmates, never the sender', r.message)
}

{
  const r = await asWorkerA(() => callTool('worker-b', 'real work', 's'))
  check(r.success === true, 'crewmate send to a peer still delivers', r.message)
}

{
  const r = await asWorkerA(() => callTool(CREW_LEAD_NAME, 'report', 's'))
  check(r.success === true, 'crewmate send to the lead still delivers', r.message)
}

{
  const r = await callTool(CREW_LEAD_NAME, 'lead note to self', 's')
  check(!r.success && /own address/.test(r.message), 'the lead messaging the lead name is refused as self', r.message)
}

rmSync(TMP, { recursive: true, force: true })
console.log(failures === 0 ? '✅ self-address guard holds' : `❌ ${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
