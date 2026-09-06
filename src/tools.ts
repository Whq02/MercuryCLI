import type { Tool, ToolPermissionContext, Tools } from './Tool.js'
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

import './services/resources/adapters/git.js'
import './services/resources/adapters/journey.js'
import './services/resources/adapters/service.js'
import './services/resources/adapters/structure.js'
import './services/resources/adapters/test.js'
import './services/resources/adapters/ide.js'
import './services/resources/adapters/lane.js'
import './services/resources/adapters/mission.js'
import './services/resources/adapters/project.js'
import './services/resources/adapters/repo.js'
import './services/resources/adapters/transcript.js'
import './services/resources/adapters/workbench.js'


export { ALL_AGENT_DISALLOWED_TOOLS, ASYNC_AGENT_ALLOWED_TOOLS, CUSTOM_AGENT_DISALLOWED_TOOLS }

export { REPL_ONLY_TOOLS }

export const TOOL_PRESETS = ['default'] as const
export type ToolPreset = (typeof TOOL_PRESETS)[number]

export function parseToolPreset(preset: string): ToolPreset | null {
  const lowered = preset.toLowerCase()
  return (TOOL_PRESETS as readonly string[]).includes(lowered)
    ? (lowered as ToolPreset)
    : null
}

function cycleTolerant<T>(get: () => T): T | undefined {
  try {
    return get()
  } catch {
    return undefined
  }
}


const SCHEDULING_ENABLED_AT_LOAD = !isEnvTruthy(flagEnv('MERCURY_SATURN_DISABLE'))

function checkpointRewindEnabled(): boolean {
  return flagEnv('MERCURY_CHECKPOINT_REWIND') !== '0'
}

const WORKFLOW_TOOL = cycleTolerant(() => WorkflowTool)
const SLEEP_TOOL = cycleTolerant(() => SleepTool)
const MONITOR_TOOL = cycleTolerant(() => MonitorTool)
const REMEMBER_LESSON_TOOL = cycleTolerant(() => RememberLessonTool)
const RECORD_CONVENTION_TOOL = cycleTolerant(() => RecordConventionTool)
const SEND_USER_FILE_TOOL = cycleTolerant(() => SendUserFileTool)
const PUSH_NOTIFICATION_TOOL = cycleTolerant(() => PushNotificationTool)

export function getAllBaseTools(): Tools {
  const search = searchToolsAvailability()
  const includeSearchTools = search.available && search.mode !== 'embedded'

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
  return tools.filter((tool): tool is Tool => Boolean(tool))
}

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

export function filterToolsByDenyRules<T extends { name: string; mcpInfo?: unknown }>(
  tools: readonly T[],
  permissionContext: ToolPermissionContext,
): T[] {
  return tools.filter(tool => {
    const rule = getDenyRuleForTool(permissionContext, tool as never)
    if (!rule) return true
    return rule.ruleValue.ruleContent !== undefined && rule.ruleValue.ruleContent !== null
  })
}

const SPECIAL_TOOL_NAMES = new Set([
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  SyntheticOutputTool.name,
])

export function getTools(permissionContext: ToolPermissionContext): Tools {
  if (isEnvTruthy(process.env.MERCURY_SIMPLE)) {
    return filterToolsByDenyRules([BashTool, FileReadTool, FileEditTool] as Tool[], permissionContext)
  }
  const base = getAllBaseTools().filter(tool => !SPECIAL_TOOL_NAMES.has(tool.name))
  const filtered = filterToolsByDenyRules(base, permissionContext)
  const enabled = filtered.map(tool => {
    try {
      return tool.isEnabled()
    } catch {
      return false
    }
  })
  return filtered.filter((_, index) => enabled[index])
}

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

export function getMergedTools(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  return [...getTools(permissionContext), ...mcpTools]
}
