#!/usr/bin/env bun
// ============================================================================
//  scripts/staleness/prove-stale-registry.ts — THE MEMO REGISTRY RATCHET
//  (the operator-banked never-stale law's teeth).
//
//  THE LAW: nothing Mercury remembers for speed may be painted as live truth
//  once the truth has moved. Every module-lifetime memo of a filesystem or
//  process fact must NAME how it stays honest — a registry row per site:
//
//    <file> :: <symbol> :: <disposition>
//
//  disposition ∈
//    invalidator=<name>   an explicit clear the truth's writers reach
//    keyed-by-truth       the cache key IS the changing fact (arg/mtime/
//                         fingerprint-keyed; a moved truth is a new key)
//    ttl-bounded          staleness bounded by an explicit window
//    subscription-fed     a watcher/poll/store feed rewrites it
//    static-for-process   the fact cannot move within one process by design
//                         (platform, env at boot, bundled bytes), or the
//                         one-shot is a documented deliberate residual
//
//  A NEW memoize( site or module-level cache-shaped let/const/Map WITHOUT a
//  row reds this prover: add the row naming the invalidator or the reason —
//  and if the honest answer is "nothing invalidates it and the truth can
//  move", the fix belongs at the seam, not in this table. A row whose site
//  is GONE also reds (the MOOT-row law): rows never outlive their caches.
//
//  The extractor is deliberately grammar-based (line-anchored, name-
//  filtered) and self-tested below on planted positives AND the known
//  false-positive shapes, so the walk cannot silently rot.
// ============================================================================
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

type Site = { file: string; symbol: string; kind: 'memoize' | 'module-cache' }

const NAME_FILTER = /(cache|memo(?!ry)|snapshot|lastknown)/i
const CONST_NAME = /^[A-Z0-9_]+$/

