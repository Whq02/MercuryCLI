#!/usr/bin/env bun
// gate-watch: src/sessions/mneme/mnemeGates.ts src/sessions/mneme/memoryVerbs.ts src/sessions/mneme/mnemeBuffer.ts
// gate-watch: src/sessions/mneme/mnemeConsolidate.ts src/platform/substrate/flagRegistry.ts src/platform/substrate/startupMenu.ts
// gate-watch: src/integrations/mcp/coordinationServer.ts src/permissions/capability/declarations.ts src/engine/turn-entry/stopHooks.ts
// gate-watch: src/sessions/mneme/** src/tools/memory/** src/screen/memory/** src/commands/memory/** src/permissions/capability/**
// gate-watch: src/screen/cockpit/awaySummary.ts src/screen/cockpit/branchHeadSync.ts src/screen/cockpit/cockpitActivity.ts src/screen/cockpit/commandPopup.ts src/screen/cockpit/composerSeed.ts src/screen/cockpit/crewView.ts src/screen/cockpit/crewmateWords.ts src/screen/cockpit/critterData.ts src/screen/cockpit/critterGaze.ts src/screen/cockpit/critterIdle.ts src/screen/cockpit/critterVariant.ts src/screen/cockpit/deviceHeadroom.ts src/screen/cockpit/filesMenu.ts src/screen/cockpit/freshness.ts src/screen/cockpit/gitSnapshot.ts src/screen/cockpit/greetingShimmer.ts src/screen/cockpit/helmFocus.ts src/screen/cockpit/hoverOwner.ts src/screen/cockpit/inputSelectionBridge.ts src/screen/cockpit/liveGlyphs.ts src/screen/cockpit/modelPickerPopup.ts src/screen/cockpit/motionGovernor.ts src/screen/cockpit/motionSetting.ts src/screen/cockpit/oasisBg.ts src/screen/cockpit/pointerCell.ts src/screen/cockpit/pointerShape.ts src/screen/cockpit/popupOwnsKeys.ts src/screen/cockpit/promptProvenance.ts src/screen/cockpit/realConversation.ts src/screen/cockpit/recessBackdrop.ts src/screen/cockpit/repoSurfaceMap.ts src/screen/cockpit/runtimePosture.ts src/screen/cockpit/settingsPopup.ts src/screen/cockpit/toolVerb.ts src/screen/cockpit/traceSnapshot.ts src/screen/cockpit/turnReceipt.ts src/screen/cockpit/turnSignals.ts src/screen/cockpit/types.ts src/screen/cockpit/typingActivity.ts src/screen/cockpit/uiClock.ts src/screen/cockpit/usageActivity.ts src/screen/cockpit/warmBackground.ts src/screen/cockpit/wrapPlain.ts src/screen/cockpit/zenMode.ts src/integrations/mcp/InProcessTransport.ts src/integrations/mcp/anthropicConnectors.ts src/integrations/mcp/auth.ts src/integrations/mcp/automationAccess.ts src/integrations/mcp/automationBridge.ts src/integrations/mcp/automationGateway.ts src/integrations/mcp/automationServer.ts src/integrations/mcp/client.ts src/integrations/mcp/client/** src/integrations/mcp/configPaths.ts src/integrations/mcp/dateTimeParser.ts src/integrations/mcp/disabledRecord.ts src/integrations/mcp/dynamicMcpSeed.ts src/integrations/mcp/elicitationHandler.ts src/integrations/mcp/elicitationValidation.ts src/integrations/mcp/envExpansion.ts src/integrations/mcp/eraVerdictCache.ts src/integrations/mcp/kitCompletion.ts src/integrations/mcp/kitDial.ts src/integrations/mcp/kitStore.ts src/integrations/mcp/lazyStdio.ts src/integrations/mcp/liveConfig.ts src/integrations/mcp/mcpOutputStorage.ts src/integrations/mcp/mcpOutputTruncation.ts src/integrations/mcp/membership.ts src/integrations/mcp/mercuryServer.ts src/integrations/mcp/oauthPort.ts src/integrations/mcp/presetStore.ts src/integrations/mcp/protocolRevision.ts src/integrations/mcp/renderTuiTool.ts src/integrations/mcp/serverConfigs.ts src/integrations/mcp/serverHeaders.ts src/integrations/mcp/sessionKitPin.ts src/integrations/mcp/stdioCommandSafety.ts src/integrations/mcp/toolsAnswer.ts src/integrations/mcp/utils.ts src/platform/substrate/** src/engine/turn-entry/scriptedStream.ts src/engine/turn-entry/startTurn.ts src/engine/turn-entry/stopHooks.ts src/engine/turn-entry/transitions.ts src/engine/turn-entry/turnAnswerContext.ts src/engine/turn-entry/turnLoopDeps.ts src/engine/attachment-shapes/attachmentMessage.ts src/engine/attachment-shapes/attachmentTypes.ts src/engine/attachment-shapes/capsuleKinds.ts src/engine/attachment-shapes/capsuleState.ts src/engine/attachment-shapes/dateAndModeNotices.ts src/engine/attachment-shapes/fileReadDenied.ts src/engine/attachment-shapes/mentions.ts src/engine/attachment-shapes/missionStatus.ts src/engine/attachment-shapes/samplesRoad.ts src/engine/attachment-shapes/skillListing.ts src/engine/attachment-shapes/taskStatus.ts src/engine/attachment-shapes/userContext.ts
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'mercury-memory-always-on-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
for (const name of Object.keys(process.env)) {
  if (/^MERCURY_(MNEME|MEMORY_OBSERVE)$/.test(name)) delete process.env[name]
}

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { memoryVerbsEnabled, memoryVerbsWhyNot, retainItems } = await import('../../src/sessions/mneme/memoryVerbs.js')
const { appendObservation, readBuffer } = await import('../../src/sessions/mneme/mnemeBuffer.js')
const { maybeConsolidate, listTopicDocs } = await import('../../src/sessions/mneme/mnemeConsolidate.js')
const { FLAG_REGISTRY } = await import('../../src/platform/substrate/flagRegistry.js')
const { RetainTool, RecallTool, ReflectTool, CorrectTool } = await import('../../src/tools/memory/MemoryTools.js')

