#!/usr/bin/env bun
// ============================================================================
//  scripts/engine-connector/prove-connector-contract.ts — the door census.
//
//  The EngineConnectorV1 contract is the document the daemon-hosted session
//  builds to: its door set is pinned here, mechanically, the way the
//  bootstrap facade's export census is pinned. Adding or removing a door is
//  a deliberate, prover-updating act. Every implementation (the daemon-hosted
//  session, the resting no-session connector) answers EVERY door, and the
//  focused-chat slot RESTS on no session — never on a pre-seeded chat, never
//  on an engine (the one-door law; the seeded blank chat retired).
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

// Hermetic config home: the identity door reads the config store.
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'connector-contract-'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

// ── the pinned door set (V1) ────────────────────────────────────────────────
const DOORS = [
  'sessionId',
  'sendWords',
  'records',
  'subscribeRecords',
  'turnActive',
  'asks',
  'subscribeAsks',
  'answerAsk',
  'settleAsk',
  'interrupt',
  'modelFacts',
  'subscribeModel',
  'setModel',
  'usage',
  'identity',
  'skillsRoster',
  'mcpRoster',
  'workRoster',
  'subscribeWork',
  'permissionMode',
  'subscribePermissionMode',
  'setPermissionMode',
  'workspace',
  'dispatchSlash',
  // steer-removal follow-up: the delivery door's ADDRESSED form — a note
  // to one agent inside the session's runner (same identity/exactly-once
  // laws as sendWords; the attention reply lane's one road).
  'sendAgentNote',
  // (The eight queue doors — queue/subscribeQueue/enqueue/removeQueued/
  // clearQueue/restageQueuedPrompt/popAllEditable/popNewestEditable — died
  // with the operator-facing holding pen, the steer-removal ruling: a
  // sent message is delivered instantly and read at the session's next
  // readable moment, exactly once. prove-one-truth-delivery.ts pins their
  // ABSENCE call-shaped; a door returning here is a deliberate act that
  // re-trues both provers.)
  // The coordinator's launch_session births sessions wearing a
  // named preset — the kit rides the connector as its own door.
  'setKit',
  'checkpointFacts',
  'subscribeCheckpoints',
  'rewind',
  // The spawn switches ride the connector as their own doors: the seat
  // reads them and applies a flip while agents alone hold the turn.
  'spawnSwitches',
  'setSpawnSwitch',
] as const

// 1. The interface declares exactly these doors (order-free set equality).
{
  const source = readFileSync(join(process.cwd(), 'src/services/engine-connector/types.ts'), 'utf8')
  const ifaceMatch = /export interface EngineConnectorV1 \{([\s\S]*?)\n\}/.exec(source)
  check('types.ts declares EngineConnectorV1', ifaceMatch !== null)
  if (ifaceMatch) {
    const body = ifaceMatch[1]!
    const declared = new Set(
      [...body.matchAll(/^\s{2}(?:readonly\s+)?(\w+)\s*[(:]/gm)].map(m => m[1]!).filter(n => n !== 'carrier'),
    )
    const missing = DOORS.filter(d => !declared.has(d))
    const extra = [...declared].filter(d => !(DOORS as readonly string[]).includes(d))
    check('every pinned door is declared', missing.length === 0, missing.join(', '))
    check('no undeclared door rides along', extra.length === 0, extra.join(', '))
  }
}

// 2. Every implementation answers every door; the slot RESTS on no session
//    (the no-session connector — not a chat) and never on an engine.
//    Poison = the retired default: a lazily minted blank chat for the boot
//    workspace (a chat existing off the board).
{
  const { NoSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
  const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.ts')
  const { getFocusedSessionConnector, hasFocusedSession, releaseFocusedSessionConnector, setFocusedSessionConnector } = await import(
    '../../src/services/engine-connector/focusedConnector.ts'
  )
  const resting = new NoSessionConnector()
  const seat = new DaemonSessionConnector({
    sessionId: '00000000-0000-4000-8000-000000000001',
    runnerId: 'concourse-w1',
    title: 'census',
    projectLabel: 'scratch',
    workspaceId: '/scratch/nowhere',
    home: process.env.MERCURY_CONFIG_DIR!,
  })
  for (const door of DOORS) {
    check(`the resting slot answers ${door}`, typeof (resting as unknown as Record<string, unknown>)[door] === 'function')
    check(`the daemon-hosted session answers ${door}`, typeof (seat as unknown as Record<string, unknown>)[door] === 'function')
  }
  check("both carriers read 'daemon' — one kind of session", resting.carrier === 'daemon' && seat.carrier === 'daemon')
  // The MCP roster answers serializable name+state ROWS (the lead-ratified
  // contract evolution): a session inside the concourse answers from its
  // own process, so no live client object may cross the doorway.
  const typesSource = readFileSync(join(process.cwd(), 'src/services/engine-connector/types.ts'), 'utf8')
  check('the MCP roster carries name+state rows (no live client crosses the doorway)', typesSource.includes('clients: readonly McpRosterEntryV1[]'))
  const boot = getFocusedSessionConnector()
  check('the focused slot rests on no session (no chat behind the boot menu)', !hasFocusedSession() && boot instanceof NoSessionConnector && boot.sessionId() === '')
  check('the resting slot owns no records and no turn', boot.records().length === 0 && boot.turnActive() === false)
  // Handing the slot a session re-points it; closing it rests it again;
  // nothing returns to an engine.
  setFocusedSessionConnector(seat)
  check('handing the slot a session re-points it', getFocusedSessionConnector() === seat && hasFocusedSession())
  releaseFocusedSessionConnector()
  check('closing the chat rests the slot', !hasFocusedSession() && getFocusedSessionConnector() instanceof NoSessionConnector)
  const slotSource = readFileSync(join(process.cwd(), 'src/services/engine-connector/focusedConnector.ts'), 'utf8')
  check('the slot has no null arm on its set door and no engine behind the doors', !slotSource.includes('EngineConnectorV1 | null): void') && !slotSource.includes('inProcessConnector'))
  check('no pre-seeded chat is minted anywhere in the slot (the ghost is gone)', !slotSource.includes('NascentSessionConnector') && !slotSource.includes('bootChat'))
}

console.log(failures === 0 ? '\nALL LAWS HOLD' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
