#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-bus-addressing.ts
//  PROOF: bus ADDRESSES are one identity.
//    A. canonicalizeBusTarget truth table — every historical display name /
//       alias resolves to the canonical inbox; unknown names pass through
//       un-rewritten; unmanaged (crew) teams are never touched.
//    B. Drift guards — BUS_TEAM_LEAD_NAME mirrors swarm TEAM_LEAD_NAME; the
//       send seams (SendMessageTool + controlServer envelope ingress) and the
//       nameplate renderer are source-locked onto busIdentity.
//    C. healAliasInboxes — stranded alias mail MOVES to the canonical inbox
//       (original timestamps kept), is idempotent, and the case-insensitive-FS
//       self-guard never duplicates the canonical file onto itself.
//    D. buildBackAgentUserFrame — a stale (healed/held) dispatch carries the
//       lateness note; a fresh one does not.
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-bus-addressing.ts
// ============================================================================
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

// Isolated config home BEFORE any src import that might resolve it lazily.
const HOME = mkdtempSync(join(tmpdir(), 'bus-addressing-'))
process.env.MERCURY_CONFIG_DIR = HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const bus = await import('../../src/utils/scribe/busIdentity.js')
const swarm = await import('../../src/utils/swarm/constants.js')
const bridge = await import('../../src/daemon/scribeDispatchBridge.js')
const mailbox = await import('../../src/utils/teammateMailbox.js')
const scribeBus = await import('../../src/utils/scribe/scribeBus.js')

// ── A. the truth table ──────────────────────────────────────────────────────
section('A. canonicalizeBusTarget truth table')
const t = (team: string | null, raw: string, name: string, known: boolean): void => {
  const r = bus.canonicalizeBusTarget(team, raw)
  check(`${team ?? '∅'} · '${raw}' → '${r.name}' (known=${r.known})`, r.name === name && r.known === known, `want '${name}'/${known}`)
}
// scribe: every era's display name + sloppy forms → implementer
t('scribe', 'implementer', 'implementer', true)
t('scribe', 'IMPLEMENTER', 'implementer', true)
t('scribe', 'Mercury-Implement', 'implementer', true)
t('scribe', '[Mercury-Implement]', 'implementer', true)
t('scribe', ' mercury-implement ', 'implementer', true)
t('scribe', '@implementer', 'implementer', true)
t('scribe', 'the  Implementer', 'implementer', true)
t('scribe', 'implementer@scribe', 'implementer', true)
// sanitize-images: writeToMailbox shears spaces/'@' to '-' in
// inbox FILENAMES — the heal resolves basenames, so every alias must match
// its own sanitized form.
t('scribe', 'the-implementer', 'implementer', true)
t('scribe', 'implementer-scribe', 'implementer', true)
t('scribe', 'the-scribe', 'team-lead', true)
t('party', 'the-router', 'tank', true)
t('party', 'the-maintainer', 'team-lead', true)
// scribe: the reply direction → team-lead
t('scribe', 'Mercury-Amanuensis', 'team-lead', true)
t('scribe', 'the scribe', 'team-lead', true)
t('scribe', 'Team Lead', 'team-lead', true)
// scribe: unknown stays untouched + unknown
t('scribe', 'bob', 'bob', false)
t('scribe', '', '', false)
// party
t('party', 'Router', 'tank', true)
t('party', 'the router', 'tank', true)
t('party', 'executor2', 'dps2', true)
t('party', 'lane-3', 'dps3', true)
t('party', 'Maintainer', 'team-lead', true)
t('party', 'dps1', 'dps1', true)
t('party', 'stranger', 'stranger', false)
// unmanaged teams: NEVER rewritten, even for names the tables know
t('crew', 'Mercury-Implement', 'Mercury-Implement', false)
t(null, 'implementer', 'implementer', false)
check('isManagedBusTeam', bus.isManagedBusTeam('scribe') && bus.isManagedBusTeam('party') && !bus.isManagedBusTeam('crew') && !bus.isManagedBusTeam(null))
check('knownBusTargets(scribe) names the drains', bus.knownBusTargets('scribe').includes('implementer') && bus.knownBusTargets('scribe').includes('team-lead'))

// ── B. drift guards ─────────────────────────────────────────────────────────
section('B. drift guards (leaf mirror + send-seam source locks)')
check('BUS_TEAM_LEAD_NAME mirrors swarm TEAM_LEAD_NAME', bus.BUS_TEAM_LEAD_NAME === swarm.TEAM_LEAD_NAME)
const srcOf = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')
const sendTool = srcOf('tools', 'SendMessageTool', 'SendMessageTool.ts')
check('sendScribeEnvelope canonicalizes', sendTool.includes('canonicalizeBusTarget(teamName, targetName)'))
check('sendScribeEnvelope fails closed on unknown directives', sendTool.includes('!resolvedTarget.known && isManagedBusTeam(teamName)'))
const ingress = srcOf('daemon', 'controlServer.ts')
check('envelope ingress canonicalizes', ingress.includes('canonicalizeBusTarget(team, rawTo)'))
check('envelope ingress refuses unknown managed targets', ingress.includes('!resolvedTo.known && isManagedBusTeam(team)'))
const nameplate = srcOf('components', 'messages', 'UserTeammateMessage.tsx')
check('nameplate renderer derives from busIdentity', nameplate.includes("from '../../utils/scribe/busIdentity.js'") && nameplate.includes('IMPLEMENTER_DISPLAY_NAME'))
const pack = srcOf('utils', 'scribe', 'scribePack.ts')
check("scribe pack teaches the canonical address (to: 'implementer')", pack.includes(`to: "implementer"`))

