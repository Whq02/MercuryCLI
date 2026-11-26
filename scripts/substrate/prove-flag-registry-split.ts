#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { flagRegistryFiles, isFlagRegistryFile } from '../lib/flagRegistrySource.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const SELF = relative(ROOT, import.meta.path).replaceAll('\\', '/')
const HELPER = posix.join(posix.dirname(SELF), '..', 'lib', 'flagRegistrySource.ts')
const DOOR = flagRegistryFiles(ROOT)[0] ?? ''
const ROWS = `${posix.dirname(DOOR)}/flags`
const TYPES = `${ROWS}/spec.ts`
const TYPES_FROM = `./${posix.basename(TYPES).replace(/\.ts$/, '.js')}`
const CODE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const NAMED = new RegExp(`['"\`/\\\\]${posix.basename(ROWS)}['"\`/\\\\]`, 'i')
const CONSUMER_PATH = /(?:src|scripts|assets)\/[A-Za-z0-9_@./-]+/g
const SKIPPED = new Set(['node_modules', '.git', 'dist'])
const PACKS = 'vendor'
const OUT_OF_REACH = 'a path assembled at run time, and a path handed over in a variable that is no constant of the file, such as a loop over the list the helper returns'

const AREAS: Record<string, string> = {
  'src/commands/logins/': 'accounts.ts',
  'src/commands/logout/': 'accounts.ts',
  'src/commands/verbs/auth.ts': 'accounts.ts',
  'src/models/sign-in/credentials/auth.ts': 'accounts.ts',
  'src/models/sign-in/credentials/authFileDescriptor.ts': 'accounts.ts',
  'src/models/sign-in/oauth/': 'accounts.ts',
  'src/platform/secure-storage/': 'accounts.ts',
  'src/engine/requests/': 'api.ts',
  'src/engine/turn-entry/': 'api.ts',
  'src/models/roads/anthropic/anthropicClientFactory.ts': 'api.ts',
  'src/models/roads/anthropic/anthropicLimits.ts': 'api.ts',
  'src/models/roads/anthropic/mockRateLimits.ts': 'api.ts',
  'src/models/roads/capFailover.ts': 'api.ts',
  'src/models/roads/requestHeaders.ts': 'api.ts',
  'src/models/usage/anthropicUsageFetch.ts': 'api.ts',
  'src/platform/cache-clock/': 'api.ts',
  'src/platform/environment/envValidation.ts': 'api.ts',
  'src/platform/network/mtls.ts': 'api.ts',
  'src/platform/network/proxy.ts': 'api.ts',
  'assets/splash/': 'boot.ts',
  'scripts/release/': 'boot.ts',
  'src/boot/main.tsx': 'boot.ts',
  'src/boot/main/': 'boot.ts',
  'src/boot/process-state/': 'boot.ts',
  'src/platform/environment/envUtils.ts': 'boot.ts',
  'src/platform/substrate/durablePublish.ts': 'boot.ts',
  'src/platform/substrate/envStamps.ts': 'boot.ts',
  'src/platform/substrate/identity/': 'boot.ts',
  'src/platform/substrate/splashHandover.ts': 'boot.ts',
  'src/platform/substrate/startupMenu.ts': 'boot.ts',
  'src/platform/update-channel/': 'boot.ts',
  'src/screen/attention/agentNeedsYou.ts': 'cockpit.ts',
  'src/screen/cockpit-gauges/': 'cockpit.ts',
  'src/screen/cockpit/': 'cockpit.ts',
  'src/engine/compaction/': 'context.ts',
  'src/engine/rows/': 'context.ts',
  'src/engine/run/': 'context.ts',
  'src/engine/system-prompt/antiSycophancy.ts': 'context.ts',
  'src/engine/system-prompt/apolloMode.ts': 'context.ts',
  'src/engine/system-prompt/behaviourContract.ts': 'context.ts',
  'src/engine/system-prompt/composer.ts': 'context.ts',
  'src/engine/system-prompt/mercuryContract.ts': 'context.ts',
  'src/engine/system-prompt/recordedComposition.ts': 'context.ts',
  'src/models/roads/localPromptProfile.ts': 'context.ts',
  'src/screen/composer/useFoldWarningSuppression.ts': 'context.ts',
  'src/sessions/instructions/': 'context.ts',
  'src/commands/daemon/': 'daemon.ts',
  'src/daemon/': 'daemon.ts',
  'src/engine/connector/': 'daemon.ts',
  'src/integrations/browser/': 'desktop.ts',
  'src/integrations/desktop/': 'desktop.ts',
  'src/integrations/voice/': 'desktop.ts',
  'src/tools/browser/': 'desktop.ts',
  'src/tools/computer/': 'desktop.ts',
  'src/boot/startupProfiler.ts': 'health.ts',
  'src/commands/feedback/': 'health.ts',
  'src/commands/health/': 'health.ts',
  'src/integrations/media-flux/fluxProbe.ts': 'health.ts',
  'src/platform/health/healthFix.ts': 'health.ts',
  'src/platform/health/healthPreflight.ts': 'health.ts',
  'src/platform/health/healthReport.ts': 'health.ts',
  'src/platform/logs/errorLog.ts': 'health.ts',
  'src/platform/observability/frictionStopwatch.ts': 'health.ts',
  'src/platform/observability/invocationTrace.ts': 'health.ts',
  'src/screen/chat/submitTrace.ts': 'health.ts',
  'assets/vulcan/': 'ide.ts',
  'src/integrations/blender-protocol/': 'ide.ts',
  'src/integrations/debugger/': 'ide.ts',
  'src/integrations/ide/': 'ide.ts',
  'src/integrations/lsp/': 'ide.ts',
  'src/integrations/unity-protocol/': 'ide.ts',
  'src/integrations/vulcan-optable/optable.generated.ts': 'ide.ts',
  'src/integrations/vulcan/': 'ide.ts',
  'src/integrations/event-hooks/': 'mcp.ts',
  'src/integrations/extensions/': 'mcp.ts',
  'src/integrations/mcp-shapes/': 'mcp.ts',
  'src/integrations/mcp/': 'mcp.ts',
  'src/integrations/skills/': 'mcp.ts',
  'src/crew/capacity/': 'model.ts',
  'src/models/catalogue/': 'model.ts',
  'src/models/effort/effort.ts': 'model.ts',
  'src/models/effort/thinking.ts': 'model.ts',
  'src/models/facts/': 'model.ts',
  'src/models/roads/privacyLevel.ts': 'permissions.ts',
  'src/permissions/guards/': 'permissions.ts',
  'src/permissions/rules/': 'permissions.ts',
  'src/platform/processes/subprocessEnv.ts': 'permissions.ts',
  'src/crew/crewmates/': 'project.ts',
  'src/engine/tasks/local-agent/': 'project.ts',
  'src/integrations/resources/': 'project.ts',
  'src/integrations/samples/': 'project.ts',
  'src/platform/git-graph/': 'project.ts',
  'src/platform/git/worktree/worktreeClone.ts': 'project.ts',
  'src/platform/repo-host/': 'project.ts',
  'src/platform/verification/': 'project.ts',
  'src/screen/workbench/': 'project.ts',
  'src/sessions/artifacts/': 'project.ts',
  'src/sessions/mission/': 'project.ts',
  'src/sessions/notices/': 'project.ts',
  'src/sessions/project-intel/': 'project.ts',
  'src/tools/engines/': 'project.ts',
  'scripts/': 'proofs.ts',
  'src/models/roads/proofHomeGuard.ts': 'proofs.ts',
  'src/models/hosting/': 'providers.ts',
  'src/models/roads/': 'providers.ts',
  'src/platform/settings/compatEndpoints.ts': 'providers.ts',
  'src/boot/App.tsx': 'screen.ts',
  'src/boot/first-run/': 'screen.ts',
  'src/boot/setupScreens.tsx': 'screen.ts',
  'src/commands/appearance/ThemePicker.tsx': 'screen.ts',
  'src/commands/context/ContextSuggestions.tsx': 'screen.ts',
  'src/commands/context/ContextVisualization.tsx': 'screen.ts',
  'src/commands/critter/CritterSelect.tsx': 'screen.ts',
  'src/commands/exit/': 'screen.ts',
  'src/commands/export/ExportDialog.tsx': 'screen.ts',
  'src/commands/feedback/BugReport.tsx': 'screen.ts',
  'src/commands/llmhost/LlmHostDialog.tsx': 'screen.ts',
  'src/commands/localsetup/LocalSetupDialog.tsx': 'screen.ts',
  'src/commands/model/TransitionPreviewCard.tsx': 'screen.ts',
  'src/commands/model/picker/MercuryModelPicker.tsx': 'screen.ts',
  'src/commands/submodels/SubModelPicker.tsx': 'screen.ts',
  'src/commands/trace/TraceView.tsx': 'screen.ts',
  'src/commands/verbs/status.tsx': 'screen.ts',
  'src/engine/user-input/BashModeProgress.tsx': 'screen.ts',
  'src/models/sign-in/flow-cards/': 'screen.ts',
  'src/models/sign-in/gemini-connect/': 'screen.ts',
  'src/models/usage/CostThresholdDialog.tsx': 'screen.ts',
  'src/permissions/cards/': 'screen.ts',
  'src/platform/node-runtime/': 'screen.ts',
  'src/platform/observability/stats.tsx': 'screen.ts',
  'src/platform/shell/terminalHandback.ts': 'screen.ts',
  'src/screen/': 'screen.ts',
  'src/screen/app-state/mailbox.tsx': 'screen.ts',
  'src/screen/cockpit/cockpitActiveContext.tsx': 'screen.ts',
  'src/screen/keys/ConfigurableShortcutHint.tsx': 'screen.ts',
  'src/screen/notifications/notifications.tsx': 'screen.ts',
  'src/tools/crewmate/CrewmateProgressLine.tsx': 'screen.ts',
  'src/tools/edit/EditDiff.tsx': 'screen.ts',
  'src/tools/edit/EditUpdatedMessage.tsx': 'screen.ts',
  'src/tools/kit/FallbackToolUseErrorMessage.tsx': 'screen.ts',
  'src/tools/kit/FallbackToolUseRejectedMessage.tsx': 'screen.ts',
  'src/tools/kit/FilePathLink.tsx': 'screen.ts',
  'src/tools/kit/InlineChangeView.tsx': 'screen.ts',
  'src/tools/kit/MessageResponse.tsx': 'screen.ts',
  'src/tools/notebook-edit/NotebookEditRejectedMessage.tsx': 'screen.ts',
  'src/tools/write/FileEditToolUseRejectedMessage.tsx': 'screen.ts',
  'src/': 'session.ts',
  'src/boot/first-run/treeify.ts': 'session.ts',
  'src/boot/main/eventLoopStallDetector.ts': 'session.ts',
  'src/boot/main/heapClimb.ts': 'session.ts',
  'src/boot/main/worktreeModeEnabled.ts': 'session.ts',
  'src/commands/exit/exit.tsx': 'session.ts',
  'src/commands/exit/index.ts': 'session.ts',
  'src/crew/crewmates/crewIdentity.ts': 'session.ts',
  'src/crew/crewmates/crewmateView.ts': 'session.ts',
  'src/crew/crewmates/mailbox.ts': 'session.ts',
  'src/daemon/concourse-workers/concourseLifecycle.ts': 'session.ts',
  'src/daemon/concourse-workers/sessionKind.ts': 'session.ts',
  'src/daemon/concourse-workers/workerRole.ts': 'session.ts',
  'src/daemon/control/daemonStanddown.ts': 'session.ts',
  'src/daemon/control/directoryIdentity.ts': 'session.ts',
  'src/daemon/control/haltDecide.ts': 'session.ts',
  'src/daemon/control/ownerWatch.ts': 'session.ts',
  'src/daemon/lan/': 'session.ts',
  'src/daemon/process-sweep/processSweep.ts': 'session.ts',
  'src/daemon/runner-wire/': 'session.ts',
  'src/daemon/runner/': 'session.ts',
  'src/daemon/saturn/cron.ts': 'session.ts',
  'src/daemon/saturn/loopFire.ts': 'session.ts',
  'src/daemon/switchboard-capacity/capacityCheck.ts': 'session.ts',
  'src/daemon/tcp-bridge/entry.ts': 'session.ts',
  'src/engine/requests/imageValidation.ts': 'session.ts',
  'src/engine/requests/querySource.ts': 'session.ts',
  'src/engine/rows/turn/ledgerMark.ts': 'session.ts',
  'src/engine/tasks/local-agent/agentMessage.ts': 'session.ts',
  'src/engine/turn-entry/filesReadInMessages.ts': 'session.ts',
  'src/integrations/desktop/ansiSpans.ts': 'session.ts',
  'src/integrations/desktop/ansiToPng.ts': 'session.ts',
  'src/integrations/event-hooks/hookProgress.ts': 'session.ts',
  'src/integrations/extensions/load/argumentSubstitution.ts': 'session.ts',
  'src/integrations/ide/childSettle.ts': 'session.ts',
  'src/integrations/lsp/diagnosticTracking.ts': 'session.ts',
  'src/integrations/mcp/mcpInstructionsDelta.ts': 'session.ts',
  'src/integrations/mcp/mcpServer.ts': 'session.ts',
  'src/integrations/mcp/normalizeToolSchema.ts': 'session.ts',
  'src/models/facts/providerRoute.ts': 'session.ts',
  'src/models/facts/tokenEstimation.ts': 'session.ts',
  'src/models/roads/anthropic/anthropicWire.ts': 'session.ts',
  'src/models/roads/anthropic/connectorText.ts': 'session.ts',
  'src/models/roads/anthropic/rateLimitMessages.ts': 'session.ts',
  'src/models/roads/anthropic/rateLimitMocking.ts': 'session.ts',
  'src/models/roads/attributionHeader.ts': 'session.ts',
  'src/models/roads/betaHeaders.ts': 'session.ts',
  'src/models/roads/betas.ts': 'session.ts',
  'src/models/roads/inlineSchemaRefs.ts': 'session.ts',
  'src/models/roads/mediaLimits.ts': 'session.ts',
  'src/models/roads/toolSchemaCache.ts': 'session.ts',
  'src/models/roads/workloadContext.ts': 'session.ts',
  'src/permissions/rules/permissionModeListener.ts': 'session.ts',
  'src/permissions/rules/permissions.ts': 'session.ts',
  'src/permissions/rules/shell-commands/staticPrefix.ts': 'session.ts',
  'src/permissions/rules/thisMachine.ts': 'session.ts',
  'src/platform/shell/bash/': 'session.ts',
  'src/platform/shell/powershell/': 'session.ts',
  'src/platform/shell/powershellLiteral.ts': 'session.ts',
  'src/platform/shell/shellExec.ts': 'session.ts',
  'src/platform/shell/shellProcess.ts': 'session.ts',
  'src/screen/agents/useAgentsChange.ts': 'session.ts',
  'src/screen/app-state/': 'session.ts',
  'src/screen/attention/': 'session.ts',
  'src/screen/boot-face/bootCardFacts.ts': 'session.ts',
  'src/screen/chat/interruptKeys.ts': 'session.ts',
  'src/screen/chat/messagePredicates.ts': 'session.ts',
  'src/screen/chat/useAuthWallHold.ts': 'session.ts',
  'src/screen/chat/useCommandKeybindings.tsx': 'session.ts',
  'src/screen/chat/useFinishMarks.ts': 'session.ts',
  'src/screen/chat/useGlobalKeybindings.tsx': 'session.ts',
  'src/screen/chat/useSessionTitleMint.ts': 'session.ts',
  'src/screen/chat/useTurnEndPing.ts': 'session.ts',
  'src/screen/composer/anthropicLimitsHook.ts': 'session.ts',
  'src/screen/composer/exampleCommands.ts': 'session.ts',
  'src/screen/composer/history-search/': 'session.ts',
  'src/screen/composer/input-core/': 'session.ts',
  'src/screen/composer/suggestions.ts': 'session.ts',
  'src/screen/composer/text-input/inputRange.ts': 'session.ts',
  'src/screen/composer/text-input/keys.ts': 'session.ts',
  'src/screen/composer/text-input/useSearchInput.ts': 'session.ts',
  'src/screen/composer/text-input/useTextInput.ts': 'session.ts',
  'src/screen/composer/textHighlighting.ts': 'session.ts',
  'src/screen/composer/tokenBudgetMentions.ts': 'session.ts',
  'src/screen/composer/typeahead/': 'session.ts',
  'src/screen/composer/useArrowKeyHistory.tsx': 'session.ts',
  'src/screen/composer/useClipboardImageHint.ts': 'session.ts',
  'src/screen/composer/useCopyOnSelect.ts': 'session.ts',
  'src/screen/composer/useInputUndo.ts': 'session.ts',
  'src/screen/composer/usePasteHandler.ts': 'session.ts',
  'src/screen/composer/usePrStatus.ts': 'session.ts',
  'src/screen/composer/usePromptSuggestion.ts': 'session.ts',
  'src/screen/composer/vim/': 'session.ts',
  'src/screen/concourse-model/': 'session.ts',
  'src/screen/diff/gitDiff.ts': 'session.ts',
  'src/screen/diff/useDiffData.ts': 'session.ts',
  'src/screen/diff/useTurnDiffs.ts': 'session.ts',
  'src/screen/effects/': 'session.ts',
  'src/screen/extensions/useExtensions.ts': 'session.ts',
  'src/screen/focused-session/': 'session.ts',
  'src/screen/frame-rate/fpsTracker.ts': 'session.ts',
  'src/screen/fullscreen-layout/helmDensity.ts': 'session.ts',
  'src/screen/fullscreen-layout/helmGeometry.ts': 'session.ts',
  'src/screen/fullscreen-layout/pathLabel.ts': 'session.ts',
  'src/screen/fullscreen-layout/useLayoutTier.ts': 'session.ts',
  'src/screen/fullscreen-layout/useTerminalSize.ts': 'session.ts',
  'src/screen/highlighted-code/cliHighlight.ts': 'session.ts',
  'src/screen/keys/': 'session.ts',
  'src/screen/kit-menu-model/': 'session.ts',
  'src/screen/mcp/mcpServerApproval.tsx': 'session.ts',
  'src/screen/messages-list/chatRowOrder.ts': 'session.ts',
  'src/screen/messages-list/foldShellNotices.ts': 'session.ts',
  'src/screen/messages-list/streamToScreen.ts': 'session.ts',
  'src/screen/messages/ctrlOToExpandHint.ts': 'session.ts',
  'src/screen/messages/displayTags.ts': 'session.ts',
  'src/screen/messages/groupToolUses.ts': 'session.ts',
  'src/screen/messages/markdownText.ts': 'session.ts',
  'src/screen/messages/useFluxMountMark.ts': 'session.ts',
  'src/screen/model-picker/useCatalogueEpoch.ts': 'session.ts',
  'src/screen/model-picker/useDisplayedSessionModel.ts': 'session.ts',
  'src/screen/model-picker/useEngineModel.ts': 'session.ts',
  'src/screen/model-picker/useProviderUsageOnShow.ts': 'session.ts',
  'src/screen/notifications/': 'session.ts',
  'src/screen/prompt-suggestion/': 'session.ts',
  'src/screen/renderer/staticRender.tsx': 'session.ts',
  'src/screen/renderer/terminal-session/shutdownRestoration.ts': 'session.ts',
  'src/screen/session-chooser/crossProjectResume.ts': 'session.ts',
  'src/screen/session-chooser/sessionFilter.ts': 'session.ts',
  'src/screen/session-chooser/sessionResumeFilter.ts': 'session.ts',
  'src/screen/settings/useSettings.ts': 'session.ts',
  'src/screen/settings/useSettingsChange.ts': 'session.ts',
  'src/screen/slack-suggestions/slackChannelSuggestions.ts': 'session.ts',
  'src/screen/spinner/spinnerMode.ts': 'session.ts',
  'src/screen/spinner/turnCompletionVerbs.ts': 'session.ts',
  'src/screen/suggestions/': 'session.ts',
  'src/screen/theme/color.ts': 'session.ts',
  'src/screen/theme/glyphs.ts': 'session.ts',
  'src/screen/theme/rowGlyphs.ts': 'session.ts',
  'src/screen/theme/systemTheme.ts': 'session.ts',
  'src/screen/themedRenderer.ts': 'session.ts',
  'src/screen/tips/': 'session.ts',
  'src/screen/virtual-message-list/transcriptSearch.ts': 'session.ts',
  'src/screen/virtual-message-list/useVirtualScroll.ts': 'session.ts',
  'src/tools/crewmate/promptCategory.ts': 'session.ts',
  'src/tools/crewmate/run/worktreeReadiness.ts': 'session.ts',
  'src/tools/edit/call/editMatching.ts': 'session.ts',
  'src/tools/edit/call/typography.ts': 'session.ts',
  'src/tools/edit/readEditContext.ts': 'session.ts',
  'src/tools/engines/interview/': 'session.ts',
  'src/tools/glob/globPattern.ts': 'session.ts',
  'src/tools/glob/globPrefix.ts': 'session.ts',
  'src/tools/kit/': 'session.ts',
  'src/tools/read/binaryExtensions.ts': 'session.ts',
  'src/tools/read/call/fileReadLimits.ts': 'session.ts',
  'src/tools/read/pathPrefix.ts': 'session.ts',
  'src/tools/read/regularFile.ts': 'session.ts',
  'src/tools/sleep/newInputWatch.ts': 'session.ts',
  'src/tools/web-fetch/webUserAgent.ts': 'session.ts',
  'src/engine/messages/toolSearch.ts': 'tools.ts',
  'src/models/jev/': 'tools.ts',
  'src/permissions/rules/shell-commands/': 'tools.ts',
  'src/platform/files/windowsPaths.ts': 'tools.ts',
  'src/platform/shell/': 'tools.ts',
  'src/tools/': 'tools.ts',
  'src/tools/engines/eval-kernels/': 'tools.ts',
  'src/tools/engines/web-search/': 'tools.ts',
  'src/tools/kit/commandDisplay.ts': 'tools.ts',
  'src/tools/kit/documentText.ts': 'tools.ts',
  'src/tools/kit/gitOperationTracking.ts': 'tools.ts',
  'src/tools/kit/sessionEnvNotice.ts': 'tools.ts',
  'src/tools/kit/shellTools.ts': 'tools.ts',
  'src/tools/kit/timeouts.ts': 'tools.ts',
  'src/tools/kit/toolList.ts': 'tools.ts',
  'src/tools/kit/toolResultSummary.ts': 'tools.ts',
  'src/tools/kit/toolTable.ts': 'tools.ts',
  'src/tools/kit/toolUseIds.ts': 'tools.ts',
}

