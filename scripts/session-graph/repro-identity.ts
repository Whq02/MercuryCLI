#!/usr/bin/env bun
// ============================================================================
//  repro-identity — reproducer (EXPECT-RED until M1).
//
//  The gap this repro pins: no canonical agent-identity owner exists. The
//  channel Principal (src/services/channel/frame.ts) is an envelope author stamp;
//  branded AgentId (src/types/ids.ts) is a per-session subagent id; roster
//  seats and agent-metadata sidecars each carry their own notion. Nothing
//  gives one agent a durable identity that survives rename/reconnect/resume,
//  binds provider/adapter/principal forms, or migrates legacy records with a
//  receipt. M1 lands the owner at the path pinned HERE.
// ============================================================================
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const OWNER = '../../src/services/crew/identity.ts'

t.section('CS-02 — the canonical identity owner exists at its pinned path')
let mod: Record<string, unknown> | null = null
try {
  mod = (await import(OWNER)) as Record<string, unknown>
} catch {
  mod = null
}
t.check(
  'src/services/crew/identity.ts loads',
  mod !== null,
  mod ? 'loaded' : 'module absent — no canonical agent-identity owner',
)
t.check('the versioned record schema is declared (AGENT_IDENTITY_SCHEMA)', mod?.AGENT_IDENTITY_SCHEMA === 1)
t.check('one resolver exists (resolveAgent)', typeof mod?.resolveAgent === 'function')
t.check('identity minting exists (ensureAgentIdentity)', typeof mod?.ensureAgentIdentity === 'function')
t.check('binding registration exists (bindAgent)', typeof mod?.bindAgent === 'function')
t.check('role links are separate from bindings (linkAgentRole)', typeof mod?.linkAgentRole === 'function')
t.check('rename is label-only (renameAgent)', typeof mod?.renameAgent === 'function')

t.section('CS-02 — identity laws (live once the owner exists)')
if (mod) {
  const laws = mod.__identityLawsForProof as
    | undefined
    | (() => Promise<{
        renamePreservesId: boolean
        sameNameDistinct: boolean
        reconnectNoDuplicate: boolean
        displayNeverRoutes: boolean
      }>)
  const r = typeof laws === 'function' ? await laws() : null
  t.check('the law probe exists (__identityLawsForProof)', r !== null)
  t.check('rename preserves AgentId', r?.renamePreservesId === true)
  t.check('two agents with one visible name stay distinct', r?.sameNameDistinct === true)
  t.check('reconnect/resume resolves the same agent, no duplicate', r?.reconnectNoDuplicate === true)
  t.check('display text is never a routing key', r?.displayNeverRoutes === true)
} else {
  t.check('identity laws hold', false, 'owner absent')
}

t.section('CS-03 — deterministic migration with a receipt')
t.check(
  'legacy migration exists (migrateLegacyIdentities)',
  typeof mod?.migrateLegacyIdentities === 'function',
)
t.check(
  'the migration receipt reader exists (readIdentityMigrationReceipt)',
  typeof mod?.readIdentityMigrationReceipt === 'function',
)

t.finish('repro-identity')
