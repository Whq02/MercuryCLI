import type { Tool, ToolPermissionContext, Tools } from './Tool.js'
import { toolMatchesName } from './Tool.js'
import { isEnvTruthy } from './utils/envUtils.js'
import { flagEnv } from './substrate/flagRegistry.js'
import { getDenyRuleForTool } from './utils/permissions/permissions.js'
import { searchToolsAvailability } from './utils/ripgrep.js'
import { isAgentSwarmsEnabled } from './utils/agentSwarmsEnabled.js'
import { isTodoV2Enabled } from './utils/tasks.js'
import { isWorktreeModeEnabled } from './utils/worktreeModeEnabled.js'
import { isAutopilotEnabled } from './utils/autopilot/autopilotGates.js'
import { vulcanToolCatalogEnabled } from './utils/vulcan/vulcanGates.js'
import { unityBridgeToolCatalogEnabled } from './utils/unity/bridgeGates.js'
import { blenderBridgeToolCatalogEnabled } from './utils/blender/bridgeGates.js'
import { asepriteToolCatalogEnabled } from './utils/aseprite/gates.js'
import { BrowserTool, browserToolEnabled } from './tools/BrowserTool/BrowserTool.js'
import { ContractTool, contractToolHosted } from './tools/ContractTool/ContractTool.js'
import { changeSetEnabled } from './services/changeTransaction/changeSetContracts.js'
import { isDapToolCatalogEnabled } from './services/dap/dapClient.js'
import { gitGraphEnabled } from './services/gitGraph/contracts.js'
import { ideLoopEnabled } from './services/ide/ideTransaction.js'
import { launchProfilesEnabled } from './services/ide/launchProfiles.js'
import { pythonTestsEnabled } from './services/ide/pythonTests.js'
import { journeysEnabled } from './services/journeys/contracts.js'
import { isLspToolCatalogEnabled } from './services/lsp/mercuryLsp.js'
import { servicesEnabled } from './services/projectServices/contracts.js'
import { mercuryRefsEnabled } from './services/resources/contracts.js'
import { structureEnabled, structurePolyglotEnabled } from './services/structure/contracts.js'
import { workshopEnabled } from './services/workshop/contracts.js'
import { isToolSearchEnabledOptimistic } from './utils/toolSearch.js'