const ANCHORS: Record<string, string> = {
  MERCURY_AGENT_FANOUT_CAP: 'project.ts',
  MERCURY_PROVIDER_MANAGED_BY_HOST: 'providers.ts',
  MERCURY_TASKS: 'tools.ts',
}

type Row = { env: string; consumer: string }
type Kind = 'tree' | 'exports' | 'shape' | 'door-row' | 'served' | 'not-gathered' | 'file-order' | 'two-files' | 'anchor' | 'no-prefix' | 'wrong-file' | 'registry-order' | 'outside-import'
type Fault = { kind: Kind; text: string }
type Held = { file: string; rows: Row[]; alone: Row[] | null; literal: boolean }
type Reading = { faults: Fault[]; rows: number; files: [string, number][]; walked: number; parsed: number; by: string }
type Lister = (root: string) => string[] | null

let failures = 0
let inPlantedSection = false
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  const misread = !cond && inPlantedSection ? ' — a planted tree was misread: change judge, rowImports or shapeOf in ' + SELF : ''
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}${misread}`)
}
const section = (t: string): void => {
  inPlantedSection = t.startsWith('§0')
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const isRows = (value: unknown): value is Row[] =>
  Array.isArray(value) && value.every(row => typeof row === 'object' && row !== null && typeof (row as Row).env === 'string' && typeof (row as Row).consumer === 'string')
const low = (text: string): string => text.toLowerCase()
const underRows = (rel: string): boolean => low(rel) === low(ROWS) || low(rel).startsWith(`${low(ROWS)}/`)
const holds = (path: string, folder: string): boolean => `/${low(path)}/`.includes(`/${low(folder)}/`)

function walk(root: string, rel: string, out: string[]): void {
  let entries
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const path = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (entry.isDirectory()) {
      if (!SKIPPED.has(entry.name) && path !== PACKS) walk(root, path, out)
    } else if (entry.isFile() && CODE.test(entry.name)) out.push(path)
  }
}

const gitLists: Lister = root => {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[name]
  try {
    return execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 1 << 28, env, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0')
  } catch {
    return null
  }
}

function codeFiles(root: string, lists: Lister | null): { files: string[]; by: string } {
  const listed = (lists?.(root) ?? []).filter(file => CODE.test(file)).sort()
  if (listed.includes(SELF)) return { files: listed, by: 'tracked or new in the tree' }
  const files: string[] = []
  walk(root, '', files)
  return { files, by: 'found by a walk of the tree' }
}

function written(file: string, spec: string): string | null {
  const path = spec.replaceAll('\\', '/')
  if (/\s/.test(path)) return null
  if (path.startsWith('.')) {
    const target = posix.normalize(posix.join(posix.dirname(file), path))
    return underRows(target) ? target : null
  }
  return holds(posix.normalize(path), ROWS) ? path : null
}

function computed(file: string, at: ts.Node): string | null {
  const parts: string[] = []
  const gather = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) return
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const text = node.text.replaceAll('\\', '/')
      if (!/\s/.test(text)) parts.push(text)
    }
    ts.forEachChild(node, gather)
  }
  gather(at)
  const below = ROWS.slice(ROWS.indexOf('/') + 1)
  for (const part of [...parts, parts.join('/')]) {
    if (part.startsWith('.') && underRows(posix.normalize(posix.join(posix.dirname(file), part)))) return `a path built from '${part}'`
    const path = posix.normalize(part)
    if (holds(path, ROWS) || holds(path, below)) return `a path built from '${part}'`
  }
  return null
}

function rowImports(file: string, text: string): { line: number; what: string }[] {
  const kind = /\.(?:tsx|jsx)$/.test(file) ? ts.ScriptKind.TSX : /\.(?:js|mjs|cjs)$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
  const constants = new Map<string, ts.Expression>()
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined && (node.parent.flags & ts.NodeFlags.Const) !== 0 && !constants.has(node.name.text)) constants.set(node.name.text, node.initializer)
    ts.forEachChild(node, collect)
  }
  collect(source)
  const reach = (at: ts.Node, depth: number): string | null => {
    if (ts.isParenthesizedExpression(at) || ts.isAsExpression(at) || ts.isNonNullExpression(at) || ts.isSatisfiesExpression(at)) return reach(at.expression, depth)
    if (ts.isIdentifier(at)) {
      const held = constants.get(at.text)
      return held !== undefined && depth < 4 ? reach(held, depth + 1) : null
    }
    return ts.isStringLiteralLike(at) ? written(file, at.text) : computed(file, at)
  }
  const hits = new Map<number, string>()
  const site = (at: ts.Node, importing: boolean): void => {
    const what = reach(at, 0)
    const line = source.getLineAndCharacterOfPosition(at.getStart(source)).line + 1
    if (what !== null && !hits.has(line)) hits.set(line, importing ? `imports ${what}` : `passes ${what} to a call`)
  }
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) site(node.moduleSpecifier, true)
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) site(node.moduleReference.expression, true)
    else if (ts.isImportTypeNode(node)) site(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : node.argument, true)
    else if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments?.[0] !== undefined) {
      const callee = node.expression
      site(node.arguments[0], ts.isCallExpression(node) && (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return [...hits].map(([line, what]) => ({ line, what }))
}

function shapeOf(file: string, text: string): { shape: string[]; order: string[]; literal: boolean } {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const at = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  const shape: string[] = []
  const order: string[] = []
  const imports = source.statements.filter(ts.isImportDeclaration)
  for (const statement of imports) {
    const from = ts.isStringLiteralLike(statement.moduleSpecifier) ? statement.moduleSpecifier.text : ''
    if (!(statement.importClause?.isTypeOnly === true && from === TYPES_FROM)) shape.push(`${file}:${at(statement)} imports '${from}': a row file imports the type from '${TYPES_FROM}' and nothing else`)
  }
  if (imports.length === 0) shape.push(`${file} has no import: a row file imports the type from '${TYPES_FROM}'`)
  const rest = source.statements.filter(statement => !ts.isImportDeclaration(statement))
  const first = rest[0]
  const only = rest.length === 1 && first !== undefined && ts.isVariableStatement(first) && first.declarationList.declarations.length === 1 ? first : undefined
  const exported = only?.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
  const literal = exported ? only?.declarationList.declarations[0]?.initializer : undefined
  if (literal === undefined || !ts.isArrayLiteralExpression(literal)) {
    shape.push(`${file}: beside its import the file is not one exported array literal of rows: a call, a cast or a second statement stands there`)
    return { shape, order, literal: false }
  }
  let before = ''
  for (const element of literal.elements) {
    if (!ts.isObjectLiteralExpression(element)) {
      shape.push(`${file}:${at(element)} is no row written in the file: a spread or a call stands there`)
      continue
    }
    const env = element.properties.flatMap(property => (ts.isPropertyAssignment(property) && property.name.getText(source) === 'env' && ts.isStringLiteralLike(property.initializer) ? [property.initializer.text] : []))[0] ?? ''
    if (!(before < env)) order.push(`${file}:${at(element)} ${env} is written after ${before}: the rows of a file ascend by env as they are written`)
    before = env
  }
  return { shape, order, literal: true }
}

async function judge(root: string, areas: Record<string, string>, anchors: Record<string, string>, lists: Lister | null): Promise<Reading> {
  const faults: Fault[] = []
  const fault = (kind: Kind, text: string): void => {
    faults.push({ kind, text })
  }
  const load = async (path: string, name: string): Promise<Record<string, unknown> | null> => {
    try {
      return (await import(pathToFileURL(path).href)) as Record<string, unknown>
    } catch (error) {
      fault('tree', `${name} does not load: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`)
      return null
    }
  }

  const listed = flagRegistryFiles(root)
  let registry: Row[] = []
  if (!listed.includes(DOOR)) fault('tree', `${DOOR} is missing`)
  else {
    const door = await load(join(root, DOOR), DOOR)
    if (door !== null && isRows(door['FLAG_REGISTRY'])) registry = door['FLAG_REGISTRY']
    else if (door !== null) fault('tree', `${DOOR} exports no FLAG_REGISTRY array of rows`)
  }

  const held: Held[] = []
  const apart = mkdtempSync(join(tmpdir(), 'flag-registry-rows-alone-'))
  try {
    for (const file of listed) {
      if (file === DOOR || !file.endsWith('.ts')) continue
      const mod = await load(join(root, file), file)
      if (mod === null) continue
      const names = Object.keys(mod)
      if (file === TYPES) {
        if (names.length > 0) fault('exports', `${file} exports ${names.join(', ')}: it holds the types and exports no value`)
        continue
      }
      const arrays = names.map(name => mod[name]).filter(isRows)
      if (names.length !== 1 || arrays.length !== 1) fault('exports', `${file} has ${names.length} exports${names.length > 0 ? ` (${names.join(', ')})` : ''}: a file under ${ROWS} has one export, an array of rows`)
      const text = readFileSync(join(root, file), 'utf8')
      const read = shapeOf(file, text)
      for (const said of read.shape) fault('shape', said)
      for (const said of read.order) fault('file-order', said)
      let alone: Row[] | null = null
      if (read.shape.length === 0) {
        const copy = join(apart, file)
        mkdirSync(dirname(copy), { recursive: true })
        writeFileSync(copy, text)
        const second = await load(copy, `${file}, loaded alone from a copy`)
        if (second !== null) alone = Object.values(second).filter(isRows).flat()
      }
      held.push({ file, rows: arrays.flat(), alone, literal: read.literal })
    }
  } finally {
    rmSync(apart, { recursive: true, force: true })
  }
  const inFolder: string[] = []
  walk(root, ROWS, inFolder)
  for (const file of inFolder) {
    if (!file.endsWith('.ts')) fault('exports', `${file}: a code file under ${ROWS} whose name does not end .ts is read by no check: name it .ts or take it out`)
  }

  const home = new Map<Row, Held>()
  for (const file of held) for (const row of file.rows) home.set(row, file)
  const gathered = new Set(registry)
  const served = new Set(registry.map(row => row.env))
  for (const row of registry) {
    const at = home.get(row)
    if (at === undefined) {
      fault('door-row', `${row.env} is a row of the registry and of no file under ${ROWS}: write it in the file its consumer maps to, not in ${DOOR}`)
      continue
    }
    if (at.alone === null) continue
    const own = at.alone.find(other => other.env === row.env)
    if (own === undefined) fault('door-row', `${row.env} is a row of the registry and is not written in ${at.file}: loaded alone the file does not hold it, so it is put into the file's array from outside; write it in the file`)
    else if (JSON.stringify(own) !== JSON.stringify(row)) {
      const a = own as Record<string, unknown>
      const b = row as Record<string, unknown>
      const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(key => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
      fault('served', `${row.env}: the registry serves other values than ${at.file} writes (${fields.join(', ')}): a row is written in its file and changed nowhere else`)
    }
  }
  for (const { file, rows, alone } of held) {
    const loose = [...new Set([...rows.filter(row => !gathered.has(row)), ...(alone ?? []).filter(row => !served.has(row.env))].map(row => row.env))]
    if (loose.length > 0) fault('not-gathered', `${file} exports ${loose.length === 1 ? 'a row' : `${loose.length} rows`} the registry does not hold (${loose.slice(0, 3).join(', ')}${loose.length > 3 ? ', …' : ''}): gather its array in ${DOOR}`)
  }

  const table: [string, string, string][] = Object.entries(areas).map(([prefix, file]) => [prefix, file, 'AREAS'])
  const stands = new Map<string, string>()
  const seen = new Map<string, string | null>()
  const names = (rel: string, env: string): boolean => {
    let text = seen.get(rel)
    if (text === undefined) {
      try {
        text = readFileSync(join(root, rel), 'utf8')
      } catch {
        text = null
      }
      seen.set(rel, text)
    }
    return text !== null && text.includes(env)
  }
  const placedBy = (row: Row): string => {
    const paths = (row.consumer.match(CONSUMER_PATH) ?? []).map(path => path.replace(/\.+$/, ''))
    return paths.find(path => names(path, row.env)) ?? paths[0] ?? row.consumer
  }
  for (const [env, file] of Object.entries(anchors)) {
    const row = registry.find(other => other.env === env)
    if (row === undefined) fault('anchor', `${env} is named in ANCHORS of ${SELF} and is no row of the registry: take the line out, or name a row that stands`)
    else table.push([placedBy(row), file, `ANCHORS, where ${env} stands for its consumer,`])
  }
  for (const { file, rows, literal } of held) {
    rows.forEach((row, i) => {
      const before = rows[i - 1]
      if (!literal && before !== undefined && !(before.env < row.env)) fault('file-order', `${file}: ${row.env} stands after ${before.env}: the rows of a file ascend by env`)
      const other = stands.get(row.env)
      if (other !== undefined && other !== file) fault('two-files', `${row.env} stands in ${other} and in ${file}: an env has one row, in the file its consumer maps to`)
      stands.set(row.env, file)
      const by = placedBy(row)
      let best: [string, string, string] | undefined
      for (const entry of table) if (by.startsWith(entry[0]) && (best === undefined || entry[0].length > best[0].length)) best = entry
      if (best === undefined) fault('no-prefix', `${row.env} in ${file}: no prefix of AREAS in ${SELF} covers its consumer '${by}': add the prefix there, beside the file that holds the row`)
      else if (`${ROWS}/${best[1]}` !== file) fault('wrong-file', `${row.env} sits in ${file}: its consumer '${by}' maps to ${ROWS}/${best[1]} by the prefix '${best[0]}' of ${best[2]} in ${SELF}: move the row there`)
    })
  }

  registry.forEach((row, i) => {
    const before = registry[i - 1]
    if (before !== undefined && !(before.env < row.env)) fault('registry-order', `FLAG_REGISTRY: ${row.env} stands after ${before.env}: ${DOOR} sorts the gathered rows by env`)
  })

  const { files, by } = codeFiles(root, lists)
  let parsed = 0
  for (const file of files) {
    if (file === SELF || file === HELPER || isFlagRegistryFile(file)) continue
    let text: string
    try {
      text = readFileSync(join(root, file), 'utf8')
    } catch {
      continue
    }
    if (!NAMED.test(text)) continue
    parsed++
    for (const hit of rowImports(file, text)) fault('outside-import', `${file}:${hit.line} ${hit.what}: import from ${DOOR}`)
  }

  return { faults, rows: registry.length, files: held.map(h => [h.file, h.rows.length]), walked: files.length, parsed, by }
}

