#!/usr/bin/env bun
// ============================================================================
//  scripts/session-graph/prove-identity.ts — the M1 identity-registry laws.
//
//  Hermetic: the config home, the party-state dir and every
//  store this proof touches live in a mkdtemp scratch root — the calibration
//  machine is never read. Sections:
//
//    §1 mint + resolve      — binding routes, display text NEVER routes
//    §2 rename              — label-only; id, bindings, sessions survive
//    §3 name collision      — same visible name, distinct ids, disambiguated labels
//    §4 bindings            — multi-bind, alias-merge refusal, unknown-agent refusal
//    §5 roles               — links are topology, not identity; idempotent + closable
//    §6 sessions            — idempotent registration, parent lineage, bounded cap
//    §7 restart continuity  — a fresh read resolves the same ids (determinism)
//    §8 migration           — deterministic, receipted, idempotent
//    §9 the law probe       — the repro lane's probe agrees with the direct laws
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const t = checker()

const scratch = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'crew-identity-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_PARTY_STATE_DIR = join(scratch, 'party')
mkdirSync(join(scratch, 'home'), { recursive: true })
mkdirSync(join(scratch, 'party'), { recursive: true })

const identity = await import('../../src/services/crew/identity.ts')
const dir = join(scratch, 'crew-store')

t.section('§1 — mint + resolve: bindings route, display text never routes')
{
  const atlas = await identity.ensureAgentIdentity({
    displayName: 'Atlas',
    binding: { bindingKind: 'adapter', bindingId: 'ext-session-1', adapterKind: 'claude-code' },
    dir,
  })
  t.check('minted id wears the cw- shape', /^cw-[0-9a-f]{12}$/.test(atlas.agentId), atlas.agentId)
  const resolved = await identity.resolveAgent(
    { bindingKind: 'adapter', bindingId: 'ext-session-1' },
    { dir },
  )
  t.check('the binding resolves to the minted agent', resolved === atlas.agentId)
  const stringForm = await identity.resolveAgent('adapter:ext-session-1', { dir })
  t.check('the string binding form resolves identically', stringForm === atlas.agentId)
  const byName = await identity.resolveAgent('Atlas', { dir })
  t.check('a bare display name NEVER resolves', byName === null, String(byName))
  const byShapedName = await identity.resolveAgent('native:Atlas', { dir })
  t.check('a name-shaped binding with no record resolves null (never fuzzy)', byShapedName === null)
}

t.section('§2 — rename is label-only')
{
  const before = await identity.resolveAgent('adapter:ext-session-1', { dir })
  const renamed = await identity.renameAgent(before!, 'Atlas Prime', { dir })
  t.check('rename returns the updated identity', renamed?.displayName === 'Atlas Prime')
  t.check('rename preserves the agent id', renamed?.agentId === before)
  const after = await identity.resolveAgent('adapter:ext-session-1', { dir })
  t.check('the binding still routes to the SAME agent after rename', after === before)
  const missing = await identity.renameAgent('cw-000000000000' as never, 'X', { dir })
  t.check('renaming an unknown agent returns null, writes nothing', missing === null)
}

t.section('§3 — same visible name, different stable ids')
{
  const atlas2 = await identity.ensureAgentIdentity({
    displayName: 'Atlas Prime',
    binding: { bindingKind: 'adapter', bindingId: 'codex-session-9', adapterKind: 'codex' },
    dir,
  })
  const first = await identity.resolveAgent('adapter:ext-session-1', { dir })
  t.check('two agents with one visible name stay distinct', atlas2.agentId !== first)
  const labels = identity.displayLabelsOf(await identity.listAgents({ dir }))
  const labelValues = [...labels.values()]
  t.check(
    'displayLabelsOf disambiguates duplicates (labels unique)',
    new Set(labelValues).size === labelValues.length,
    labelValues.join(' | '),
  )
}

t.section('§4 — bindings: multi-bind + alias-merge refusal')
{
  const agentId = (await identity.resolveAgent('adapter:ext-session-1', { dir }))!
  const bound = await identity.bindAgent(
    agentId,
    { bindingKind: 'principal', bindingId: 'agent-atlas-probe' },
    { dir },
  )
  t.check('a second binding attaches to the same agent', bound.ok === true)
  const viaPrincipal = await identity.resolveAgent('principal:agent-atlas-probe', { dir })
  t.check('the agent resolves via BOTH bindings', viaPrincipal === agentId)
  const other = (await identity.resolveAgent('adapter:codex-session-9', { dir }))!
  const alias = await identity.bindAgent(
    other,
    { bindingKind: 'principal', bindingId: 'agent-atlas-probe' },
    { dir },
  )
  t.check(
    'a binding held by ANOTHER agent is refused (never a silent merge)',
    alias.ok === false && alias.reason === 'bound-to-other' && alias.boundTo === agentId,
  )
  const stillOurs = await identity.resolveAgent('principal:agent-atlas-probe', { dir })
  t.check('the refused alias wrote nothing', stillOurs === agentId)
  const ghost = await identity.bindAgent(
    'cw-000000000000' as never,
    { bindingKind: 'native', bindingId: 'seat:ghost' },
    { dir },
  )
  t.check('binding to an unknown agent is refused', ghost.ok === false && ghost.reason === 'unknown-agent')
  let humanRefused = false
  try {
    await identity.ensureAgentIdentity({
      displayName: 'Not A Teammate',
      binding: { bindingKind: 'principal', bindingId: 'op-1234567890ab' },
      dir,
    })
  } catch {
    humanRefused = true
  }
  t.check('an operator/guest principal can NEVER become a registry row', humanRefused)
}