import { AgentTool } from './tools/AgentTool/AgentTool.js'
import { AstEditTool } from './tools/AstEditTool/AstEditTool.js'
import { AstSearchTool } from './tools/AstSearchTool/AstSearchTool.js'
import {
  ALL_AGENT_DISALLOWED_TOOLS,
  ASYNC_AGENT_ALLOWED_TOOLS,
  CUSTOM_AGENT_DISALLOWED_TOOLS,
} from './constants/tools.js'
import { ApolloReviewTool } from './tools/ApolloReviewTool/ApolloReviewTool.js'
import { ArtifactsListTool } from './tools/ArtifactsListTool/ArtifactsListTool.js'
import { AskUserQuestionTool } from './tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { BashTool } from './tools/BashTool/BashTool.js'
import { BriefTool } from './tools/BriefTool/BriefTool.js'
import { ChangeSetTool } from './tools/ChangeSetTool/ChangeSetTool.js'
import { DebugTool } from './tools/DebugTool/DebugTool.js'
import { EnterPlanModeTool } from './tools/EnterPlanModeTool/EnterPlanModeTool.js'
import { EvalTool } from './tools/EvalTool/EvalTool.js'
import { evalEnabled } from './services/eval/contracts.js'
import { EnterWorktreeTool } from './tools/EnterWorktreeTool/EnterWorktreeTool.js'
import { ExitPlanModeV2Tool } from './tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import { ExitWorktreeTool } from './tools/ExitWorktreeTool/ExitWorktreeTool.js'
import { FileEditTool } from './tools/FileEditTool/FileEditTool.js'
import { FileReadTool } from './tools/FileReadTool/FileReadTool.js'
import { FileWriteTool } from './tools/FileWriteTool/FileWriteTool.js'
import { GitTool } from './tools/GitTool/GitTool.js'
import { GlobTool } from './tools/GlobTool/GlobTool.js'
import { GodotTool } from './tools/GodotTool/GodotTool.js'
import { UnityTool } from './tools/UnityTool/UnityTool.js'
import { BlenderTool } from './tools/BlenderTool/BlenderTool.js'
import { AsepriteTool } from './tools/AsepriteTool/AsepriteTool.js'
import { GrepTool } from './tools/GrepTool/GrepTool.js'
import { InspectTool } from './tools/InspectTool/InspectTool.js'
import { JourneyTool } from './tools/JourneyTool/JourneyTool.js'
import { LaunchFleetTool } from './tools/LaunchFleetTool/LaunchFleetTool.js'
import { LaunchTool } from './tools/LaunchTool/LaunchTool.js'
import { ListMcpResourcesTool } from './tools/ListMcpResourcesTool/ListMcpResourcesTool.js'
import { LSPTool } from './tools/LSPTool/LSPTool.js'
import { MonitorTool } from './tools/MonitorTool/MonitorTool.js'
import { NotebookEditTool } from './tools/NotebookEditTool/NotebookEditTool.js'
import {
  CorrectTool,
  RecallTool,
  ReflectTool,
  RetainTool,
} from './tools/MemoryTools/MemoryTools.js'
import { memoryVerbsEnabled } from './memdir/memoryVerbs.js'
import { PowerShellTool } from './tools/PowerShellTool/PowerShellTool.js'
import { PushNotificationTool } from './tools/PushNotificationTool/PushNotificationTool.js'
import { ReadMcpResourceTool } from './tools/ReadMcpResourceTool/ReadMcpResourceTool.js'
import { RememberLessonTool } from './tools/RememberLessonTool/RememberLessonTool.js'
import { RecordConventionTool } from './tools/RecordConventionTool/RecordConventionTool.js'
import { CronCreateTool } from './tools/ScheduleCronTool/CronCreateTool.js'
import { CronDeleteTool } from './tools/ScheduleCronTool/CronDeleteTool.js'
import { CronListTool } from './tools/ScheduleCronTool/CronListTool.js'
import { ScheduleWakeupTool } from './tools/ScheduleWakeupTool/ScheduleWakeupTool.js'
import { SendMessageTool } from './tools/SendMessageTool/SendMessageTool.js'
import { SendUserFileTool } from './tools/SendUserFileTool/SendUserFileTool.js'
import { ServiceTool } from './tools/ServiceTool/ServiceTool.js'
import { SetTierTool } from './tools/SetTierTool/SetTierTool.js'
import { SkillTool } from './tools/SkillTool/SkillTool.js'
import { SleepTool } from './tools/SleepTool/SleepTool.js'
import { CheckpointTool } from './tools/CheckpointTool/CheckpointTool.js'
import { RewindTool } from './tools/RewindTool/RewindTool.js'
import { StructureTool } from './tools/StructureTool/StructureTool.js'
import { SyntheticOutputTool } from './tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { TaskCreateTool } from './tools/TaskCreateTool/TaskCreateTool.js'
import { TaskGetTool } from './tools/TaskGetTool/TaskGetTool.js'
import { TaskListTool } from './tools/TaskListTool/TaskListTool.js'
import { TaskOutputTool } from './tools/TaskOutputTool/TaskOutputTool.js'
import { TaskStopTool } from './tools/TaskStopTool/TaskStopTool.js'
import { TaskUpdateTool } from './tools/TaskUpdateTool/TaskUpdateTool.js'
import { TeamBriefTool } from './tools/TeamBriefTool/TeamBriefTool.js'
import { TeamCreateTool } from './tools/TeamCreateTool/TeamCreateTool.js'
import { TeamDeleteTool } from './tools/TeamDeleteTool/TeamDeleteTool.js'
import { TestingPermissionTool } from './tools/testing/TestingPermissionTool.js'
import { TestTool } from './tools/TestTool/TestTool.js'
import { TodoWriteTool } from './tools/TodoWriteTool/TodoWriteTool.js'
import { ToolSearchTool } from './tools/ToolSearchTool/ToolSearchTool.js'
import { TransactionTool } from './tools/TransactionTool/TransactionTool.js'
import { WebFetchTool } from './tools/WebFetchTool/WebFetchTool.js'
import { WebSearchTool } from './tools/WebSearchTool/WebSearchTool.js'
import { ProviderSearchTool } from './tools/WebSearchTool/ProviderSearchTool.js'
import { WorkflowTool } from './tools/WorkflowTool/WorkflowTool.js'
import { WorkshopTool } from './tools/WorkshopTool/WorkshopTool.js'
import { REPL_ONLY_TOOLS } from './tools/REPLTool/constants.js'
import { isPowerShellToolEnabled } from './utils/shell/shellToolUtils.js'

