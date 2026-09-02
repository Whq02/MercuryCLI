#!/usr/bin/env bun
// ============================================================================
//  repro-continuity — reproducer (EXPECT-RED until M8).
//
//  The gap this repro pins: the ACP wire carries workbench attention + relations
//  (`_mercury/workbench`), but no surface can resolve the canonical crew
//  directory — same AgentId, session descriptors, conversation ids and
//  unread cursors — so cockpit/Console/Minerva/Workbench/ACP/VS Code cannot
//  agree on identity, and restart continuity has no owner to restore from.
// ============================================================================
import { readFileSync } from 'node:fs'
import { checker } from '../engine-durability/harness.ts'

const t = checker()

t.section('CS-23 — the crew directory crosses the ACP wire')
const server = readFileSync('src/services/acp/acpServer.ts', 'utf8')
t.check(
  'the `_mercury/crew` extension method is registered',
  /_mercury\/crew/.test(server),
  'acpServer.ts registers no crew-directory wire',
)

t.section('CS-23 — cross-surface resolution (live once the projection exists)')
let mod: Record<string, unknown> | null = null
try {
  mod = (await import('../../src/services/crew/projection.ts')) as Record<string, unknown>
} catch {
  mod = null
}
const probe = mod?.__continuityLawsForProof as
  | undefined
  | (() => Promise<{
      sameAgentIdEverySurface: boolean
      deliberateSameThreadSameCursor: boolean
      restartPreservesIdentityAndCursor: boolean
    }>)
const r = typeof probe === 'function' ? await probe() : null
t.check('the continuity law probe exists (__continuityLawsForProof)', r !== null)
t.check('every surface resolves the same canonical AgentId', r?.sameAgentIdEverySurface === true)
t.check('deliberately opening one thread from two surfaces agrees on id + cursor', r?.deliberateSameThreadSameCursor === true)
t.check('restart preserves identity, title, unread cursor', r?.restartPreservesIdentityAndCursor === true)

t.finish('repro-continuity')
