#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const t = checker()

const INVENTORY: Record<string, string[]> = {
  'ensureAgentIdentity': ['src/services/crew/seatBridge.ts'],
  'resolveAgent': ['src/services/crew/seatBridge.ts', 'src/utils/artifacts/reviewStore.ts'],
  'bindAgent': ['src/services/crew/seatBridge.ts'],
  'registerAgentSession': ['src/services/crew/seatBridge.ts'],
  'endAgentSession': ['src/services/crew/seatBridge.ts'],
  'bootCrewIdentity': ['src/cli/print.ts'],
  'crewStoreRoot': ['src/services/crew/conversations.ts', 'src/services/crew/descriptor.ts', 'src/services/crew/dispatch.ts', 'src/services/crew/minervaHandoff.ts'],
  'crewDirectoryEnabled': ['src/commands/crew/index.ts', 'src/services/crew/seatBridge.ts'],
  'displayLabelsOf': ['src/services/crew/projection.ts'],
  'resolveCrewSnapshot': ['src/commands/crew/index.ts', 'src/services/acp/acpServer.ts', 'src/services/crew/graph.ts', 'src/services/crew/targetPicker.ts', 'src/services/resources/adapters/crew.ts'],
  'attachExternalSeat': ['src/commands/crew/index.ts'],
  'detachExternalSeat': ['src/commands/crew/index.ts'],
  'cancelSeatTurn': ['src/commands/crew/index.ts'],
  'renegotiateSeat': ['src/commands/crew/index.ts'],
  'deliverToSeat': ['src/services/crew/dispatch.ts'],
  'seatOfAgent': ['src/services/crew/dispatch.ts'],
  'listAttachedSeats': ['src/commands/crew/index.ts', 'src/services/crew/targetPicker.ts'],
  'listDeliveryReceipts': ['src/commands/crew/index.ts'],
  'mintConversation': ['src/services/crew/consoleHandoff.ts', 'src/services/crew/minervaHandoff.ts', 'src/services/crew/identity.ts'],
  'appendConversationEvent': ['src/services/crew/consoleHandoff.ts', 'src/services/crew/dispatch.ts', 'src/services/crew/minervaHandoff.ts'],
  'upsertUnresolvedEvent': ['src/services/crew/dispatch.ts', 'src/utils/artifacts/reviewStore.ts'],
  'resolveEventByRef': ['src/services/crew/dispatch.ts', 'src/utils/artifacts/reviewStore.ts'],
  'linkConversation': ['src/services/crew/consoleHandoff.ts'],
  'rekeyOperatorRecords': ['src/services/crew/identity.ts'],
  'listReadCursors': ['src/services/acp/acpServer.ts'],
  'deriveInbox': ['src/services/acp/acpServer.ts'],
  'openSideConversation': ['src/utils/cockpit/helmConsole.ts'],
  'recordSideOutcome': ['src/utils/cockpit/helmConsole.ts'],
  'foldLegacyObligationsIntoSwitchboardScope': ['src/services/concourse/concourseSnapshot.ts'],
  'stageRefinedDraft': ['src/utils/tabula/minerva.ts'],
  'targetPickerRows': ['src/commands/crew/index.ts'],
  'publishSessionDescriptor': ['src/services/crew/identity.ts', 'src/services/crew/seatBridge.ts'],
  'retireSessionDescriptor': ['src/services/crew/seatBridge.ts'],
  'listSessionDescriptors': ['src/commands/crew/index.ts', 'src/services/acp/acpServer.ts'],
  'renderSessionTitle': ['src/commands/crew/index.ts', 'src/services/acp/acpServer.ts'],
  'assembleSessionGraph': ['src/services/acp/acpServer.ts'],
  'ingestActivity': ['src/services/crew/seatBridge.ts', 'src/utils/artifacts/reviewStore.ts'],
  'activityRows': ['src/commands/crew/index.ts'],
  'cachedActivityFeed': ['src/commands/crew/index.ts'],
  'activityLineOf': ['src/commands/crew/index.ts'],
  'authorizeCapability': ['src/services/crew/dispatch.ts', 'src/services/crew/seatBridge.ts'],
  'capabilitiesOf': ['src/commands/crew/index.ts', 'src/services/crew/seatBridge.ts'],
  'upsertObligation': ['src/services/crew/dispatch.ts'],
  'resolveObligationByRef': ['src/services/crew/dispatch.ts'],
  'openObligations': ['src/services/crew/obligationsBridge.ts', 'src/hooks/useObligationSignals.ts'],
  'resolveObligation': ['src/components/concourse/ConcourseRoute.tsx'],
  'obligationOf': ['src/components/concourse/ConcourseRoute.tsx'],
  'subscribeObligations': ['src/services/crew/obligationsBridge.ts', 'src/hooks/useObligationSignals.ts'],
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
    '__identityLawsForProof', '__continuityLawsForProof', '__dispatchLawsForProof',
    '_resetCrewIdentityBootForTesting', '_resetSeatBridgeForTesting', '_resetCapabilitiesForTesting',
    '_resetActivityFeedForTesting', '_resetCrewProjectionForTesting',
    'migrateLegacyIdentities', 'readIdentityMigrationReceipt',
    'subscribeCrewIdentity', 'subscribeConversations', 'subscribeCrew', 'subscribeSessionDescriptors',
    'isCrewProjectionArmed',
    'agentOf', 'listAgents', 'listAgentBindings', 'listAgentRoles', 'listAgentSessions',
    'linkAgentRole',
    'endAgentRole', 'renameAgent',
    'redirectObligation', 'listObligations',
    '_resetObligationsBridgeForTesting',
    'obligationFacts',
    'useCrew', 'dispatchToAgent', 'dispositionLabelOf', 'resolveConversationEvent', 'commitReadCursor',
    'setConversationPriority', 'handOffSideConversation', 'listStagedDrafts', 'markStagedDispatched',
    'dismissStagedDraft', 'dispatchableTargets', 'subscribeActivityFeed',
    'compareInboxRows', 'oldestUnresolvedOf',
    'cachedCrewSnapshot',
    'readDeliveryReceipt',
    'deriveInboxRow',
    'attachedSeatOf',
    'conversationOf', 'listConversations', 'readCursorOf',
    'stagedDraftOf',
    'readSessionDescriptor',
    'recordCapabilities', 'invalidateCapabilities', 'forgetCapabilities', 'capabilityStateOf',
    'registerActivityClassifier', 'classifyActivity', 'activityIdOf', 'activityClassifierOrder',
    'foldActivity', 'emptyActivityFeed', 'explodeActivityInputs',
    'claudeCodeSeatTransport', 'codexSeatTransport', 'acpSeatTransport',
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