t.section('§5 — roles are topology links, not identity')
{
  const agentId = (await identity.resolveAgent('adapter:ext-session-1', { dir }))!
  const l1 = await identity.linkAgentRole(agentId, 'party-seat', 'party:tank', { dir })
  const l2 = await identity.linkAgentRole(agentId, 'party-seat', 'party:tank', { dir })
  t.check('an identical active link is idempotent', l1.activeFrom === l2.activeFrom)
  await identity.linkAgentRole(agentId, 'worker', 'roster:probe', { dir })
  const roles = await identity.listAgentRoles(agentId, { dir })
  t.check('one agent holds several role links without becoming several agents', roles.length === 2)
  await identity.endAgentRole(agentId, 'party-seat', 'party:tank', { dir })
  const closed = (await identity.listAgentRoles(agentId, { dir })).find(r => r.role === 'party-seat')
  t.check('ending a role closes the link (activeUntil set)', typeof closed?.activeUntil === 'number')
  const still = await identity.resolveAgent('adapter:ext-session-1', { dir })
  t.check('identity survives role churn', still === agentId)
}

t.section('§6 — sessions: idempotent, lineage-linked, bounded')
{
  const agentId = (await identity.resolveAgent('adapter:ext-session-1', { dir }))!
  const s1 = await identity.registerAgentSession({ sessionId: 'sess-1', agentId, worktreeRef: '/wt/a' }, { dir })
  const s1again = await identity.registerAgentSession({ sessionId: 'sess-1', agentId }, { dir })
  t.check('re-registering a session id returns the SAME record', s1.startedAt === s1again.startedAt && s1again.worktreeRef === '/wt/a')
  const s2 = await identity.registerAgentSession(
    { sessionId: 'sess-2', agentId, parentSessionId: 'sess-1' },
    { dir },
  )
  t.check('a deliberately new session gets a new id on the SAME agent', s2.agentId === agentId && s2.sessionId !== s1.sessionId)
  t.check('parent lineage rides the session record', s2.parentSessionId === ('sess-1' as unknown))
  await identity.endAgentSession('sess-2', { dir })
  const sessions = await identity.listAgentSessions({ dir })
  const ended = sessions.find(s => s.sessionId === ('sess-2' as unknown))
  t.check('ending a session stamps endedAt', typeof ended?.endedAt === 'number')
}

t.section('§7 — restart continuity: determinism across a fresh open')
{
  // A "restart" is a fresh read of the same store — no in-memory state helps.
  const again = await identity.ensureAgentIdentity({
    displayName: 'whatever-the-adapter-says-now',
    binding: { bindingKind: 'adapter', bindingId: 'ext-session-1', adapterKind: 'claude-code' },
    dir,
  })
  const canonical = await identity.resolveAgent('adapter:ext-session-1', { dir })
  t.check('reconnect resolves the same agent, no duplicate', again.agentId === canonical)
  t.check('reconnect does not clobber the display name', again.displayName === 'Atlas Prime')
  const count = (await identity.listAgents({ dir })).length
  t.check('the registry still holds exactly the two probe agents', count === 2, String(count))
}

t.section('§8 — migration: deterministic, receipted, idempotent')
{
  const migDir = join(scratch, 'crew-migrated')
  const receipt = await identity.migrateLegacyIdentities({ dir: migDir })
  t.check('the receipt records the assistant principal', receipt.sources['assistant-principal'] === 1)
  t.check('the receipt records no other source (the assistant principal is the one legacy form)', Object.keys(receipt.sources).length === 1, Object.keys(receipt.sources).join(','))
  const mercury = await identity.resolveAgent('principal:agent-mercury', { dir: migDir })
  t.check('the main Mercury agent exists after migration', mercury !== null)
  const roles = mercury ? await identity.listAgentRoles(mercury, { dir: migDir }) : []
  t.check("the main agent carries the 'main' role link", roles.some(r => r.role === 'main'))
  const countA = (await identity.listAgents({ dir: migDir })).length
  const receipt2 = await identity.migrateLegacyIdentities({ dir: migDir })
  const countB = (await identity.listAgents({ dir: migDir })).length
  t.check('re-migration is idempotent (no duplicate agents)', countA === countB, `${countA} → ${countB}`)
  t.check('re-migration re-receipts honestly', receipt2.sources['assistant-principal'] === 1)
  const read = await identity.readIdentityMigrationReceipt({ dir: migDir })
  t.check('the receipt reads back', read !== null && read.migratedAt === receipt2.migratedAt)
  // The party-seat migration retired with the multiplayer estate (its
  // decode is removed; the guarded seat-resolution tail is gone with it —
  // the one-source checks above ARE the retirement's pin).
}

t.section('§9 — the law probe (the repro lane) agrees')
{
  const laws = await identity.__identityLawsForProof()
  t.check('renamePreservesId', laws.renamePreservesId)
  t.check('sameNameDistinct', laws.sameNameDistinct)
  t.check('reconnectNoDuplicate', laws.reconnectNoDuplicate)
  t.check('displayNeverRoutes', laws.displayNeverRoutes)
}

t.finish('prove-identity')
