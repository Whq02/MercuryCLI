#!/usr/bin/env bun
// ============================================================================
//  scripts/session-graph/prove-ownership-inventory.ts — the M10 caller
//  inventory + zero-caller ratchet.
//
//  Every crew-family export that is a PRODUCTION surface names its expected
//  production consumers here; the ratchet fails when a consumer disappears
//  (the severed-loop class — a hardened subsystem quietly losing its last
//  caller) or when a NEW crew export ships without an inventory row.
//  Internal helpers/types and proof-only seams (law probes, test resets) are
//  inventoried as such — a proof-only row that gains no production caller by
//  its milestone is a finding, never a silent pass.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const t = checker()

/** export → the production files that must keep consuming it (repo-relative). */
const INVENTORY: Record<string, string[]> = {
  // identity.ts
  'ensureAgentIdentity': ['src/services/crew/seatBridge.ts'],
  'resolveAgent': ['src/services/crew/seatBridge.ts', 'src/utils/artifacts/reviewStore.ts'],
  'bindAgent': ['src/services/crew/seatBridge.ts'],
  'registerAgentSession': ['src/services/crew/seatBridge.ts'],
  'endAgentSession': ['src/services/crew/seatBridge.ts'],
  // the session runner boots its crew identity (every session is a full
  // Mercury instance; the screen is the face and boots none)
  'bootCrewIdentity': ['src/cli/print.ts'],
  'crewStoreRoot': ['src/services/crew/conversations.ts', 'src/services/crew/descriptor.ts', 'src/services/crew/dispatch.ts', 'src/services/crew/minervaHandoff.ts'],
  'crewDirectoryEnabled': ['src/commands/crew/index.ts', 'src/services/crew/seatBridge.ts'],
  'displayLabelsOf': ['src/services/crew/projection.ts'],
  // projection.ts
  'resolveCrewSnapshot': ['src/commands/crew/index.ts', 'src/services/acp/acpServer.ts', 'src/services/crew/graph.ts', 'src/services/crew/targetPicker.ts', 'src/services/resources/adapters/crew.ts'],
  // seatBridge.ts
  'attachExternalSeat': ['src/commands/crew/index.ts'],
  'detachExternalSeat': ['src/commands/crew/index.ts'],
  'cancelSeatTurn': ['src/commands/crew/index.ts'],
  'renegotiateSeat': ['src/commands/crew/index.ts'],
  'deliverToSeat': ['src/services/crew/dispatch.ts'],
  'seatOfAgent': ['src/services/crew/dispatch.ts'],
  'listAttachedSeats': ['src/commands/crew/index.ts', 'src/services/crew/targetPicker.ts'],
  // dispatch.ts
  'listDeliveryReceipts': ['src/commands/crew/index.ts'],
  // conversations.ts
  'mintConversation': ['src/services/crew/consoleHandoff.ts', 'src/services/crew/minervaHandoff.ts', 'src/services/crew/identity.ts'],
  'appendConversationEvent': ['src/services/crew/consoleHandoff.ts', 'src/services/crew/dispatch.ts', 'src/services/crew/minervaHandoff.ts'],
  'upsertUnresolvedEvent': ['src/services/crew/dispatch.ts', 'src/utils/artifacts/reviewStore.ts'],
  'resolveEventByRef': ['src/services/crew/dispatch.ts', 'src/utils/artifacts/reviewStore.ts'],
  'linkConversation': ['src/services/crew/consoleHandoff.ts'],
  // AGENTDIALS C6's operator re-key: legacy-keyed read positions move onto
  // the canonical operator principal at identity boot (dynamic import — the
  // consumer spells the symbol in its destructure).
  'rekeyOperatorRecords': ['src/services/crew/identity.ts'],
  'listReadCursors': ['src/services/acp/acpServer.ts'],
  // inbox.ts
  'deriveInbox': ['src/services/acp/acpServer.ts'],
  // consoleHandoff.ts
  'openSideConversation': ['src/utils/cockpit/helmConsole.ts'],
  'recordSideOutcome': ['src/utils/cockpit/helmConsole.ts'],
  // (switchboard close audit): the one-time ambient→switchboard-scope
  // fold, consumed at the board's first obligations read.
  'foldLegacyObligationsIntoSwitchboardScope': ['src/services/concourse/concourseSnapshot.ts'],
  // minervaHandoff.ts
  'stageRefinedDraft': ['src/utils/tabula/minerva.ts'],
  // targetPicker.ts
  'targetPickerRows': ['src/commands/crew/index.ts'],
  // descriptor.ts
  'publishSessionDescriptor': ['src/services/crew/identity.ts', 'src/services/crew/seatBridge.ts'],
  'retireSessionDescriptor': ['src/services/crew/seatBridge.ts'],
  'listSessionDescriptors': ['src/commands/crew/index.ts', 'src/services/acp/acpServer.ts'],
  'renderSessionTitle': ['src/commands/crew/index.ts', 'src/services/acp/acpServer.ts'],
  // graph.ts
  'assembleSessionGraph': ['src/services/acp/acpServer.ts'],
  // activity.ts
  'ingestActivity': ['src/services/crew/seatBridge.ts', 'src/utils/artifacts/reviewStore.ts'],
  'activityRows': ['src/commands/crew/index.ts'],
  'cachedActivityFeed': ['src/commands/crew/index.ts'],
  'activityLineOf': ['src/commands/crew/index.ts'],
  // capabilities.ts
  'authorizeCapability': ['src/services/crew/dispatch.ts', 'src/services/crew/seatBridge.ts'],
  'capabilitiesOf': ['src/commands/crew/index.ts', 'src/services/crew/seatBridge.ts'],
  // obligations.ts (: durable needs-you rows — the dispatch
  // seam raises/settles; the bridge projects them into attention)
  'upsertObligation': ['src/services/crew/dispatch.ts'],
  'resolveObligationByRef': ['src/services/crew/dispatch.ts'],
  'openObligations': ['src/services/crew/obligationsBridge.ts', 'src/hooks/useObligationSignals.ts'],
  // The Concourse answer flow is the named consumer (the move —
  // out of the dated classification, exactly as recorded there).
  'resolveObligation': ['src/components/concourse/ConcourseRoute.tsx'],
  'obligationOf': ['src/components/concourse/ConcourseRoute.tsx'],
  'subscribeObligations': ['src/services/crew/obligationsBridge.ts', 'src/hooks/useObligationSignals.ts'],
  // notificationPolicy.ts: the §7 layer writes emission/ack THROUGH
  // the obligation owner (per-obligation state, never a second store).
  'noteObligationEmission': ['src/services/notificationPolicy.ts'],
  'acknowledgeObligation': ['src/services/notificationPolicy.ts'],
}