// Feature resource adapters register their mercury:// kinds at module init;
// the catalogue is the load edge that makes a listed tool's resource plane
// resolvable (the census cross-checks declared kinds against the registry).
import './services/resources/adapters/git.js'
import './services/resources/adapters/journey.js'
import './services/resources/adapters/service.js'
import './services/resources/adapters/structure.js'
import './services/resources/adapters/test.js'
import './services/resources/adapters/ide.js'
// The slice-owned kinds the capability matrix and flag registry advertise
// (lane · mission · project · repo · transcript · workbench) load on the same
// edge — each adapter re-checks its slice's own enablement gate at resolve
// time, so a disabled slice still answers 'unavailable' rather than vanishing.
import './services/resources/adapters/lane.js'
import './services/resources/adapters/mission.js'
import './services/resources/adapters/project.js'
import './services/resources/adapters/repo.js'
import './services/resources/adapters/transcript.js'
import './services/resources/adapters/workbench.js'

/**
 * The tool catalogue: which tools exist in this environment, deny-rule
 * filtering, and assembly of the built-in + MCP pool the model is shown.
 *
 * The catalogue is rebuilt on every call — environment changes, mid-session
 * MCP connections and newly-installed binaries take effect at the next
 * assembly. The emission ORDER is load-bearing: the server keys a shared
 * system-prompt cache off a prefix of this list, so the order is stable
 * contract data, and a gated entry contributes nothing (the rest close up
 * without reordering).
 */

// Re-exports so callers have one import site.
export { ALL_AGENT_DISALLOWED_TOOLS, ASYNC_AGENT_ALLOWED_TOOLS, CUSTOM_AGENT_DISALLOWED_TOOLS }

// The REPL-only primitive tool names come from the leaf constants module:
// deriving them from the tool objects here runs inside the tool-module
// import cycle and freezes half-initialised bindings into the primitives
// cache before the cycle completes.
export { REPL_ONLY_TOOLS }

export const TOOL_PRESETS = ['default'] as const
export type ToolPreset = (typeof TOOL_PRESETS)[number]

/** Lowercases the input; anything not in the list is null. */
export function parseToolPreset(preset: string): ToolPreset | null {
  const lowered = preset.toLowerCase()
  return (TOOL_PRESETS as readonly string[]).includes(lowered)
    ? (lowered as ToolPreset)
    : null
}

/**
 * Resolve a possibly-cyclic module binding: during a circular
 * initialisation window the access throws (temporal dead zone) and the
 * entry is treated as absent; later builds see the settled binding.
 */
function cycleTolerant<T>(get: () => T): T | undefined {
  try {
    return get()
  } catch {
    return undefined
  }
}

// ── membership decisions frozen at module load ──────────────────────────────

/**
 * The scheduling gate for the cron cluster is read ONCE when this module
 * loads, from the local cron kill-switch environment variable, and never
 * re-evaluated — the four entries' membership is fixed for the process
 * lifetime.
 */
const SCHEDULING_ENABLED_AT_LOAD = !isEnvTruthy(flagEnv('MERCURY_SATURN_DISABLE'))

/** Checkpoint/rewind agent verbs: default ON; `MERCURY_CHECKPOINT_REWIND=0`
 *  opts out. Read live so a session flip takes effect on the next catalogue
 *  build. */
function checkpointRewindEnabled(): boolean {
  return flagEnv('MERCURY_CHECKPOINT_REWIND') !== '0'
}

/**
 * The require-loaded singleton entries are resolved once at catalogue-module
 * load. The bundled workflow registry is populated by the entry layer
 * (initBundledWorkflows, beside the bundled skills), not by importing the
 * tool module.
 */
const WORKFLOW_TOOL = cycleTolerant(() => WorkflowTool)
const SLEEP_TOOL = cycleTolerant(() => SleepTool)
const MONITOR_TOOL = cycleTolerant(() => MonitorTool)
const REMEMBER_LESSON_TOOL = cycleTolerant(() => RememberLessonTool)
const RECORD_CONVENTION_TOOL = cycleTolerant(() => RecordConventionTool)
const SEND_USER_FILE_TOOL = cycleTolerant(() => SendUserFileTool)
const PUSH_NOTIFICATION_TOOL = cycleTolerant(() => PushNotificationTool)

/** The REPL tool resolves to nothing in this build; the branches below stay
 *  (they are the contract — absence is a build-time resolution). */
const REPL_TOOL: Tool | null = null

/** REPL mode (inert while the REPL tool is build-absent). */
function isReplModeEnabled(): boolean {
  return process.env.USER_TYPE === 'ant'
}