export function extractSites(file: string, text: string): Site[] {
  const sites: Site[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (/^\s*(\/\/|\*)/.test(line)) continue
    const named =
      /^(?:export )?const ([A-Za-z_$][\w$]*)(?:\s*:[^=]*)?\s*=\s*memoize(?:<[^>]*>)?\s*\(/.exec(line) ??
      /^\s*([A-Za-z_$][\w$]*):\s*memoize(?:<[^>]*>)?\s*\(/.exec(line)
    if (named) {
      sites.push({ file, symbol: named[1]!, kind: 'memoize' })
      continue
    }
    if (/\bmemoize(?:<[^>]*>)?\s*\(/.test(line) && !/import |from '|require\(|memoized|function memoize/.test(line)) {
      const known = /^(?:export )?const ([A-Za-z_$][\w$]*)/.exec(line)
      sites.push({ file, symbol: known?.[1] ?? `anonymous@${i + 1}`, kind: 'memoize' })
      continue
    }
    // Module-level (column-0) cache-shaped let/const with an initializer…
    const mod =
      /^(?:export )?(?:let|const) ([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:null|undefined|new Map\b|new Set\b|new WeakMap\b|new LRUCache\b|\{\s*$|\{\})/.exec(
        line,
      )
    // …or an initializer-less `let name: T` declaration (same cache class).
    const bare = mod ? null : /^(?:export )?let ([A-Za-z_$][\w$]*)\s*:[^=\n]*$/.exec(line)
    const name = mod?.[1] ?? bare?.[1]
    if (name !== undefined && NAME_FILTER.test(name) && !CONST_NAME.test(name)) {
      sites.push({ file, symbol: name, kind: 'module-cache' })
    }
  }
  return sites
}

// ── the registry (one row per site; sorted; amend WITH the site's commit) ───
const REGISTRY = `
src/commands.ts :: COMMANDS :: static-for-process
src/commands.ts :: builtInCommandNames :: static-for-process
src/commands.ts :: getSkillToolCommands :: invalidator=clearCommandMemoizationCaches
src/commands.ts :: getSlashCommandToolSkills :: invalidator=clearCommandMemoizationCaches
src/commands.ts :: loadAllCommands :: invalidator=clearCommandMemoizationCaches
src/components/HelmLanesRail.tsx :: lastKnownRecent :: subscription-fed
src/components/HelmLanesRail.tsx :: lastKnownTabulaOpenByDir :: subscription-fed
src/components/HelmLanesRail.tsx :: lastKnownWakeGlance :: subscription-fed
src/components/HelmLanesRail.tsx :: lastKnownWorkShape :: subscription-fed
src/components/HighlightedCode/Fallback.tsx :: highlightCache :: keyed-by-truth
src/components/Markdown.tsx :: tokenCache :: keyed-by-truth
src/components/Spinner/utils.ts :: parseCache :: keyed-by-truth
src/components/StructuredDiff.tsx :: hunkCache :: keyed-by-truth
src/components/VirtualMessageList.tsx :: realPromptCache :: keyed-by-truth
src/components/concourse/ConcourseRoute.tsx :: lastCoherentSnapshot :: subscription-fed
src/components/mercury-ui/SessionTabs.tsx :: lastKnownTabs :: subscription-fed
src/components/mercury-ui/sessionAccent.ts :: snapshotMemo :: keyed-by-truth
src/components/messages/TranscriptNameplate.tsx :: cachedHandle :: static-for-process
src/constants/common.ts :: getSessionStartDate :: static-for-process
src/context.ts :: getGitStatus :: invalidator=applyHarnessGround
src/context.ts :: getSystemContext :: invalidator=applyHarnessGround
src/context.ts :: getUserContext :: invalidator=applyHarnessGround
src/daemon/concourseDispatch.ts :: ledgerMemo :: keyed-by-truth
src/daemon/controlSocket.ts :: controlKeyMemo :: invalidator=clearControlKeyMemo
src/daemon/handshake.ts :: clientMemo :: static-for-process
src/daemon/ownerWatch.ts :: startTokenCache :: ttl-bounded
src/daemon/ownerWatch.ts :: win32PsExeCached :: static-for-process
src/entrypoints/init.ts :: init :: static-for-process
src/extensions/boot.ts :: lastSnapshot :: subscription-fed
src/extensions/load/agents.ts :: memo :: invalidator=clearExtensionAgentCache
src/extensions/load/commands.ts :: commandsMemo :: invalidator=clearExtensionCommandCaches
src/extensions/load/commands.ts :: skillsMemo :: invalidator=clearExtensionCommandCaches
src/extensions/load/language.ts :: memo :: invalidator=clearExtensionLspServerCache
src/extensions/load/servers.ts :: memo :: invalidator=clearExtensionMcpServerCache
src/extensions/roster.ts :: activeSnapshot :: invalidator=setActiveSnapshot
src/hooks/fileSuggestions.ts :: ignoreCache :: keyed-by-truth
src/ink/line-width-cache.ts :: cache :: keyed-by-truth
src/ink/node-cache.ts :: nodeCache :: keyed-by-truth
src/ink/session/windowsHostSetup.ts :: presenceCache :: invalidator=evictHostPresence
src/keybindings/loadUserBindings.ts :: cached :: keyed-by-truth
src/keybindings/loadUserBindings.ts :: cachedCwd :: keyed-by-truth
src/memdir/paths.ts :: getAutoMemPath :: static-for-process
src/projectOnboardingState.ts :: projectOnboardingHint :: invalidator=applyHarnessGround
src/projectOnboardingState.ts :: shouldShowProjectOnboarding :: invalidator=applyHarnessGround
src/services/analytics/featureGates.ts :: initializeFeatureGates :: static-for-process
src/services/analytics/metadata.ts :: buildEnvContext :: static-for-process
src/services/analytics/metadata.ts :: getBaseVersion :: static-for-process
src/services/aseprite/asepriteApp.ts :: versionCache :: ttl-bounded
src/services/claudeAiLimits.ts :: ownerCache :: ttl-bounded
src/services/concourse/concourseSnapshot.ts :: olderFactCache :: keyed-by-truth
src/services/concourse/coordinatorIdentity.ts :: cached :: static-for-process
src/services/concourse/coordinatorTools.ts :: knownDirsCache :: ttl-bounded
src/services/contextLanes/lanes.ts :: laneScanMemo :: keyed-by-truth
src/services/crew/projection.ts :: snapshot :: subscription-fed
src/services/dap/dapClient.ts :: darwinDebuggerAuthMemo :: static-for-process
src/services/dap/dapClient.ts :: gdbProbeCache :: ttl-bounded
src/services/dap/dapClient.ts :: lldbDapMemo :: static-for-process
src/services/dap/debugpyResolver.ts :: cache :: ttl-bounded
src/services/dap/debugpyResolver.ts :: pycachePrefixMemo :: static-for-process
src/services/eval/interpreters.ts :: probeCache :: ttl-bounded
src/services/ide/blenderProject.ts :: versionCache :: ttl-bounded
src/services/ide/cppBuild.ts :: cmakeCache :: ttl-bounded
src/services/ide/cppProject.ts :: profileCache :: ttl-bounded
src/services/ide/godotSession.ts :: parseCache :: keyed-by-truth
src/services/ide/ideTransaction.ts :: rootMemo :: keyed-by-truth
src/services/ide/pythonProject.ts :: profileCache :: ttl-bounded
src/services/ide/pythonProject.ts :: selectionCache :: ttl-bounded
src/services/ide/pythonTests.ts :: pytestProbeCache :: ttl-bounded
src/services/instructions/discovery.ts :: excludeResolutionMemo :: invalidator=clearExcludeResolutionMemo
src/services/instructions/discovery.ts :: rulesDirListingCaches :: ttl-bounded
src/services/instructions/engine.ts :: cacheInvalidationListeners :: static-for-process
src/services/instructions/engine.ts :: getInstructionFiles :: invalidator=clearInstructionFileCaches
src/services/internalLogging.ts :: getContainerId :: static-for-process
src/services/lsp/clangdLane.ts :: probeCache :: ttl-bounded
src/services/lsp/pyrightLane.ts :: probeCache :: ttl-bounded
src/services/lsp/ruffLane.ts :: probeCache :: ttl-bounded
src/services/lsp/unityLane.ts :: probeCache :: ttl-bounded
src/services/mcp/auth.ts :: metadataCache :: static-for-process
src/services/mcp/channelsRoot.ts :: channelsRootCache :: static-for-process
src/services/mcp/claudeai.ts :: fetchClaudeAIMcpConfigsIfEligible :: static-for-process
src/services/mcp/client.ts :: connectToServer :: invalidator=transport.onclose
src/services/mcp/client.ts :: fetchCommandsForClient :: invalidator=transport.onclose
src/services/mcp/client.ts :: fetchResourcesForClient :: invalidator=transport.onclose
src/services/mcp/client.ts :: fetchToolsForClientMemo :: invalidator=transport.onclose
src/services/mcp/client.ts :: needsAuthReadMemo :: invalidator=clearMcpAuthCache
src/services/mission/harnessApplication.ts :: liveEpochMemo :: keyed-by-truth
src/services/mission/harnessProfiles.ts :: resolutionCache :: keyed-by-truth
src/services/policyLimits/index.ts :: sessionCache :: static-for-process
src/services/privateChannel/installProvenance.ts :: memoized :: static-for-process
src/services/providers/deferralProbe.ts :: cache :: keyed-by-truth
src/services/providers/gemini/geminiCatalogue.ts :: catalogueCache :: ttl-bounded
src/services/providers/huggingface/huggingfaceCatalogue.ts :: catalogueCache :: ttl-bounded
src/services/providers/local/localDiscovery.ts :: cached :: ttl-bounded
src/services/providers/openai/openaiCatalogue.ts :: catalogueCache :: ttl-bounded
src/services/providers/openrouter/openrouterCatalogue.ts :: catalogueCache :: ttl-bounded
src/services/providers/providerUsage.ts :: activeUsageCache :: ttl-bounded
src/services/providers/providerUsage.ts :: otherUsagesCache :: ttl-bounded
src/services/remoteManagedSettings/syncCacheState.ts :: sessionCache :: subscription-fed
src/services/repoHost/repoHost.ts :: cache :: ttl-bounded
src/services/saturn/sessionScheduleBridge.ts :: rosterCache :: subscription-fed
src/services/schema/jsonSchemaEngine.ts :: compileCache :: keyed-by-truth
src/services/switchboard/ensureDaemon.ts :: bootRunnerOptionsMemo :: static-for-process
src/services/switchboard/ensureDaemon.ts :: usableMemo :: ttl-bounded
src/services/workbench/projection.ts :: agentMetaCache :: subscription-fed
src/services/workbench/projection.ts :: snapshot :: subscription-fed
src/services/workshop/runtime.ts :: cachedTs :: keyed-by-truth
src/skills/loadSkillsDir.ts :: loadAllSkillsMemo :: invalidator=clearSkillCaches
src/state/telemetryBus.ts :: snapshots :: subscription-fed
src/substrate/startupMenu.ts :: admissionSnapshot :: static-for-process
src/tasks/taskOutcomeEnvelope.ts :: cacheBySession :: invalidator=recordTaskOutcome
src/tools/AgentTool/loadAgentsDir.ts :: definitionsCache :: invalidator=clearAgentDefinitionsCache
src/tools/BashTool/readOnlyValidation.ts :: allowlistCache :: static-for-process
src/tools/FileReadTool/limits.ts :: getDefaultFileReadingLimits :: static-for-process
src/tools/REPLTool/primitiveTools.ts :: cached :: static-for-process
src/tools/SkillTool/prompt.ts :: promptForRoot :: keyed-by-truth
src/tools/SyntheticOutputTool/SyntheticOutputTool.ts :: schemaBoundCache :: keyed-by-truth
src/tools/ToolSearchTool/ToolSearchTool.ts :: deferredSetCacheKey :: keyed-by-truth
src/tools/ToolSearchTool/ToolSearchTool.ts :: getToolDescriptionMemoized :: keyed-by-truth
src/tools/ToolSearchTool/cooccurPrior.ts :: tableCache :: static-for-process
src/tools/WebFetchTool/utils.ts :: domainCheckCache :: ttl-bounded
src/tools/WebFetchTool/utils.ts :: urlCache :: ttl-bounded
src/tools/WorkflowTool/runManifest.ts :: manifestParseCache :: keyed-by-truth
src/tools/WorkflowTool/structuredOutputTool.ts :: boundToolCache :: keyed-by-truth
src/utils/Shell.ts :: getPsProvider :: static-for-process
src/utils/Shell.ts :: getShellConfig :: static-for-process
src/utils/accounts/accountIdentity.ts :: cache :: ttl-bounded
src/utils/ansiToPng.ts :: fallbackGlyphCache :: static-for-process
src/utils/ansiToPng.ts :: fontCache :: static-for-process
src/utils/asciicast.ts :: cachedRecordFilePath :: static-for-process
src/utils/aseprite/gates.ts :: contextCache :: ttl-bounded
src/utils/aseprite/gates.ts :: locatedCache :: ttl-bounded
src/utils/auth.ts :: getApiKeyFromConfigOrMacOSKeychain :: invalidator=removeApiKey
src/utils/auth.ts :: getClaudeAIOAuthTokens :: invalidator=clearOAuthTokenCache
src/utils/auth.ts :: scopedAccountIdentityCache :: keyed-by-truth
src/utils/auth.ts :: signedOutKeyMemoStamp :: invalidator=invalidateOnDiskChange
src/utils/auth.ts :: signedOutOAuthMemoStamp :: invalidator=invalidateOnDiskChange
src/utils/availableCores.ts :: memo :: static-for-process
src/utils/blender/bridgeGates.ts :: blendContextCache :: ttl-bounded
src/utils/bootCardFacts.ts :: catalogedGroundCache :: ttl-bounded
src/utils/bootCardFacts.ts :: currentCache :: ttl-bounded
src/utils/caCerts.ts :: cachedResult :: static-for-process
src/utils/cockpit/companionEngine.ts :: snapshot :: subscription-fed
src/utils/cockpit/critterProfile.ts :: cached :: static-for-process
src/utils/cockpit/deviceHeadroom.ts :: cached :: ttl-bounded
src/utils/cockpit/harnessMap.ts :: memo :: static-for-process
src/utils/cockpit/repoSurfaceMap.ts :: orientationDocMemo :: static-for-process
src/utils/cockpit/runProtocol.ts :: memo :: keyed-by-truth
src/utils/cockpit/runtimePosture.ts :: memo :: static-for-process
src/utils/config/globalConfig.ts :: globalConfigCache :: subscription-fed
src/utils/config/projectConfig.ts :: getProjectPathForConfig :: invalidator=applyHarnessGround
src/utils/debug.ts :: getDebugFilePath :: static-for-process
src/utils/debug.ts :: getDebugFilter :: static-for-process
src/utils/debug.ts :: getMinDebugLogLevel :: static-for-process
src/utils/debug.ts :: isDebugMode :: static-for-process
src/utils/debug.ts :: isDebugToStdErr :: static-for-process
src/utils/debugFilter.ts :: parseDebugFilter :: keyed-by-truth
src/utils/detectRepository.ts :: repositoryCache :: keyed-by-truth
src/utils/editor.ts :: getExternalEditor :: static-for-process
src/utils/env.ts :: detectDeploymentEnvironment :: static-for-process
src/utils/env.ts :: getGlobalMercuryFile :: static-for-process
src/utils/env.ts :: getPackageManagers :: static-for-process
src/utils/env.ts :: getRuntimes :: static-for-process
src/utils/env.ts :: hasInternetAccess :: static-for-process
src/utils/env.ts :: isNpmFromWindowsPath :: static-for-process
src/utils/env.ts :: isRunningWithBun :: static-for-process
src/utils/env.ts :: isWslEnvironment :: static-for-process
src/utils/envDynamic.ts :: getIsDocker :: static-for-process
src/utils/envDynamic.ts :: jetBrainsIdeCache :: static-for-process
src/utils/envUtils.ts :: getMercuryHome :: keyed-by-truth
src/utils/exampleCommands.ts :: getExampleCommandFromCache :: invalidator=applyHarnessGround
src/utils/exampleCommands.ts :: refreshExampleCommands :: invalidator=applyHarnessGround
src/utils/fileReadCache.ts :: fileReadCache :: keyed-by-truth
src/utils/forkedAgent.ts :: lastCacheSafeParams :: keyed-by-truth
src/utils/formatBriefTimestamp.ts :: formatterCache :: keyed-by-truth
src/utils/fullscreen.ts :: controlModeCache :: static-for-process
src/utils/genericProcessUtils.ts :: cachedPowerShellExe :: static-for-process
src/utils/genericProcessUtils.ts :: metaCache :: ttl-bounded
src/utils/git.ts :: getIsGit :: invalidator=applyHarnessGround
src/utils/git.ts :: gitExe :: static-for-process
src/utils/git/gitFilesystem.ts :: cacheEntries :: invalidator=regroundGitWatch
src/utils/git/gitFilesystem.ts :: gitDirCache :: keyed-by-truth
src/utils/hooks/hookHelpers.ts :: hookResponseSchema :: static-for-process
src/utils/hooks/hooksConfigManager.ts :: getHookEventMetadata :: keyed-by-truth
src/utils/hooks/hooksConfigSnapshot.ts :: snapshot :: invalidator=captureHooksConfigSnapshot
src/utils/ide.ts :: embeddedTerminal :: static-for-process
src/utils/ide.ts :: hostResolutionCache :: keyed-by-truth
src/utils/ide.ts :: jetBrainsFamilyTerminal :: static-for-process
src/utils/ide.ts :: runningIDECache :: invalidator=resetRunningIDECache
src/utils/ide.ts :: vsCodeFamilyTerminal :: static-for-process
src/utils/lockfile.ts :: cached :: static-for-process
src/utils/markdownConfigLoader.ts :: loadMarkdownFilesForSubdir :: keyed-by-truth
src/utils/mercuryTokens.ts :: rampCache :: keyed-by-truth
src/utils/mercuryTokens.ts :: tokenCache :: keyed-by-truth
src/utils/model/capabilities.ts :: getAllModelBetas :: keyed-by-truth
src/utils/model/capabilities.ts :: getModelBetas :: keyed-by-truth
src/utils/model/computedDefault.ts :: memo :: ttl-bounded
src/utils/mtls.ts :: getMTLSAgent :: static-for-process
src/utils/mtls.ts :: getMTLSConfig :: static-for-process
src/utils/permissions/filesystem.ts :: bundledSkillsRootCache :: static-for-process
src/utils/permissions/filesystem.ts :: tempDirCache :: static-for-process
src/utils/permissions/filesystem.ts :: workingDirResolutionCache :: keyed-by-truth
src/utils/permissions/shellRuleMatching.ts :: compiledCache :: keyed-by-truth
src/utils/plans.ts :: plansDirectoryMemo :: invalidator=applyHarnessGround
src/utils/platform.ts :: getLinuxDistroInfo :: static-for-process
src/utils/platform.ts :: getPlatform :: static-for-process
src/utils/platform.ts :: getWslVersion :: static-for-process
src/utils/proxy.ts :: proxyDispatcherCache :: keyed-by-truth
src/utils/proxy.ts :: tunnelAgentCache :: keyed-by-truth
src/utils/ripgrep.ts :: roundedCountMemo :: keyed-by-truth
src/utils/router/providerDiscovery.ts :: cache :: ttl-bounded
src/utils/sandbox/sandbox-adapter.ts :: cachedWorktreeMainRepo :: static-for-process
src/utils/sandbox/sandbox-adapter.ts :: isSupportedPlatformMemo :: static-for-process
src/utils/savedPrompts/minervaRefinedStore.ts :: cache :: subscription-fed
src/utils/savedPrompts/savedPromptsStore.ts :: cache :: subscription-fed
src/utils/secureStorage/macOsKeychainHelpers.ts :: keychainCacheState :: invalidator=clearKeychainCache
src/utils/secureStorage/macOsKeychainStorage.ts :: keychainLockedMemo :: static-for-process
src/utils/sessionStorage/clearedSessions.ts :: memo :: ttl-bounded
src/utils/sessionStorage/logs.ts :: listingMemo :: keyed-by-truth
src/utils/sessionStorage/writer.ts :: getAgentFileMessages :: keyed-by-truth
src/utils/sessionStorage/writer.ts :: getSessionMessages :: keyed-by-truth
src/utils/sessionStoragePortable.ts :: projectDirMemo :: keyed-by-truth
src/utils/settings/changeDetector.ts :: mdmSnapshot :: subscription-fed
src/utils/settings/managedPath.ts :: getManagedFilePath :: static-for-process
src/utils/settings/managedPath.ts :: getManagedSettingsDropInDir :: static-for-process
src/utils/settings/mdm/settings.ts :: hkcuCache :: subscription-fed
src/utils/settings/mdm/settings.ts :: mdmCache :: subscription-fed
src/utils/settings/settingsCache.ts :: parsedFileCache :: invalidator=resetSettingsCache
src/utils/settings/settingsCache.ts :: perSourceCache :: invalidator=resetSettingsCache
src/utils/settings/settingsCache.ts :: sessionSettingsCache :: invalidator=resetSettingsCache
src/utils/settings/snapshot.ts :: lastSnapshot :: keyed-by-truth
src/utils/shell/powershellDetection.ts :: cachedPowerShellPath :: static-for-process
src/utils/suggestions/directoryCompletion.ts :: directoryCache :: ttl-bounded
src/utils/suggestions/directoryCompletion.ts :: pathCache :: ttl-bounded
src/utils/suggestions/shellHistoryCompletion.ts :: corpusCache :: ttl-bounded
src/utils/suggestions/slackChannelSuggestions.ts :: responseCache :: keyed-by-truth
src/utils/swarm/backends/TmuxBackend.ts :: cachedLeaderWindowId :: static-for-process
src/utils/swarm/backends/detection.ts :: insideITerm2Memo :: static-for-process
src/utils/swarm/backends/detection.ts :: insideTmuxMemo :: static-for-process
src/utils/swarm/backends/registry.ts :: cachedBackend :: static-for-process
src/utils/swarm/backends/registry.ts :: cachedDetection :: static-for-process
src/utils/swarm/backends/registry.ts :: cachedInProcessExecutor :: static-for-process
src/utils/swarm/backends/registry.ts :: cachedPaneExecutor :: static-for-process
src/utils/systemTheme.ts :: cachedSystemTheme :: static-for-process
src/utils/task/diskOutput.ts :: memoizedTasksDir :: static-for-process
src/utils/toolSchemaCache.ts :: toolSchemaCache :: keyed-by-truth
src/utils/toolSearch.ts :: memoizedDeferredToolTokens :: keyed-by-truth
src/utils/transcriptSearch.ts :: searchTextCache :: keyed-by-truth
src/utils/user.ts :: getCoreUserData :: static-for-process
src/utils/user.ts :: getGitEmail :: static-for-process
src/utils/verification/projectGates.ts :: cache :: ttl-bounded
src/utils/verification/verificationState.ts :: digestCache :: invalidator=markMutation
src/utils/verification/verificationState.ts :: verifiableCache :: ttl-bounded
src/utils/windowsPaths.ts :: findGitBashPath :: static-for-process
src/utils/zodToJsonSchema.ts :: conversionCache :: keyed-by-truth
`.trim()

// ── the walk ────────────────────────────────────────────────────────────────
function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) yield* walk(p)
    else if (/\.(ts|tsx)$/.test(name)) yield p
  }
}

const found = new Map<string, Site>()
for (const f of walk('src')) {
  for (const s of extractSites(f.replace(/\\/g, '/'), readFileSync(f, 'utf8'))) {
    found.set(`${s.file} :: ${s.symbol}`, s)
  }
}

const DISPOSITION = /^(invalidator=[A-Za-z_$][\w$.]*|keyed-by-truth|ttl-bounded|subscription-fed|static-for-process)$/
const rows = new Map<string, string>()
let grammarBad = 0
for (const line of REGISTRY.split('\n')) {
  const t = line.trim()
  if (t === '' || t.startsWith('#')) continue
  const m = /^(\S+) :: (\S+) :: (\S+)$/.exec(t)
  if (!m || !DISPOSITION.test(m[3]!)) {
    grammarBad++
    console.log(`  [FAIL] registry row grammar — ${t}`)
    continue
  }
  rows.set(`${m[1]} :: ${m[2]}`, m[3]!)
}
if (grammarBad > 0) failures += grammarBad

// ── the two directions ──────────────────────────────────────────────────────
const unrowed = [...found.keys()].filter(k => !rows.has(k)).sort()
check(
  `every memoized filesystem/process fact carries a registry row (${found.size} sites)`,
  unrowed.length === 0,
  unrowed.length > 0
    ? `NEW unrowed cache(s) — name each row's invalidator or reason, or fix the seam: ${unrowed.join(' · ')}`
    : '',
)
const moot = [...rows.keys()].filter(k => !found.has(k)).sort()
check(
  `no registry row outlives its cache (${rows.size} rows)`,
  moot.length === 0,
  moot.length > 0 ? `MOOT row(s) — the site is gone, remove the row: ${moot.join(' · ')}` : '',
)

// ── extractor self-tests (planted positives + known false-positive shapes) ──
{
  const fixture = [
    "export const getThing = memoize((): string => 'x')",
    'let fooCache: Record<string, number> | null = null',
    'const barSnapshotCache = new Map<string, number>()',
    'let quxMemo: string | undefined',
    'const memory: Command = {',
    'const IDLE_SNAPSHOT: TurnPhaseSnapshot = {',
    '// let commentCache: string | null = null',
    "import memoize from 'lodash-es/memoize.js'",
    '  getPackagers: memoize(async (): Promise<string[]> => {',
  ].join('\n')
  const got = extractSites('fixture.ts', fixture)
  const names = got.map(s => s.symbol).sort().join(',')
  check('self-test: the four planted cache shapes are all found', names.includes('getThing') && names.includes('fooCache') && names.includes('barSnapshotCache') && names.includes('quxMemo') && names.includes('getPackagers'), names)
  check('self-test: the known false-positive shapes stay silent', !names.includes('memory') && !names.includes('IDLE_SNAPSHOT') && !names.includes('commentCache') && !names.includes('memoize'), names)
}

const dispositions = [...rows.values()].reduce<Record<string, number>>((acc, d) => {
  const k = d.startsWith('invalidator=') ? 'invalidator-named' : d
  acc[k] = (acc[k] ?? 0) + 1
  return acc
}, {})
console.log(`  census: ${found.size} sites — ${Object.entries(dispositions).map(([k, v]) => `${k} ${v}`).join(' · ')}`)
console.log(failures === 0 ? 'prove-stale-registry: GREEN' : `prove-stale-registry: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
