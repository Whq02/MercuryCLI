#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'
import { codeOnlyText } from '../lib/codeText.ts'

const t = checker()

const INVENTORY: Record<string, string[]> = {
  'ensureAgentIdentity': ['src/services/crew/seatBridge.ts'],
  'resolveAgent': ['src/services/crew/seatBridge.ts', 'src/utils/artifacts/reviewStore.ts'],
  'bindAgent': ['src/services/crew/seatBridge.ts'],
  'registerAgentSession': ['src/services/crew/seatBridge.ts'],
  'endAgentSession': ['src/services/crew/seatBridge.ts'],
  'bootCrewIdentity': ['src/cli/run.ts'],
  'crewStoreRoot': ['src/services/crew/conversations.ts', 'src/services/crew/descriptor.ts', 'src/services/crew/dispatch.ts'],
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
  'mintConversation': ['src/services/crew/consoleHandoff.ts', 'src/services/crew/identity.ts'],
  'appendConversationEvent': ['src/services/crew/consoleHandoff.ts', 'src/services/crew/dispatch.ts'],
  'upsertUnresolvedEvent': ['src/services/crew/dispatch.ts', 'src/utils/artifacts/reviewStore.ts'],
  'resolveEventByRef': ['src/services/crew/dispatch.ts', 'src/utils/artifacts/reviewStore.ts'],
  'linkConversation': ['src/services/crew/consoleHandoff.ts'],
  'listReadCursors': ['src/services/acp/acpServer.ts'],
  'deriveInbox': ['src/services/acp/acpServer.ts'],
  'openSideConversation': ['src/utils/cockpit/helmConsole.ts'],
  'recordSideOutcome': ['src/utils/cockpit/helmConsole.ts'],
  'foldLegacyObligationsIntoSwitchboardScope': ['src/services/concourse/concourseSnapshot.ts'],
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
  'recordSettledObligation': ['src/daemon/permissionAsks.ts'],
  'resolveObligationByRef': ['src/services/crew/dispatch.ts'],
  'openObligations': ['src/services/crew/obligationsBridge.ts'],
  'resolveObligation': ['src/components/concourse/ConcourseRoute.tsx'],
  'obligationOf': ['src/components/concourse/ConcourseRoute.tsx'],
  'subscribeObligations': ['src/services/crew/obligationsBridge.ts'],
  'formatCrewmateMessages': ['src/cli/run.ts', 'src/utils/messages/attachmentText.ts', 'src/utils/crew/inProcessRunner.ts'],
  'createIdleNotification': ['src/utils/crew/crewmateInit.ts', 'src/utils/crew/inProcessRunner.ts'],
  'isIdleNotification': ['src/components/messages/AttachmentMessage.tsx', 'src/utils/attachments/crewmates.ts'],
  'createPermissionRequestMessage': ['src/utils/crew/permissionSync.ts'],
  'isPermissionResponse': ['src/utils/crew/inProcessRunner.ts'],
  'createSandboxPermissionRequestMessage': ['src/utils/crew/permissionSync.ts'],
  'createShutdownRequestMessage': ['src/tools/SendMessageTool/SendMessageTool.ts'],
  'isShutdownRequest': ['src/components/messages/ShutdownMessage.tsx', 'src/utils/crew/inProcessRunner.ts'],
  'createShutdownApprovedMessage': ['src/tools/SendMessageTool/SendMessageTool.ts', 'src/utils/crew/inProcessRunner.ts'],
  'isShutdownApproved': ['src/cli/run.ts', 'src/components/messages/AttachmentMessage.tsx', 'src/components/messages/UserCrewmateMessage.tsx', 'src/utils/attachments/crewmates.ts'],
  'createShutdownRejectedMessage': ['src/tools/SendMessageTool/SendMessageTool.ts'],
  'isShutdownRejected': ['src/components/messages/ShutdownMessage.tsx'],
  'isTaskAssignment': ['src/components/messages/TaskAssignmentMessage.tsx'],
  'isStructuredProtocolMessage': ['src/services/coordination/coordinationService.ts', 'src/utils/attachments/crewmates.ts'],
  'resolveShutdownApprovedVictim': ['src/cli/run.ts', 'src/utils/attachments/crewmates.ts'],
  'resolveShutdownRequestSender': ['src/utils/crew/inProcessRunner.ts'],
  'getLastPeerDmSummary': ['src/utils/crew/crewmateInit.ts', 'src/utils/crew/inProcessRunner.ts'],
  'crewRosterOf': ['src/components/mercury-ui/screens/CrewView.tsx'],
  'liveMessagesFor': ['src/tools/SendMessageTool/SendMessageTool.ts', 'src/utils/crew/crewClient.ts', 'src/utils/crew/inProcessRunner.ts'],
  'upsertLiveTask': ['src/services/coordination/coordinationService.ts'],
  'listLiveTasks': ['src/services/coordination/coordinationService.ts', 'src/services/crew/liveTasks.ts'],
  'setLiveBusy': ['src/services/coordination/coordinationService.ts', 'src/utils/crew/inProcessRunner.ts'],
  'listLiveBusy': ['src/services/coordination/coordinationService.ts'],
  'subscribeLiveComms': ['src/services/crew/liveTasks.ts'],
  'sendLiveMessage': ['src/tools/SendMessageTool/SendMessageTool.ts', 'src/services/coordination/coordinationService.ts', 'src/daemon/controlServer.ts'],
  'unreadLiveMessagesFor': ['src/daemon/dispatchDrain.ts', 'src/services/coordination/coordinationService.ts', 'src/utils/attachments/crewmates.ts'],
  'subscribeLiveMessagesFor': ['src/cli/run.ts', 'src/daemon/dispatchDrain.ts', 'src/utils/crew/inProcessRunner.ts'],
  'prepareLiveDelivery': ['src/cli/run.ts'],
  'wasLiveDeliveryHandled': ['src/cli/run.ts'],
  'acknowledgeLiveDelivery': ['src/cli/run.ts'],
  'markLiveMessagesFromRead': ['src/utils/crew/crewClient.ts'],
  'markLiveMessageRead': ['src/utils/crew/inProcessRunner.ts'],
  'markLiveMessagesReadWhere': ['src/daemon/dispatchDrain.ts', 'src/utils/attachments/crewmates.ts'],
  'listLiveCommsTasks': ['src/utils/tasks.ts'],
  'subscribeLiveCommsTasks': ['src/utils/tasks.ts'],
  'crewClaimWords': ['src/utils/crew/leaseGuard.ts'],
  'crewClaimConflict': ['src/utils/crew/leaseGuard.ts'],
  'crewClaimScopeConflict': ['src/utils/crew/leaseGuard.ts'],
}

