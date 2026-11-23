#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'daemon-facts-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const seat = await import('../../src/engine/connector/daemonConnector.ts')
const preview = await import('../../src/models/roads/transitionPreview.ts')

section("§1 the source stamp — the session's own truth, or an honest 'ambient'")
{
  const recorded = seat.daemonSessionConnectorFor({
    sessionId: '00000000-aaaa-bbbb-cccc-00000000m201',
    runnerId: 'runner-m2-1',
    title: 'facts fixture',
    projectLabel: 'proj',
    workspaceId: scratch,
    home: scratch,
    modelKey: 'glm-5.3',
  })
  const withRecord = recorded.modelFacts()
  check(
    "an admission record's modelKey answers effective='record' — the SESSION's fact",
    withRecord.effective === 'glm-5.3' && withRecord.effectiveSource === 'record',
    JSON.stringify({ effective: withRecord.effective, source: withRecord.effectiveSource }) +
      ' — change modelFacts in src/engine/connector/daemon/facts.ts so the admission record modelKey gives effective and effectiveSource=record',
  )
  const bare = seat.daemonSessionConnectorFor({
    sessionId: '00000000-aaaa-bbbb-cccc-00000000m202',
    runnerId: 'runner-m2-2',
    title: 'bare fixture',
    projectLabel: 'proj',
    workspaceId: scratch,
    home: scratch,
  })
  const ambient = bare.modelFacts()
  check(
    "neither facts nor record resolving says so: effectiveSource='ambient' (the fallback is THIS process's state, not the session's)",
    ambient.effectiveSource === 'ambient',
    JSON.stringify({ effective: ambient.effective, source: ambient.effectiveSource }) +
      ' — change modelFacts in src/engine/connector/daemon/facts.ts so a session with no facts and no record reports ambient',
  )
}

section('§2 the gate is sensitive to WHICH history feeds it')
{
  const user = {
    type: 'user',
    uuid: '00000000-0000-4000-8000-00000000m211',
    message: { role: 'user', content: 'work' },
  } as never
  const thinkingAssistant = {
    type: 'assistant',
    uuid: '00000000-0000-4000-8000-00000000m212',
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [
        { type: 'thinking', thinking: 'a long private chain', signature: 'sig' },
        { type: 'text', text: 'the answer.' },
      ],
    },
  } as never
  const sessionHistory = [user, thinkingAssistant]
  const screenHistory: never[] = []
  const overSession = preview.previewForSelection(sessionHistory, 'claude-sonnet-4-6', 'gpt-5.6-sol')
  const overScreen = preview.previewForSelection(screenHistory, 'claude-fable-5', 'gpt-5.6-sol')
  check(
    "the plan's from is the SESSION's model, not the screen's",
    overSession.from === 'claude-sonnet-4-6',
    'change previewForSelection in src/models/roads/transitionPreview.ts so from is the model argument given for the history',
  )
  check(
    'lossy over the session history, lossless over the empty screen history — the disagreement the old wiring collapsed',
    overSession.needsChoice === true && overScreen.needsChoice === false,
    JSON.stringify({ session: overSession.needsChoice, screen: overScreen.needsChoice, counts: overSession.counts }) +
      ' — change previewForSelection in src/models/roads/transitionPreview.ts so needsChoice follows the history it is given',
  )
}

section('§3 plan-digest determinism (the in-process parity acceptance)')
{
  const history = [
    {
      type: 'user',
      uuid: '00000000-0000-4000-8000-00000000m221',
      message: { role: 'user', content: 'same bytes' },
    },
  ] as never[]
  const a = preview.previewForSelection(history, 'claude-sonnet-4-6', 'gpt-5.6-sol')
  const b = preview.previewForSelection(history, 'claude-sonnet-4-6', 'gpt-5.6-sol')
  check('identical inputs build byte-identical plan digests', a.planDigest === b.planDigest, `${a.planDigest} vs ${b.planDigest} — change the planDigest computation in src/models/roads/transitionPreview.ts so equal inputs hash equally`)
}

section('§4 the wiring, structural')
{
  const { publishSessionFacts } = await import('../../src/engine/connector/seatProjections.ts')
  const says = (sessionId: string, atMs: number): void =>
    publishSessionFacts({
      schema: 1,
      sessionId,
      atMs,
      pendingModel: null,
      busy: false,
      model: { effective: 'glm-5.3', setting: 'glm-5.3' },
      usage: { totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false },
      identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null },
      skills: [],
      mcp: [],
      workspace: { cwd: scratch, originalCwd: scratch, projectRoot: scratch },
      queue: [],
    })
  const parkedId = '00000000-aaaa-bbbb-cccc-00000000m203'
  says(parkedId, 1)
  let parkedFeedReads: () => void = () => {}
  const parked = new seat.DaemonSessionConnector({ sessionId: parkedId, runnerId: '', title: 'parked fixture', projectLabel: 'proj', workspaceId: scratch, home: scratch }, {
    factsRead: (read: () => void) => {
      parkedFeedReads = read
    },
  })
  const coldSeed = parked.modelFacts().effectiveSource
  parkedFeedReads()
  const sameSeed = parked.modelFacts().effectiveSource
  says(parkedId, 2)
  parkedFeedReads()
  const answered = parked.modelFacts().effectiveSource
  const hostedId = '00000000-aaaa-bbbb-cccc-00000000m204'
  says(hostedId, 1)
  const hosted = seat.daemonSessionConnectorFor({ sessionId: hostedId, runnerId: 'runner-m2-4', title: 'hosted fixture', projectLabel: 'proj', workspaceId: scratch, home: scratch })
  check(
    'the connector stamps a cold seed as recorded and a runner answer as live beside the fallback chain',
    coldSeed === 'record' && sameSeed === 'record' && answered === 'live' && hosted.modelFacts().effectiveSource === 'live',
    JSON.stringify({ coldSeed, sameSeed, answered, hosted: hosted.modelFacts().effectiveSource }) +
      ' — change modelFacts in src/engine/connector/daemon/facts.ts so a cold seed reads record and a runner answer reads live',
  )
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ prove-transition-daemon-facts — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ prove-transition-daemon-facts — all checks pass')
process.exit(0)