/**
 * The full environment-respecting catalogue, in the contract order. Search
 * tools join only when no embedded binaries exist AND an external binary
 * probes available — never advertise a tool that would fail to launch.
 */
export function getAllBaseTools(): Tools {
  const search = searchToolsAvailability()
  const includeSearchTools = search.available && search.mode !== 'embedded'

  // Per-build cycle-tolerant resolutions.
  const teamCreate = cycleTolerant(() => TeamCreateTool)
  const teamDelete = cycleTolerant(() => TeamDeleteTool)
  const teamBrief = cycleTolerant(() => TeamBriefTool)
  const launchFleet = cycleTolerant(() => LaunchFleetTool)
  const artifactsList = cycleTolerant(() => ArtifactsListTool)
  const sendMessage = cycleTolerant(() => SendMessageTool)
  const powerShell = cycleTolerant(() => PowerShellTool)

  const tools: Array<Tool | null | undefined | false> = [
    AgentTool,
    TaskOutputTool,
    BashTool,
    ...(includeSearchTools ? [GlobTool, GrepTool] : []),
    ExitPlanModeV2Tool,
    FileReadTool,
    FileEditTool,
    FileWriteTool,
    NotebookEditTool,
    WebFetchTool,
    TodoWriteTool,
    WebSearchTool,
    ProviderSearchTool,
    TaskStopTool,
    AskUserQuestionTool,
    SkillTool,
    EnterPlanModeTool,
    ApolloReviewTool,
    ...(isTodoV2Enabled() ? [TaskCreateTool, TaskGetTool, TaskUpdateTool, TaskListTool] : []),
    ...(isLspToolCatalogEnabled() ? [LSPTool] : []),
    ...(mercuryRefsEnabled() ? [InspectTool] : []),
    ...(workshopEnabled() ? [WorkshopTool] : []),
    ...(servicesEnabled() ? [ServiceTool] : []),
    ...(isDapToolCatalogEnabled() ? [DebugTool] : []),
    ...(pythonTestsEnabled() ? [TestTool] : []),
    ...(evalEnabled() ? [EvalTool] : []),
    ...(launchProfilesEnabled() ? [LaunchTool] : []),
    ...(ideLoopEnabled() ? [TransactionTool] : []),
    ...(structureEnabled() ? [StructureTool] : []),
    ...(structurePolyglotEnabled() ? [AstSearchTool, AstEditTool] : []),
    ...(changeSetEnabled() ? [ChangeSetTool] : []),
    ...(gitGraphEnabled() ? [GitTool] : []),
    ...(journeysEnabled() ? [JourneyTool] : []),
    ...(browserToolEnabled() ? [BrowserTool] : []),
    ...(vulcanToolCatalogEnabled() ? [GodotTool] : []),
    ...(unityBridgeToolCatalogEnabled() ? [UnityTool] : []),
    ...(blenderBridgeToolCatalogEnabled() ? [BlenderTool] : []),
    ...(asepriteToolCatalogEnabled() ? [AsepriteTool] : []),
    ...(isAutopilotEnabled() ? [SetTierTool] : []),
    ...(isWorktreeModeEnabled() ? [EnterWorktreeTool, ExitWorktreeTool] : []),
    // Checkpoint/rewind agent verbs (spec 07-C4): default ON, the flag
    // opts out. Context-only by contract — never files/git.
    ...(checkpointRewindEnabled() ? [CheckpointTool, RewindTool] : []),
    sendMessage,
    ...(isAgentSwarmsEnabled() && teamCreate && teamDelete && teamBrief
      ? [teamCreate, teamDelete, teamBrief, ...(launchFleet ? [launchFleet] : []), ...(artifactsList ? [artifactsList] : [])]
      : []),
    WORKFLOW_TOOL,
    SLEEP_TOOL,
    ...(SCHEDULING_ENABLED_AT_LOAD
      ? [CronCreateTool, CronDeleteTool, CronListTool, ScheduleWakeupTool]
      : []),
    MONITOR_TOOL,
    BriefTool,
    // The ABIDE TOOL (coordinator-tooling T3+T4): daemon-hosted sessions
    // only — the role stamp is fixed at spawn, so membership is stable for
    // the process lifetime (the catalogue-order law holds).
    ...(contractToolHosted() ? [ContractTool] : []),
    REMEMBER_LESSON_TOOL,
    RECORD_CONVENTION_TOOL,
    ...(memoryVerbsEnabled() ? [RetainTool, RecallTool, ReflectTool, CorrectTool] : []),
    SEND_USER_FILE_TOOL,
    PUSH_NOTIFICATION_TOOL,
    ...(isPowerShellToolEnabled() && powerShell ? [powerShell] : []),
    ...(process.env.NODE_ENV === 'test' ? [TestingPermissionTool] : []),
    ListMcpResourcesTool,
    ReadMcpResourceTool,
    ...(isToolSearchEnabledOptimistic() ? [ToolSearchTool] : []),
  ]
  // A disabled conditional entry must never leave a null in the list.
  return tools.filter((tool): tool is Tool => Boolean(tool))
}