section('memory is on with nothing set in the environment')
check('the verbs are available', memoryVerbsEnabled() === true, memoryVerbsWhyNot() ?? '', 'memoryVerbsEnabled in src/sessions/mneme/memoryVerbs.ts must be true with no MERCURY_MNEME or MERCURY_MEMORY_OBSERVE set')
check('every memory tool answers isEnabled', [RetainTool, RecallTool, ReflectTool, CorrectTool].every(t => t.isEnabled()), '', 'isEnabled of each tool in src/tools/memory/MemoryTools.ts must not depend on an environment gate')
const lib = join(scratch, 'library')
check('a fact lands in the buffer', appendObservation({ text: 'the runtime deploys from mercury-working', source: 'proof', topicHint: 'deploy' }, lib) === true, '', 'appendObservation in src/sessions/mneme/mnemeBuffer.ts must accept a row and return true')
check('the buffer reads the row back', readBuffer(lib).length === 1, '', 'readBuffer in src/sessions/mneme/mnemeBuffer.ts must return the row appendObservation wrote')
const retained = retainItems([{ content: 'the owner signs as Whq02', topic: 'owner' }], { session: 'always-on' }, lib)
check('Retain stores', retained[0]?.status === 'stored', JSON.stringify(retained), 'retainItems in src/sessions/mneme/memoryVerbs.ts must store the item with no gate set')
const result = maybeConsolidate({ force: true, dir: lib })
check('consolidation runs', result.consolidated === true, result.reason, 'maybeConsolidate in src/sessions/mneme/mnemeConsolidate.ts must run when forced; the reason above says why it did not')
check('two topic pages exist', listTopicDocs(lib).length === 2, listTopicDocs(lib).map(d => d.id).join(','), 'maybeConsolidate in src/sessions/mneme/mnemeConsolidate.ts must write one topic page for each retained topic')

section('the gate words are gone')
const envNames = new Set(FLAG_REGISTRY.map(f => f.env))
check('the registry has no memory gate row', !envNames.has('MERCURY_MNEME') && !envNames.has('MERCURY_MEMORY_OBSERVE'), '', 'remove the MERCURY_MNEME and MERCURY_MEMORY_OBSERVE rows from FLAG_REGISTRY')

console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ MEMORY IS ON FOR EVERYONE' : `❌ ${failures} ALWAYS-ON CHECK(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