const ROOT = join(import.meta.dir, '..', '..')
const cache = new Map<string, string>()
const read = (rel: string): string => {
  if (!cache.has(rel)) {
    try {
      cache.set(rel, codeOnlyText(rel, readFileSync(join(ROOT, rel), 'utf8')))
    } catch {
      cache.set(rel, '')
    }
  }
  return cache.get(rel)!
}

const definesSymbolIn = (code: string, sym: string): boolean =>
  new RegExp(`export (?:async )?(?:function|const) ${sym}\\b`).test(code)
const definesSymbol = (rel: string, sym: string): boolean => definesSymbolIn(read(rel), sym)
const referencesSymbolIn = (code: string, sym: string): boolean => new RegExp(`\\b${sym}\\b`).test(code)
const functionExportsIn = (code: string): string[] =>
  [...code.matchAll(/export (?:async )?function (\w+)/g)].map(m => m[1]!)

t.section('§0 — the inventories read CODE, never comments')
{
  const consumerReal = "import { seatOfAgent } from './seatBridge.js'\nexport function route(id: string) { return seatOfAgent(id) }\n"
  const consumerDestructure = "export async function boot() { const { listReadCursors } = await import('./conversations.js'); listReadCursors() }\n"
  const consumerCommentOnly = "// seatOfAgent used to be called here\n/* and seatOfAgent is mentioned in this block */\nexport function route(id: string) { return id }\n"
  const definerCommentOnly = "// export function seatOfAgent(id: string) {}\n/** export const seatOfAgent = 1 */\nexport function other() {}\n"
  const definerReal = "export function seatOfAgent(id: string) { return id }\n"
  const code = (text: string): string => codeOnlyText('fixture.ts', text)
  t.check('a real import reference counts as consuming', referencesSymbolIn(code(consumerReal), 'seatOfAgent'))
  t.check('a dynamic-import destructure counts as consuming', referencesSymbolIn(code(consumerDestructure), 'listReadCursors'))
  t.check('a symbol that survives ONLY in comments does NOT count as consuming', !referencesSymbolIn(code(consumerCommentOnly), 'seatOfAgent'))
  t.check('a raw-text read WOULD have counted the comment-only mention (the fault this section guards)', referencesSymbolIn(consumerCommentOnly, 'seatOfAgent'))
  t.check('a comment-only export declaration is NOT a definition', !definesSymbolIn(code(definerCommentOnly), 'seatOfAgent'))
  t.check('a raw-text read WOULD have called the comment-only export a definition', definesSymbolIn(definerCommentOnly, 'seatOfAgent'))
  t.check('a real export declaration is a definition', definesSymbolIn(code(definerReal), 'seatOfAgent'))
  t.check('the crew-export walk ignores a comment-only function export', functionExportsIn(code(definerCommentOnly)).join(',') === 'other')
  t.check('the raw crew-export walk WOULD have listed the comment-only export', functionExportsIn(definerCommentOnly).includes('seatOfAgent'))
}

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
      if (!referencesSymbolIn(read(rel), sym)) {
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
    '_faultSourceForProofs',
    '_statsForProofs',
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
    'setConversationPriority', 'handOffSideConversation',
    'dispatchableTargets', 'subscribeActivityFeed',
    'compareInboxRows', 'oldestUnresolvedOf',
    'cachedCrewSnapshot',
    'readDeliveryReceipt',
    'deriveInboxRow',
    'attachedSeatOf',
    'conversationOf', 'listConversations', 'readCursorOf',
    'readSessionDescriptor',
    'recordCapabilities', 'invalidateCapabilities', 'forgetCapabilities', 'capabilityStateOf',
    'registerActivityClassifier', 'classifyActivity', 'activityIdOf', 'activityClassifierOrder',
    'foldActivity', 'emptyActivityFeed',
    'claudeCodeSeatTransport', 'codexSeatTransport', 'acpSeatTransport',
    'claudeCodeDeclaredCapabilities', 'codexDeclaredCapabilities', 'acpDeclaredCapabilities',
    'realNdjsonChild', 'awaitLine', 'mulberry32', 'buildCrewFixture',
    'isPermissionRequest', 'createPermissionResponseMessage',
    'isSandboxPermissionRequest', 'createSandboxPermissionResponseMessage', 'isSandboxPermissionResponse',
    'isCrewPermissionUpdate', 'isModeSetRequest',
    'crewSeatId', 'seatFactsOf', 'crewmateRecordOf', 'seatRecordOf', 'crewRosterOrder',
    'crewRosterBusy',
    'isCrewSeatId', 'crewRosterByName',
    'liveCommsKey', 'liveCommsPath', 'postLiveMessage', 'mutateLiveMessages', 'liveCrewOf', 'liveMessageKey',
    'readLiveComms',
    'markLiveMessagesRead',
    'liveCommsCrewKey', 'liveCommsTasksPath',
    'claimCrewFiles', 'listCrewClaims', 'subscribeCrewClaims',
    'crewClaimStorePath', 'releaseCrewClaims', 'sweepCrewClaims',
  ])
  const crewDir = join(ROOT, 'src', 'services', 'crew')
  const missing: string[] = []
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
    )
  for (const file of walk(crewDir)) {
    for (const name of functionExportsIn(codeOnlyText(file, readFileSync(file, 'utf8')))) {
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
