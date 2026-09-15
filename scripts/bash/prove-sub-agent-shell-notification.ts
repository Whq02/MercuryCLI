#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, SCRATCH_ROOT, makeTally } from '../daemon/dupline-world.ts'
import { runScriptedTurn, startScriptedFixture, type ScriptedRequest, type SeenResult } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-sub-agent-shell-notification')
const KEEP = process.argv.includes('--keep')
const scratch = mkdtempSync(join(SCRATCH_ROOT, 'shell-notification-'))
const work = join(scratch, 'work')
mkdirSync(work, { recursive: true })
console.log(`build under proof: ${DIST}`)
console.log(`world: ${scratch}`)

const ASK = 'notification-probe'
const AGENT_PROMPT = 'background agent work'
const FOLLOW_UP = 'the follow-up: what became of your background run?'
const SUB_COMMAND = 'sleep 1; echo shell-done'
const SUB_DESCRIPTION = 'the sub-agent’s short background run'
let subShellId: string | null = null
let agentId: string | null = null
let agentRoster: string[] = []
const subTextsBefore: string[] = []
const subTextsAfter: string[] = []
const leadTexts: string[] = []
let subLaunch: SeenResult | undefined
let followUpSent = false
const idOf = (t: string | undefined): string | null => /\(ID: (b[0-9a-z]+)\)/.exec(t ?? '')?.[1] ?? null
const textsOf = (req: ScriptedRequest): string[] => [req.ask, ...req.results.map(r => r.text)]

const fixture = await startScriptedFixture(req => {
  const last = req.results[req.results.length - 1]
  if (req.opening.trim() === AGENT_PROMPT) {
    if (agentRoster.length === 0) agentRoster = req.toolNames
    ;(followUpSent ? subTextsAfter : subTextsBefore).push(...textsOf(req))
    if (followUpSent) return [{ type: 'text', text: 'agent done again' }]
    switch (req.step) {
      case 0:
        return [{ type: 'tool_use', name: 'Bash', input: { command: SUB_COMMAND, run_in_background: true, description: SUB_DESCRIPTION } }]
      case 1:
        subLaunch = last
        subShellId = idOf(last?.text)
        return [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 3', description: 'a pause past the run' } }]
      default:
        return [{ type: 'text', text: 'agent done' }]
    }
  }
  if (req.ask.trim() !== ASK) return [{ type: 'text', text: 'ok' }]
  leadTexts.push(...textsOf(req))
  switch (req.step) {
    case 0:
      return [{ type: 'tool_use', name: 'Agent', input: { description: 'background agent', prompt: AGENT_PROMPT, run_in_background: true } }]
    case 1:
      agentId = /\b(a[0-9a-z]{8})\b/.exec(last?.text ?? '')?.[1] ?? null
      return [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 6', description: 'a pause while the agent’s run finishes' } }]
    case 2:
      followUpSent = true
      return [{ type: 'tool_use', name: 'SendMessage', input: { to: agentId ?? 'nobody', message: FOLLOW_UP, summary: 'the follow-up' } }]
    case 3:
      return [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 8', description: 'a pause for the agent’s next turn' } }]
    default:
      return [{ type: 'text', text: 'done' }]
  }
})

let turn: { exitCode: number | null; stderr: string } = { exitCode: null, stderr: '' }
try {
  turn = await runScriptedTurn({ runHome: join(scratch, 'home'), cwd: work, base: fixture.base, ask: ASK, timeoutMs: 150_000, extraArgv: ['--dangerously-bypass-permissions'] })
} finally {
  await fixture.close()
}

const notificationsIn = (texts: string[]): string[] => {
  const out: string[] = []
  for (const text of texts) for (const m of text.matchAll(/<task-notification>[\s\S]*?<\/task-notification>/g)) out.push(m[0])
  return out
}
const before = notificationsIn(subTextsBefore)
const after = notificationsIn(subTextsAfter)
const leadNotes = notificationsIn(leadTexts)
const ours = [...before, ...after].filter(n => subShellId !== null && n.includes(subShellId))
const inFirstTurn = before.some(n => subShellId !== null && n.includes(subShellId))
console.log(`\nrun exit ${turn.exitCode}; requests ${fixture.requests.length}; agent ${agentId}; shell ${subShellId}`)
console.log(`agent roster has Sleep: ${agentRoster.includes('Sleep')}, Monitor: ${agentRoster.includes('Monitor')}`)
console.log(`notifications in the agent’s first turn: ${before.length}; in its turn after the follow-up: ${after.length}; in the lead’s turn: ${leadNotes.length}`)
for (const n of ours.slice(0, 1)) console.log(`\n── the notification the agent took ──\n${n.split('\n').map(l => `│ ${l}`).join('\n')}`)
if (ours.length === 0 && subLaunch) console.log(`\n── the agent’s launch ──\n│ ${subLaunch.text.split('\n')[0]}`)

tally.section('A. a background agent is told that its background command finished')
tally.check('A1 the background agent launched its command in the background', agentId !== null && subShellId !== null, `agent ${agentId}, shell ${subShellId}`)
tally.check('A2 the lead’s follow-up reached the agent and it took a turn', subTextsAfter.length > 0, `requests after the follow-up: ${subTextsAfter.length}`)
tally.check('A3 the task notification for the command reached the agent\u2019s own turn', ours.length >= 1, `in its first turn: ${before.length}; after the follow-up: ${after.length}`)
tally.check('A3b it arrived at the next tool boundary of the turn that launched it', inFirstTurn, `first-turn notifications: ${before.length}`)
tally.check('A4 the notification says the command completed and names its description', ours.some(n => /<status>completed<\/status>/.test(n) && n.includes(SUB_DESCRIPTION)), ours[0]?.slice(0, 300))
tally.check('A5 the notification went to the agent, not to the lead', subShellId !== null && !leadNotes.some(n => n.includes(subShellId!)), `lead notifications naming the shell: ${leadNotes.filter(n => subShellId !== null && n.includes(subShellId)).length}`)

if (tally.failed() === 0 && !KEEP) rmSync(scratch, { recursive: true, force: true })
else console.log(`\nworld kept: ${scratch}`)
tally.finish()