const ROOT = join(import.meta.dir, '..', '..')
const cache = new Map<string, string>()
const read = (rel: string): string => {
  if (!cache.has(rel)) {
    try {
      cache.set(rel, readFileSync(join(ROOT, rel), 'utf8'))
    } catch {
      cache.set(rel, '')
    }
  }
  return cache.get(rel)!
}

/** The file that DEFINES a symbol can never count as its consumer — the
 *  export declaration itself matches any text regex, making a self-row an
 *  unfailable tautology (final audit). */
const definesSymbol = (rel: string, sym: string): boolean =>
  new RegExp(`export (?:async )?(?:function|const) ${sym}\\b`).test(read(rel))

t.section('§1 — every inventoried consumer still consumes')
{
  let broken = 0
  for (const [sym, consumers] of Object.entries(INVENTORY)) {
    for (const rel of consumers) {
      if (definesSymbol(rel, sym)) {
        t.check(`'${sym}' row names its OWN defining file as the consumer`, false, `${rel} defines it — a tautology, not a consumer`)
        broken++
        continue
      }
      if (!new RegExp(`\\b${sym}\\b`).test(read(rel))) {
        t.check(`'${sym}' consumed by ${rel}`, false, 'the consumer no longer references it — a severed loop')
        broken++
      }
    }
  }
  t.check('no severed production loops (and no self-file tautology rows)', broken === 0, `${broken} broken row(s)`)
}