/** Enabled tool names for the default preset — every candidate's enabled
 *  predicate is evaluated first, for all candidates, then filtered. */
export function getToolsForDefaultPreset(): string[] {
  const candidates = getAllBaseTools()
  const enabled = candidates.map(tool => {
    try {
      return tool.isEnabled()
    } catch {
      return false
    }
  })
  return candidates.filter((_, index) => enabled[index]).map(tool => tool.name)
}

/**
 * Remove tools a blanket deny rule names — the SAME matcher used at
 * runtime permission time, so an MCP server-prefix deny strips every tool
 * from that server before the model sees them.
 */
export function filterToolsByDenyRules<T extends { name: string; mcpInfo?: unknown }>(
  tools: readonly T[],
  permissionContext: ToolPermissionContext,
): T[] {
  return tools.filter(tool => {
    const rule = getDenyRuleForTool(permissionContext, tool as never)
    if (!rule) return true
    // Only a blanket deny (no rule content) removes the tool wholesale.
    return rule.ruleValue.ruleContent !== undefined && rule.ruleValue.ruleContent !== null
  })
}

/** Names never surfaced through getTools (added by other layers). */
const SPECIAL_TOOL_NAMES = new Set([
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  SyntheticOutputTool.name,
])

/**
 * The session tool list. In simple mode only deny-rule filtering applies —
 * the enabled predicates are NOT evaluated. Otherwise: remove the special
 * tools, apply deny rules, strip REPL-only primitives when the REPL tool
 * survived filtering, then keep enabled tools — with every candidate's
 * enabled predicate evaluated before any filtering (predicates may have
 * observable side effects, and consistency across the list matters).
 */
export function getTools(permissionContext: ToolPermissionContext): Tools {
  if (isEnvTruthy(process.env.MERCURY_SIMPLE)) {
    if (isReplModeEnabled() && REPL_TOOL) {
      return filterToolsByDenyRules([REPL_TOOL], permissionContext)
    }
    return filterToolsByDenyRules([BashTool, FileReadTool, FileEditTool] as Tool[], permissionContext)
  }
  const base = getAllBaseTools().filter(tool => !SPECIAL_TOOL_NAMES.has(tool.name))
  let filtered = filterToolsByDenyRules(base, permissionContext)
  if (isReplModeEnabled() && REPL_TOOL && filtered.some(tool => toolMatchesName(tool, (REPL_TOOL as Tool).name))) {
    filtered = filtered.filter(tool => !REPL_ONLY_TOOLS.has(tool.name))
  }
  const enabled = filtered.map(tool => {
    try {
      return tool.isEnabled()
    } catch {
      return false
    }
  })
  return filtered.filter((_, index) => enabled[index])
}

/**
 * The pool the model is shown: built-ins as a contiguous name-sorted
 * prefix, then deny-filtered MCP tools (minus `blocked`-ceiling tools)
 * name-sorted, deduped by name with built-ins winning. The two partitions
 * are never merged into one flat sort: the shared system-prompt cache is
 * keyed off a prefix of this list and the cut point is the end of the
 * built-in run — interleaving even one MCP tool would move the cut.
 */
export function assembleToolPool(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtins = [...getTools(permissionContext)]
  const mcp = filterToolsByDenyRules(mcpTools, permissionContext).filter(
    tool => tool.mcpInfo?.effectiveMaxPermission !== 'blocked',
  )
  builtins.sort((a, b) => a.name.localeCompare(b.name))
  const sortedMcp = [...mcp].sort((a, b) => a.name.localeCompare(b.name))
  const seen = new Set<string>()
  const pool: Tool[] = []
  for (const tool of [...builtins, ...sortedMcp]) {
    if (seen.has(tool.name)) continue
    seen.add(tool.name)
    pool.push(tool)
  }
  return pool
}

/** Plain concatenation for counting/threshold purposes — no sorting, no
 *  dedup, no blocked filtering. Not interchangeable with assembleToolPool. */
export function getMergedTools(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  return [...getTools(permissionContext), ...mcpTools]
}
