#!/usr/bin/env bun

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const TMP = mkdtempSync(join(tmpdir(), 'mercury-livecomms-aggregation-'))
process.env.MERCURY_CONFIG_DIR = TMP

const { LiveCommsTool } = await import('../../src/tools/LiveCommsTool/LiveCommsTool.js')
const { setDynamicCrewContext } = await import('../../src/utils/crewmate.js')
const { createTask } = await import('../../src/utils/tasks.js')
const { sendLiveMessage } = await import('../../src/services/crew/liveComms.js')
const { openQuestion } = await import('../../src/utils/swarm/sendMessageGovernance.js')
const { recordHandoff } = await import('../../src/utils/swarm/handoff.js')
const { claimLease } = await import('../../src/utils/swarm/leaseGlob.js')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const CREW = 'brief-team'
const ME = 'bob'

console.log('============================================================')
console.log(' LiveComms aggregation — proof (real tool, real writers)')
console.log('============================================================')

section('no team ⇒ the honest empty brief')
{
  setDynamicCrewContext(null)
  const res = await LiveCommsTool.call({} as never, { getAppState: () => ({}) } as never)
  const data = (res as { data: { teamName: string | null; openTasks: unknown[] } }).data
  check('teamName is null outside a team', data.teamName === null)
  check('no fabricated rows', data.openTasks.length === 0)
  const block = LiveCommsTool.mapToolResultToToolResultBlockParam!(data as never, 'tu1')
  check(
    'renderer explains instead of fabricating',
    typeof block.content === 'string' && /Not part of a crew/.test(block.content),
  )
}

section('fixture team — every reader feeds the one brief')
{
  setDynamicCrewContext({
    agentId: 'bob-1',
    agentName: ME,
    teamName: CREW,
    planModeRequired: false,
  })

  const taskId = await createTask(CREW, {
    subject: 'wire the flux capacitor',
    description: 'route 1.21GW through the substrate',
    status: 'pending',
    owner: 'alice',
    blocks: [],
    blockedBy: [],
  })
  await sendLiveMessage(CREW, { to: ME, from: 'alice', text: 'heads up: capacitor parts arrived', timestamp: new Date().toISOString() })
  await openQuestion(
    { request_id: 'q-1', from: 'alice', to: ME, text: 'which lane do you want?', summary: 'lane pick' },
    CREW,
  )
  await recordHandoff(
    { id: 'h-brief', from: 'alice', to: 'Bob', status: 'done', summary: 'says done, shows nothing', evidenceRefs: [] },
    CREW,
  )
  const lease = await claimLease(CREW, 'alice', ['src/flux/**'], { base: TMP })
  check('fixture lease claimed', lease.ok === true, JSON.stringify(lease).slice(0, 80))

  const res = await LiveCommsTool.call({} as never, { getAppState: () => ({}) } as never)
  const data = (res as { data: Record<string, unknown> }).data as {
    teamName: string | null
    openTasks: { id: string; subject: string; status: string }[]
    unreadMessages: { from: string; text: string }[]
    openQuestions: { request_id: string; from: string }[]
    handoffs: { id: string; verified: boolean }[]
    leases: { agentId: string; globs: string[] }[]
  }

  check('brief carries the team name', data.teamName === CREW)
  check(
    'open task aggregated',
    data.openTasks.some(t => t.id === taskId && t.subject === 'wire the flux capacitor'),
  )
  check('unread message aggregated', data.unreadMessages.some(m => m.from === 'alice'))
  check('open question aggregated', data.openQuestions.some(q => q.request_id === 'q-1'))
  check(
    "handoff aggregated case-insensitively ('Bob' reaches bob) and quarantined",
    data.handoffs.some(h => h.id === 'h-brief' && h.verified === false),
  )
  check('lease aggregated', data.leases.some(l => l.agentId === 'alice' && l.globs.length === 1))

  const block = LiveCommsTool.mapToolResultToToolResultBlockParam!(data as never, 'tu2')
  const text = typeof block.content === 'string' ? block.content : ''
  check('rendered brief names the team', text.includes(`# Crew: ${CREW}`))
  check('rendered brief lists the open task', /## Open tasks \(1\)/.test(text))
  check('rendered brief lists the unread message', /## Unread messages \(1\)/.test(text))
  check('rendered brief lists the open question + answer protocol', /## Open questions \(1\)/.test(text) && /"type":"answer"/.test(text))
  check('rendered brief flags the unverified handoff LOUDLY', /UNVERIFIED \(no evidence backing a success claim\)/.test(text))
  check('rendered brief lists the lease', /## File claims \(1\)/.test(text))
}

section('a completed task drops out of the brief (open-only contract)')
{
  const { updateTask } = await import('../../src/utils/tasks.js')
  const res0 = await LiveCommsTool.call({} as never, { getAppState: () => ({}) } as never)
  const before = (res0 as { data: { openTasks: { id: string }[] } }).data.openTasks
  const target = before[0]
  if (!target) {
    check('precondition: an open task exists', false)
  } else {
    await updateTask(CREW, target.id, { status: 'completed' })
    const res1 = await LiveCommsTool.call({} as never, { getAppState: () => ({}) } as never)
    const after = (res1 as { data: { openTasks: { id: string }[] } }).data.openTasks
    check('completed task no longer aggregated', !after.some(t => t.id === target.id))
  }
}

setDynamicCrewContext(null)
try {
  rmSync(TMP, { recursive: true, force: true })
} catch {
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ PROOF PASSES — LiveComms aggregates all seven readers honestly')
} else {
  console.log(` ❌ PROOF FAILED — ${failures} check(s) failed`)
  process.exit(1)
}