t.section('§2 — no NEW crew export ships without an inventory row')
{
  const KNOWN_NON_PRODUCTION = new Set([
    // law probes + test seams + pure types/constants/helpers consumed via the
    // inventoried surfaces; the validator below only inspects FUNCTION exports.
    '__identityLawsForProof', '__continuityLawsForProof', '__dispatchLawsForProof',
    '_resetCrewIdentityBootForTesting', '_resetSeatBridgeForTesting', '_resetCapabilitiesForTesting',
    '_resetActivityFeedForTesting', '_resetCrewProjectionForTesting',
    'migrateLegacyIdentities', 'readIdentityMigrationReceipt', // boot-internal + prover-read
    'subscribeCrewIdentity', 'subscribeConversations', 'subscribeCrew', 'subscribeSessionDescriptors', // projection taps
    'isCrewProjectionArmed', // dormancy observable (prover-pinned)
    'agentOf', 'listAgents', 'listAgentBindings', 'listAgentRoles', 'listAgentSessions', // registry reads via projection
    'linkAgentRole', // migration-consumed (migrateLegacyIdentities) + role surfaces
    'endAgentRole', 'renameAgent', // PROOF-ONLY today (law probe + provers) — pending a named follow-on surface (/crew rename, role close verbs); the audit keeps them visible here, never silently 'migration'
    // Resolve/
    // obligationOf MOVED to real rows (the Concourse answer flow — the
    // recorded obligation, done). The REMAINING pair gains its named
    // consumers at: redirectObligation rides the coordinator redirect
    // receipt; listObligations rides the board history view. The
    // zero-prover-only close still forbids finishing the with
    // these here.
    'redirectObligation', 'listObligations',
    '_resetObligationsBridgeForTesting', // reset seam (the standard class)
    'obligationFacts', // pure translation exported for the prover; production consumes it through the same-file module-scope gatherer registration
    // SURFACE RETIRED: the
    // WORK/workbench board was the ONLY production consumer of these crew
    // verbs (the dispatch composer, the inbox cursors, the staged-draft
    // handoff, the activity feed subscription). The owners stay for the
    // retire-or-adopt decision; listed here so a
    // severed loop reads as NAMED, never as an inventory row with no consumer.
    'useCrew', 'dispatchToAgent', 'dispositionLabelOf', 'resolveConversationEvent', 'commitReadCursor',
    'setConversationPriority', 'handOffSideConversation', 'listStagedDrafts', 'markStagedDispatched',
    'dismissStagedDraft', 'dispatchableTargets', 'subscribeActivityFeed',
    'compareInboxRows', 'oldestUnresolvedOf', // inbox-internal (deriveInbox sorts; the opening-law helper rides the continuity law probe)
    'cachedCrewSnapshot', // projection-internal cached read
    'readDeliveryReceipt', // dispatch-internal read
    'deriveInboxRow', // inbox-internal per-row fold (deriveInbox is the surface)
    'attachedSeatOf', // seat read beside listAttachedSeats (prover-pinned)
    'conversationOf', 'listConversations', 'readCursorOf', // registry reads via surfaces
    'stagedDraftOf', // prover-pinned read beside listStagedDrafts
    'readSessionDescriptor', // read API beside list
    'recordCapabilities', 'invalidateCapabilities', 'forgetCapabilities', 'capabilityStateOf', // bridge-internal
    'registerActivityClassifier', 'classifyActivity', 'activityIdOf', 'activityClassifierOrder',
    'foldActivity', 'emptyActivityFeed', 'explodeActivityInputs', // classifier internals (prover-pinned)
    'claudeCodeSeatTransport', 'codexSeatTransport', 'acpSeatTransport', // consumed by /crew attach (inventoried via attachExternalSeat)
    'claudeCodeDeclaredCapabilities', 'codexDeclaredCapabilities', 'acpDeclaredCapabilities',
    'realNdjsonChild', 'awaitLine', 'mulberry32', 'buildCrewFixture',
  ])
  const crewDir = join(ROOT, 'src', 'services', 'crew')
  const missing: string[] = []
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
    )
  for (const file of walk(crewDir)) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/export (?:async )?function (\w+)/g)) {
      const name = m[1]!
      if (!(name in INVENTORY) && !KNOWN_NON_PRODUCTION.has(name)) missing.push(name)
    }
  }
  t.check(
    'every crew function export is inventoried or classified',
    missing.length === 0,
    missing.join(', '),
  )
}

t.finish('prove-ownership-inventory')