// ── C. healAliasInboxes ─────────────────────────────────────────────────────
section('C. healAliasInboxes — stranded alias mail recovers; self-guard holds')
const inboxDir = join(HOME, 'teams', 'scribe', 'inboxes')
mkdirSync(inboxDir, { recursive: true })
const strandedEnv = scribeBus.buildDispatch('team-lead', 'liveness check — say pong', { title: 'liveness' })
const strandedTs = '2026-07-06T20:50:54.386Z'
writeFileSync(
  join(inboxDir, 'Mercury-Implement.json'),
  JSON.stringify([{ from: 'team-lead', text: JSON.stringify(strandedEnv), timestamp: strandedTs, read: false }], null, 2),
)
const moved = await bridge.healAliasInboxes('implementer', 'scribe')
check('moves the stranded dispatch (1)', moved === 1, `moved=${moved}`)
const canonUnread = await mailbox.readUnreadMessages('implementer', 'scribe')
check('canonical inbox now holds it unread', canonUnread.length === 1)
// Outer record ts is stamped NOW (glance visibility — the epoch filter must
// see a healed strand); the LATENESS signal keys on the envelope's INNER
// timestamp, which the move never touches.
check('outer record ts stamped fresh (glance-visible past the epoch)', Date.parse(canonUnread[0]?.timestamp ?? '') > Date.now() - 60_000)
check('inner envelope ts preserved (lateness honesty feeds off it)', JSON.parse(canonUnread[0]?.text ?? '{}').timestamp === JSON.parse(JSON.stringify(strandedEnv)).timestamp)
const aliasUnread = await mailbox.readUnreadMessages('Mercury-Implement', 'scribe')
check('alias inbox drained (marked read)', aliasUnread.length === 0)
const again = await bridge.healAliasInboxes('implementer', 'scribe')
check('idempotent (second heal moves 0)', again === 0, `moved=${again}`)
// Self-guard: a basename that case-folds to the canonical name IS the canonical
// file on APFS — healing it would append the file onto itself.
const before = readFileSync(join(inboxDir, 'implementer.json'), 'utf-8')
const guard = await bridge.healAliasInboxes('implementer', 'scribe') // 'Implementer.json' === 'implementer.json' here
const after = readFileSync(join(inboxDir, 'implementer.json'), 'utf-8')
check('case-fold self-guard: canonical file untouched', guard === 0 && before === after)
check('unmanaged team heals nothing', (await bridge.healAliasInboxes('anyone', 'crew')) === 0)

// ── D. lateness note ────────────────────────────────────────────────────────
section('D. stale-dispatch lateness note')
const stale = scribeBus.buildDispatch('team-lead', 'old work', {})
;(stale as { timestamp: string }).timestamp = new Date(Date.now() - 25 * 60_000).toISOString()
const staleFrame = bridge.buildBackAgentUserFrame(stale)
check('25-min-old dispatch carries the lateness note', staleFrame.includes('[delivered ~') && staleFrame.includes('min after it was dispatched'))
const fresh = scribeBus.buildDispatch('team-lead', 'new work', {})
check('fresh dispatch has no lateness note', !bridge.buildBackAgentUserFrame(fresh).includes('[delivered ~'))

// ── E. held-twin mark guard ───────────────
section('E. held-twin guard — a held dispatch is never marked read by its deduped twin')
// Two records, SAME request_id (the socket-fallback re-journal shape), on a
// BUSY implementer: batch-dedup marks the twin, back-pressure holds the
// original. The old id-keyed mark predicate swept BOTH — refined work marked
// read while it never reached stdin.
const twinEnv = scribeBus.buildDispatch('team-lead', 'held twin work', { title: 'twin' })
const twinRecord = (ts: string) => ({ from: 'team-lead', text: JSON.stringify(twinEnv), timestamp: ts, read: false })
writeFileSync(
  join(inboxDir, 'implementer.json'),
  JSON.stringify([twinRecord('2026-07-06T22:00:00.000Z'), twinRecord('2026-07-06T22:00:01.000Z')], null, 2),
)
const busyRoster = { reply: async () => { throw new Error('never called — busy') } }
const heldDelivered = await bridge.drainScribeDispatches(busyRoster, {
  short: 'implementer', agentName: 'implementer', teamName: 'scribe',
  isBusy: () => true, // back-pressure holds everything
})
check('busy drain delivers nothing', heldDelivered === 0)
const afterHold = await mailbox.readUnreadMessages('implementer', 'scribe')
check('held dispatch SURVIVES unread (the loss window closed)', afterHold.length >= 1, `unread=${afterHold.length}`)
// Idle next pass: it delivers and everything marks.
let stdinFrames = 0
const idleRoster = { reply: async () => { stdinFrames++; return true } }
const idleDelivered = await bridge.drainScribeDispatches(idleRoster, {
  short: 'implementer', agentName: 'implementer', teamName: 'scribe',
  isBusy: () => false,
})
check('idle drain delivers exactly one twin', idleDelivered === 1 && stdinFrames === 1, `delivered=${idleDelivered}`)
check('all twin records consumed after delivery', (await mailbox.readUnreadMessages('implementer', 'scribe')).length === 0)

rmSync(HOME, { recursive: true, force: true })
console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ ${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('✅ bus addressing — ALL CHECKS PASS')