const kinds = (faults: Fault[]): string => faults.map(f => f.kind).join(' ')
const texts = (faults: Fault[]): string => faults.map(f => f.text).join(' | ')
const say = (faults: Fault[]): string => `${faults.length} found:` + faults.slice(0, 12).map(f => `\n      ${f.text}`).join('') + (faults.length > 12 ? `\n      … and ${faults.length - 12} more` : '')

section('§0 the checks on a planted tree: a tree with nothing wrong reads clean, and each fault is named')
{
  const A = `${ROWS}/a.ts`
  const B = `${ROWS}/b.ts`
  const C = `${ROWS}/c.ts`
  const SIDE = posix.dirname(DOOR)
  const CASED = `${SIDE}/${posix.basename(ROWS).replace(/^./, first => first.toUpperCase())}`
  const PLANTED: Record<string, string> = { 'src/a/': 'a.ts', 'src/a/deep/': 'b.ts', 'src/b/': 'b.ts', 'src/c/': 'c.ts' }
  const SORT = '.sort((a, b) => (a.env < b.env ? -1 : a.env > b.env ? 1 : 0))'
  const spec = (from: string, to: string): string => {
    const path = posix.relative(posix.dirname(from), to)
    return path.startsWith('.') ? path : `./${path}`
  }
  const js = (file: string): string => file.replace(/\.ts$/, '.js')
  const head = (file: string): string => `import type { FlagSpec } from '${spec(file, js(TYPES))}'`
  const rowsFile = (name: string, rows: [string, string][]): string =>
    [head(A), '', `export const ${name}: readonly FlagSpec[] = [`, ...rows.map(([env, consumer]) => `  { env: '${env}', consumer: '${consumer}' },`), ']', ''].join('\n')
  const doorFile = (names: string[], more = '', sorted = true, before = '', after = ''): string =>
    [
      ...names.map(name => `import { ${name.toUpperCase()}_FLAGS } from '${spec(DOOR, `${ROWS}/${name}.js`)}'`),
      '',
      before,
      `export const FLAG_REGISTRY = [${names.map(name => `...${name.toUpperCase()}_FLAGS`).join(', ')}${more}]${sorted ? SORT : ''}`,
      after,
      '',
    ].join('\n')
  const CLEAN: Record<string, string> = {
    [DOOR]: doorFile(['a', 'b']),
    [TYPES]: 'export interface FlagSpec {\n  env: string\n  consumer: string\n}\n',
    [A]: rowsFile('A_FLAGS', [['ALPHA_ONE', 'src/a/one.ts'], ['ALPHA_TWO', 'src/a/two.ts (and a note)']]),
    [B]: rowsFile('B_FLAGS', [['BETA_ONE', 'src/b/one.ts'], ['BETA_TWO', 'src/a/deep/two.ts']]),
    'src/a/reader.ts': `import { FLAG_REGISTRY } from '${spec('src/a/reader.ts', js(DOOR))}'\nexport const count = FLAG_REGISTRY.length\n`,
    'src/a/flags/local.ts': 'export const local = 1\n',
    'src/a/user.ts': `import { local } from './flags/local.js'\nexport const twice = local * 2\n`,
    'scripts/b/list.ts': `import { join } from 'node:path'\nimport { flagRegistryFiles } from '../lib/list.ts'\nfor (const rel of flagRegistryFiles(ROOT).slice(1)) await import(join(ROOT, rel))\n`,
    [SELF]: `const rows = await import('${spec(SELF, A)}')\nexport const seen = rows\n`,
    [`${ROWS}/.DS_Store`]: 'a leftover of the file manager\n',
    [`${ROWS}/notes.md`]: 'a note\n',
  }
  const planted = async (change: Record<string, string> = {}, lists: Lister | null = null, anchors: Record<string, string> = {}): Promise<Fault[]> => {
    const root = mkdtempSync(join(tmpdir(), 'flag-registry-split-'))
    try {
      for (const [rel, body] of Object.entries({ ...CLEAN, ...change })) {
        mkdirSync(dirname(join(root, rel)), { recursive: true })
        writeFileSync(join(root, rel), body)
      }
      return (await judge(root, PLANTED, anchors, lists)).faults
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  check(`the helper lists the door and takes a file under ${ROWS} as a registry file`, DOOR !== '' && isFlagRegistryFile(TYPES) && !isFlagRegistryFile(`${ROWS}.ts`), `door '${DOOR}'`)

  const none = await planted()
  check('a tree with nothing wrong reads clean: the door, a file of the folder, this proof, an import of the door, a folder of the same name elsewhere and a leftover in the folder that is no code are let through, and so is a script that imports every path the helper lists, which is out of reach', none.length === 0, texts(none))

  const doorRow = await planted({ [DOOR]: doorFile(['a', 'b'], `, { env: 'DOOR_ROW', consumer: 'src/a/late.ts' }`) })
  const BESIDE = `${SIDE}/more.ts`
  const beside = await planted({
    [BESIDE]: `export const MORE_FLAGS = [{ env: 'DELTA_ONE', consumer: 'src/a/more.ts' }]\n`,
    [DOOR]: `import { MORE_FLAGS } from '${spec(DOOR, js(BESIDE))}'\n${doorFile(['a', 'b'], ', ...MORE_FLAGS')}`,
  })
  check('a row written in the door is named, and so is a row the door gathers from a file beside the folder', kinds(doorRow) === 'door-row' && doorRow[0]!.text.startsWith('DOOR_ROW ') && kinds(beside) === 'door-row' && beside[0]!.text.startsWith('DELTA_ONE '), texts([...doorRow, ...beside]))

  const pushed = await planted({ [DOOR]: doorFile(['a', 'b'], '', true, `;(A_FLAGS as unknown[]).push({ env: 'ALPHA_PUSHED', consumer: 'src/a/pushed.ts' })\n`) })
  check("a row the door puts into a file's array is named: the file loaded alone does not hold it (hole 04)", kinds(pushed) === 'door-row' && pushed[0]!.text.startsWith(`ALPHA_PUSHED is a row of the registry and is not written in ${A}`), texts(pushed))

  const rewritten = await planted({ [DOOR]: doorFile(['a', 'b'], '', true, '', `Object.assign(FLAG_REGISTRY.find(row => row.env === 'ALPHA_ONE'), { consumer: 'src/a/rewritten.ts' })`) })
  check('a field the door rewrites after it gathers is named with the field (hole 05)', kinds(rewritten) === 'served' && rewritten[0]!.text.startsWith(`ALPHA_ONE: the registry serves other values than ${A} writes (consumer)`), texts(rewritten))

  const OUTSIDE = `${SIDE}/outsideRows.ts`
  const lent = await planted({
    [OUTSIDE]: `export const OUTSIDE_ROWS = [{ env: 'ALPHA_TWO', consumer: 'src/a/two.ts' }]\n`,
    [A]: [head(A), `import { OUTSIDE_ROWS } from '${spec(A, js(OUTSIDE))}'`, '', 'export const A_FLAGS: readonly FlagSpec[] = [', `  { env: 'ALPHA_ONE', consumer: 'src/a/one.ts' },`, `  ...OUTSIDE_ROWS.filter(row => row.env === 'ALPHA_TWO'),`, ']', ''].join('\n'),
  })
  check('a row file that takes a row from a file beside the folder is named at its import and at the spread (holes 06 and 07)', kinds(lent) === 'shape shape' && lent[0]!.text.startsWith(`${A}:2 imports '${spec(A, js(OUTSIDE))}'`) && lent[1]!.text.startsWith(`${A}:6 is no row written in the file`), texts(lent))

  const sortedAtLoad = await planted({ [A]: [head(A), '', 'export const A_FLAGS: readonly FlagSpec[] = [', `  { env: 'ALPHA_TWO', consumer: 'src/a/two.ts' },`, `  { env: 'ALPHA_ONE', consumer: 'src/a/one.ts' },`, `]${SORT}`, ''].join('\n') })
  check('a row file written out of order that sorts its array as it exports it is named (hole 08)', kinds(sortedAtLoad) === 'shape' && sortedAtLoad[0]!.text.startsWith(`${A}: beside its import the file is not one exported array literal of rows`), texts(sortedAtLoad))

  const typed = await planted({ [B]: rowsFile('B_FLAGS', [['BETA_ONE', 'src/b/one.ts'], ['BETA_TWO', 'src/a/deep/two.ts']]).replace(head(A), `import type { FlagSpec } from '${spec(B, js(DOOR))}'`) })
  check('a row file that takes its type from the door is named (hole 10)', kinds(typed) === 'shape' && typed[0]!.text.startsWith(`${B}:1 imports '${spec(B, js(DOOR))}'`), texts(typed))

  const LOOSE = `${ROWS}/loose.mts`
  const notTs = await planted({ [LOOSE]: `export const LOOSE_FLAGS = [{ env: 'LOOSE_ONE', consumer: 'src/a/loose.ts' }]\n` })
  check('a code file under the folder whose name does not end .ts is named (hole 14)', kinds(notTs) === 'exports' && notTs[0]!.text.startsWith(`${LOOSE}: a code file under ${ROWS}`), texts(notTs))

  const loose = await planted({ [C]: rowsFile('C_FLAGS', [['GAMMA_ONE', 'src/c/one.ts']]) })
  check('a file the door does not gather is named', kinds(loose) === 'not-gathered' && loose[0]!.text.startsWith(`${C} `) && loose[0]!.text.includes('GAMMA_ONE'), texts(loose))

  const from = (to: string): string => spec('src/a/forms.ts', to)
  const forms = [
    `import { A_FLAGS } from '${from(js(A))}'`,
    `import type { FlagSpec } from '${from(js(TYPES))}'`,
    `export { B_FLAGS } from '${from(js(B))}'`,
    `export * from '${from(js(B))}'`,
    `const late = await import('${from(js(A))}')`,
    `const old = require('${from(js(A))}')`,
    `type Spec = import('${from(js(TYPES))}').FlagSpec`,
    `import legacy = require('${from(js(A))}')`,
    `import whole from '${from(ROWS)}'`,
    `export const all: [FlagSpec?, Spec?] = [A_FLAGS, late, old, legacy, whole]`,
    '',
  ].join('\n')
  const built = [
    `import { join, resolve } from 'node:path'`,
    `const one = await import(join(ROOT, '${A}'))`,
    `const two = await import(join(SRC, '${ROWS.slice(ROWS.indexOf('/') + 1)}', 'b.ts'))`,
    `const three = await import(\`\${ROOT}/${ROWS}/\${name}.ts\`)`,
    `const four = require(resolve(ROOT, ${A.split('/').map(part => `'${part}'`).join(', ')}))`,
    `import { B_FLAGS } from '${js(B)}'`,
    `const door = await import(join(ROOT, '${DOOR}'))`,
    `const text = '${A}'`,
    `export const all = [one, two, three, four, B_FLAGS, door, text]`,
    '',
  ].join('\n')
  const outside = await planted({ 'src/a/forms.ts': forms, 'scripts/b/prove-built.ts': built })
  const lines = (found: Fault[], file: string): string => found.filter(f => f.text.startsWith(`${file}:`)).map(f => f.text.slice(file.length + 1).split(' ')[0]).join(' ')
  check(
    'an outside import is named with its file and line in every form: import, import type, export from, export *, import(), require(), the import() type, import = require and the folder itself',
    lines(outside, 'src/a/forms.ts') === '1 2 3 4 5 6 7 8 9',
    texts(outside),
  )
  check(
    'an import whose path is computed is read by its literal parts and a bare path from the root as one; an import of the door and a string that is no import are not named',
    lines(outside, 'scripts/b/prove-built.ts') === '2 3 4 5 6',
    texts(outside),
  )
  check(`nothing else is named, and every one of them says to import from ${DOOR}`, outside.length === 14 && outside.every(f => f.kind === 'outside-import' && f.text.endsWith(`: import from ${DOOR}`)), texts(outside))

  const VARIABLE = `${SIDE}/byVariable.ts`
  const REQUIRE = `${SIDE}/byRequire.ts`
  const CASE = `${SIDE}/byCase.ts`
  const past = await planted({
    [VARIABLE]: `const target = '${spec(VARIABLE, A)}'\nconst mod = await import(target)\nexport const loaded = mod\n`,
    [REQUIRE]: `import { createRequire } from 'node:module'\nconst load = createRequire(import.meta.url)\nexport const loaded = load('${spec(REQUIRE, A)}')\n`,
    [CASE]: `import { A_FLAGS } from '${spec(CASE, `${CASED}/a.ts`)}'\nexport const loaded = A_FLAGS\n`,
    'bench/outside.ts': `import { A_FLAGS } from '${spec('bench/outside.ts', A)}'\nexport const loaded = A_FLAGS\n`,
    'scripts/b/case.ts': `import { A_FLAGS } from '${spec('scripts/b/case.ts', `${CASED}/a.ts`)}'\nexport const loaded = A_FLAGS\n`,
    'scripts/b/variable.ts': `import { join } from 'node:path'\nconst target = join(ROOT, '${A}')\nconst mod = await import(target)\nexport const loaded = mod\n`,
  })
  check('a path held in a constant of the file is read through, in src and in a script (holes 01 and 15)', lines(past, VARIABLE) === '2' && lines(past, 'scripts/b/variable.ts') === '3', texts(past))
  check('a call that is not spelled import or require is named when its first argument resolves under the folder (hole 02)', lines(past, REQUIRE) === '3' && past.some(f => f.text.startsWith(`${REQUIRE}:3 passes ${A} to a call`)), texts(past))
  check("the folder's name is read without case, in src and in a script (holes 03 and 13)", lines(past, CASE) === '1' && lines(past, 'scripts/b/case.ts') === '1', texts(past))
  check('a file beside src and scripts is read too (hole 12), and nothing else is named', lines(past, 'bench/outside.ts') === '1' && past.length === 6 && past.every(f => f.kind === 'outside-import'), texts(past))

  const BENCH = { 'bench/outside.ts': `import { A_FLAGS } from '${spec('bench/outside.ts', A)}'\nexport const loaded = A_FLAGS\n` }
  const unlisted = await planted(BENCH, () => [])
  const ignored = await planted(BENCH, () => [SELF])
  check('a tree git lists no file of, as a copy that sits in an ignored folder, is walked, and the import past the door is named there; where git lists this proof its list is what is read, so a file it leaves out is not', lines(unlisted, 'bench/outside.ts') === '1' && unlisted.length === 1 && ignored.length === 0, texts([...unlisted, ...ignored]))

  const reaching = (file: string): string => `import { A_FLAGS } from '${spec(file, A)}'\nexport const loaded = A_FLAGS\n`
  const nested = await planted({ 'scripts/vendor/fetch.ts': reaching('scripts/vendor/fetch.ts'), 'vendor/pack/index.ts': reaching('vendor/pack/index.ts'), 'node_modules/dep/index.ts': reaching('node_modules/dep/index.ts') })
  check('the walk reads a folder named vendor under scripts, and leaves the packs at the root and the dependencies unread', lines(nested, 'scripts/vendor/fetch.ts') === '1' && nested.length === 1, texts(nested))

  const order = await planted({ [A]: rowsFile('A_FLAGS', [['ALPHA_TWO', 'src/a/two.ts'], ['ALPHA_ONE', 'src/a/one.ts']]) })
  check('a row out of order in its file is named as it is written', kinds(order) === 'file-order' && order[0]!.text.startsWith(`${A}:5 ALPHA_ONE is written after ALPHA_TWO`), texts(order))

  const unsorted = await planted({ [DOOR]: doorFile(['b', 'a'], '', false) })
  check('a registry out of order is named', kinds(unsorted) === 'registry-order' && unsorted[0]!.text.startsWith('FLAG_REGISTRY: ALPHA_ONE stands after BETA_TWO'), texts(unsorted))

  const stray = await planted({ [A]: rowsFile('A_FLAGS', [['ALPHA_ONE', 'src/a/one.ts'], ['ALPHA_STRAY', 'src/a/deep/stray.ts'], ['ALPHA_TWO', 'src/a/two.ts']]) })
  check('a row in the wrong file is named with the file its consumer maps to, the longest prefix winning', kinds(stray) === 'wrong-file' && stray[0]!.text.startsWith(`ALPHA_STRAY sits in ${A}`) && stray[0]!.text.includes(`maps to ${B} by the prefix 'src/a/deep/'`), texts(stray))

  const firstWord = await planted({
    'src/b/first.ts': 'export const nothing = 0\n',
    'src/a/holds.ts': `export const read = process.env['ALPHA_STRAY']\n`,
    [B]: rowsFile('B_FLAGS', [['ALPHA_STRAY', 'src/b/first.ts, src/a/holds.ts'], ['BETA_ONE', 'src/b/one.ts'], ['BETA_TWO', 'src/a/deep/two.ts']]),
  })
  check("a row is placed by the first path its consumer names that holds the flag's name, not by the first word (hole 09)", kinds(firstWord) === 'wrong-file' && firstWord[0]!.text.startsWith(`ALPHA_STRAY sits in ${B}: its consumer 'src/a/holds.ts' maps to ${A} by the prefix 'src/a/'`), texts(firstWord))

  const anchored = await planted({}, null, { ALPHA_TWO: 'b.ts', GONE_ROW: 'a.ts' })
  const followed = await planted({ [A]: rowsFile('A_FLAGS', [['ALPHA_ONE', 'src/a/one.ts']]), [B]: rowsFile('B_FLAGS', [['ALPHA_TWO', 'src/a/two.ts (and a note)'], ['BETA_ONE', 'src/b/one.ts'], ['BETA_TWO', 'src/a/deep/two.ts']]) }, null, { ALPHA_TWO: 'b.ts' })
  check("a row named in ANCHORS lends its consumer as a prefix, so the table spells no file: the row is named until it sits in the anchor's file, reads clean once it does, and an anchor that names no row is named", kinds(anchored) === 'anchor wrong-file' && anchored[0]!.text.startsWith('GONE_ROW is named in ANCHORS') && anchored[1]!.text.startsWith(`ALPHA_TWO sits in ${A}: its consumer 'src/a/two.ts' maps to ${B} by the prefix 'src/a/two.ts' of ANCHORS, where ALPHA_TWO stands for its consumer,`) && followed.length === 0, texts([...anchored, ...followed]))

  const lost = await planted({ [A]: rowsFile('A_FLAGS', [['ALPHA_LOST', 'docs/lost.md'], ['ALPHA_ONE', 'src/a/one.ts'], ['ALPHA_TWO', 'src/a/two.ts']]) })
  check('a consumer no prefix covers is named with its row and the table', kinds(lost) === 'no-prefix' && lost[0]!.text.startsWith(`ALPHA_LOST in ${A}`) && lost[0]!.text.includes(`AREAS in ${SELF}`), texts(lost))

  const twice = await planted({ [B]: rowsFile('B_FLAGS', [['ALPHA_ONE', 'src/b/again.ts'], ['BETA_ONE', 'src/b/one.ts'], ['BETA_TWO', 'src/a/deep/two.ts']]) })
  check('an env in two files is named with both', kinds(twice) === 'two-files registry-order' && twice[0]!.text.startsWith(`ALPHA_ONE stands in ${A} and in ${B}`), texts(twice))

  const second = await planted({ [A]: `${CLEAN[A]}export const MORE = 1\n` })
  const valued = await planted({ [TYPES]: `${CLEAN[TYPES]}export const VALUE = 1\n` })
  check('a file with a second export and a types file that exports a value are named', kinds(second) === 'exports shape' && second[0]!.text.startsWith(`${A} has 2 exports`) && kinds(valued) === 'exports' && valued[0]!.text.startsWith(`${TYPES} exports VALUE`), texts([...second, ...valued]))
}

const real = await judge(ROOT, AREAS, ANCHORS, gitLists)
const found = (...want: Kind[]): Fault[] => real.faults.filter(f => want.includes(f.kind))

section(`§1 the cut: a row is written in a file under ${ROWS}, never in the door`)
{
  console.log(`  ${real.rows} rows in the registry · ${real.files.length} row files · rows written in the door: ${found('door-row').length}`)
  check('the registry loads, it holds rows, and the folder holds row files', found('tree').length === 0 && real.rows > 0 && real.files.length > 0, found('tree').length > 0 ? say(found('tree')) : `${real.rows} rows, ${real.files.length} row files under ${ROWS}`)
  check(`no row is written in ${DOOR}: every row of FLAG_REGISTRY is the row a file under ${ROWS} exports, and that file holds it when it is loaded alone (0 written in the door)`, found('door-row').length === 0, say(found('door-row')))
  check('the registry serves each row as its file writes it, field for field', found('served').length === 0, say(found('served')))
  check('every row a file exports, loaded with the door or alone, is in the registry', found('not-gathered').length === 0, say(found('not-gathered')))
}

section(`§2 the door: the rows are reached through ${DOOR}`)
{
  check(
    `no file of the tree reaches a file under ${ROWS} past the door, the files of that folder, the helper and this proof aside: an import in any form and any call whose first argument resolves there, the folder's name read without case and a constant of the same file read through (${real.walked} code files ${real.by}, ${real.parsed} read to their syntax; out of reach: ${OUT_OF_REACH})`,
    found('outside-import').length === 0,
    say(found('outside-import')),
  )
}

section('§3 the files: one export each, rows written in order, each row in the file of its consumer')
{
  if (real.files.length > 0) console.log(`  ${real.files.map(([file, rows]) => `${posix.basename(file)} ${rows}`).join(' · ')}`)
  check(`each file has one export, an array of rows, ${TYPES} exports no value, and every code file under the folder ends .ts`, found('exports').length === 0, say(found('exports')))
  check(`each row file is written as one import of the type from '${TYPES_FROM}' and one exported array literal of rows`, found('shape').length === 0, say(found('shape')))
  check('the rows of each file ascend by env as they are written', found('file-order').length === 0, say(found('file-order')))
  check('no env stands in two files', found('two-files').length === 0, say(found('two-files')))
  check('every row named in ANCHORS stands in the registry', found('anchor').length === 0, say(found('anchor')))
  check('every consumer is covered by a prefix of AREAS', found('no-prefix').length === 0, say(found('no-prefix')))
  check("each row sits in the file its consumer maps to: the first path the consumer names that holds the flag's name, the longest prefix of AREAS and ANCHORS winning", found('wrong-file').length === 0, say(found('wrong-file')))
}

section('§4 the registry: its order is the order of env')
{
  check('FLAG_REGISTRY ascends by env', found('registry-order').length === 0, say(found('registry-order')))
}

console.log(failures === 0 ? '\nprove-flag-registry-split: green' : `\nprove-flag-registry-split: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
