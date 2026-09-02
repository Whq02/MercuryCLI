#!/usr/bin/env bun
// ============================================================================
//  prove-transition-daemon-facts — FN-013 MODEL-02: the transition preview
//  is built from the SESSION THAT WILL EXECUTE THE SWITCH.
//
//  For a daemon-hosted session — the normal shape for every chat since the
//  one-door unification — the loss preview used to be computed from the
//  SCREEN's AppState (its model, its messages) while the switch was
//  applied through the session's connector: the gate could pass a switch
//  that is actually lossy, hold one that is not, and warn about a
//  transition between two models the executing session is on neither of.
//
//    §1 the SOURCE STAMP: the connector's model facts say where
//       `effective` came from — the durable admission record is the
//       session's own truth ('record'); neither facts nor record resolving
//       falls back to THIS process's ambient state and says so
//       ('ambient'), which is exactly what the gate refuses to plan from.
//    §2 the gate's sensitivity to WHICH history feeds it: the same X→Z
//       switch is lossy over the session's history (thinking spans reset)
//       and lossless over an empty screen history — the two-sessions
//       disagreement the old wiring collapsed.
//    §3 plan-digest determinism: identical inputs build byte-identical
//       digests (the in-process parity acceptance).
//    §4 the wiring, structural: the daemon arm plans from connector facts
//       + records; the ambient refusal names what could not be resolved
//       and writes nothing; the held card names the plan's own from; the
//       confirm re-derives from the connector's records.
//
//  Run:  ~/.bun/bin/bun run scripts/model-transition/prove-transition-daemon-facts.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
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

const seat = await import('../../src/services/engine-connector/daemonConnector.ts')
const preview = await import('../../src/services/providers/transitionPreview.ts')

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
    JSON.stringify({ effective: withRecord.effective, source: withRecord.effectiveSource }),
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
    JSON.stringify({ effective: ambient.effective, source: ambient.effectiveSource }),
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
  check("the plan's from is the SESSION's model, not the screen's", overSession.from === 'claude-sonnet-4-6')
  check(
    'lossy over the session history, lossless over the empty screen history — the disagreement the old wiring collapsed',
    overSession.needsChoice === true && overScreen.needsChoice === false,
    JSON.stringify({ session: overSession.needsChoice, screen: overScreen.needsChoice, counts: overSession.counts }),
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
  check('identical inputs build byte-identical plan digests', a.planDigest === b.planDigest, `${a.planDigest} vs ${b.planDigest}`)
}

section('§4 the wiring, structural')
{
  const model = readFileSync(join(import.meta.dir, '../../src/commands/model/model.tsx'), 'utf8')
  check(
    "the daemon arm plans from the CONNECTOR's facts and records",
    /carrier === 'daemon'[\s\S]{0,900}modelFacts\(\)[\s\S]{0,900}previewForSelection\(sessionMessages, sessionFacts\.effective, target\)/.test(model),
  )
  check(
    'the ambient refusal names what could not be resolved and builds no plan',
    model.includes("effectiveSource === 'ambient'") && model.includes('no live facts and no recorded model'),
  )
  check("the held card names the plan's own from for a daemon carrier", model.includes('heldIsDaemon ? held.plan.from : effective'))
  check(
    "the confirm re-derives from the SAME source the plan was built from",
    /confirmMessages[\s\S]{0,400}reconfirmTransitionPlan\(held\.plan, confirmMessages\)/.test(model),
  )
  const connector = readFileSync(join(import.meta.dir, '../../src/services/engine-connector/daemonConnector.ts'), 'utf8')
  check('the connector stamps the source beside the fallback chain', connector.includes("this.facts !== null ? 'live' : this.record.modelKey !== undefined ? 'record' : 'ambient'"))
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ prove-transition-daemon-facts — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ prove-transition-daemon-facts — all checks pass')
process.exit(0)
