import type { Tool, ToolPermissionContext, Tools } from './Tool.js'
import { getIsNonInteractiveSession } from './bootstrap/state.js'
import { swarmTools } from './services/crewBoard/seam.js'
import { withBundledAppInstallConsent } from './extensions/installConsent.js'
import { isEnvTruthy } from './utils/envUtils.js'
import { flagEnabled, flagEnv } from './substrate/flagRegistry.js'
import { getDenyRuleForTool } from './utils/permissions/permissions.js'
import type { PermissionRule } from './types/permissions.js'
import { searchToolsAvailability } from './utils/ripgrep.js'
import { isTaskToolsEnabled } from './utils/tasks.js'
import { isWorktreeModeEnabled } from './utils/worktreeModeEnabled.js'
import { vulcanToolCatalogEnabled } from './services/vulcan/vulcanGates.js'
import { unityBridgeToolCatalogEnabled } from './utils/unity/bridgeGates.js'
import { blenderBridgeToolCatalogEnabled } from './utils/blender/bridgeGates.js'
import { asepriteToolCatalogEnabled } from './utils/aseprite/gates.js'
import { BrowserTool, browserToolEnabled } from './tools/BrowserTool/BrowserTool.js'
import { ComputerTool, computerToolEnabled } from './tools/ComputerTool/ComputerTool.js'
import { VideoTool } from './tools/VideoTool/VideoTool.js'
import { videoToolEnabled } from './services/video/registry.js'
import { changeSetEnabled } from './services/changeTransaction/changeSetContracts.js'
import { changeTransactionEnabled } from './services/changeTransaction/contracts.js'
import { txAutoCaptureEnabled } from './services/ide/txAutoCapture.js'
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
import { isToolSearchEnabledOptimistic } from './services/messages/toolSearch.js'

import { AgentTool } from './tools/AgentTool/AgentTool.js'
import { AstEditTool } from './tools/AstEditTool/AstEditTool.js'
import { AstSearchTool } from './tools/AstSearchTool/AstSearchTool.js'
import {
  ALL_AGENT_DISALLOWED_TOOLS,
  CUSTOM_AGENT_DISALLOWED_TOOLS,
} from './constants/tools.js'
import { ApolloReviewTool } from './tools/ApolloReviewTool/ApolloReviewTool.js'
import { AskUserQuestionTool } from './tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { BashTool } from './tools/BashTool/BashTool.js'
import { ChangeSetTool } from './tools/ChangeSetTool/ChangeSetTool.js'
import { ContextLeftTool } from './tools/ContextLeftTool/ContextLeftTool.js'
import { DebugTool } from './tools/DebugTool/DebugTool.js'
import { EvalTool } from './tools/EvalTool/EvalTool.js'
import { evalEnabled } from './services/eval/contracts.js'
import { EnterWorktreeTool } from './tools/EnterWorktreeTool/EnterWorktreeTool.js'
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
import { JevEvalTool, jevEvalEnabled } from './tools/JevEvalTool/JevEvalTool.js'
import { AskAdvisorTool } from './tools/AskAdvisorTool/AskAdvisorTool.js'
import { advisorEnabled } from './services/advisor/advisorSettings.js'
import { JourneyTool } from './tools/JourneyTool/JourneyTool.js'
import { JournalTool } from './tools/JournalTool/JournalTool.js'
import { journalEnabled } from './mneme/journal.js'
import { LaunchTool } from './tools/LaunchTool/LaunchTool.js'
import { ListMcpResourcesTool } from './tools/ListMcpResourcesTool/ListMcpResourcesTool.js'
import { LSP_TOOLS } from './tools/LSPTool/LSPTool.js'
import { MonitorTool } from './tools/MonitorTool/MonitorTool.js'
import { NotebookEditTool } from './tools/NotebookEditTool/NotebookEditTool.js'
import {
  CorrectTool,
  RecallTool,
  ReflectTool,
  RetainTool,
} from './tools/MemoryTools/MemoryTools.js'
import { memoryVerbsEnabled } from './mneme/memoryVerbs.js'
import { PowerShellTool } from './tools/PowerShellTool/PowerShellTool.js'
import { ReadMcpResourceTool } from './tools/ReadMcpResourceTool/ReadMcpResourceTool.js'
import { RecordConventionTool } from './tools/RecordConventionTool/RecordConventionTool.js'
import { CronCreateTool } from './tools/ScheduleCronTool/CronCreateTool.js'
import { CronDeleteTool } from './tools/ScheduleCronTool/CronDeleteTool.js'
import { CronListTool } from './tools/ScheduleCronTool/CronListTool.js'
import { ScheduleWakeupTool } from './tools/ScheduleWakeupTool/ScheduleWakeupTool.js'
import { SendMessageTool } from './tools/SendMessageTool/SendMessageTool.js'
import { ResumeAgentTool } from './tools/ResumeAgentTool/ResumeAgentTool.js'
import { ServiceTool } from './tools/ServiceTool/ServiceTool.js'
import { SkillTool } from './tools/SkillTool/SkillTool.js'
import { SleepTool } from './tools/SleepTool/SleepTool.js'
import { CheckpointTool } from './tools/CheckpointTool/CheckpointTool.js'
import { RewindTool } from './tools/RewindTool/RewindTool.js'
import { StructureTool } from './tools/StructureTool/StructureTool.js'
import { DocumentTool } from './tools/DocumentTool/DocumentTool.js'
import { SyntheticOutputTool } from './tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { TaskCreateTool } from './tools/TaskCreateTool/TaskCreateTool.js'
import { TaskGetTool } from './tools/TaskGetTool/TaskGetTool.js'
import { TaskListTool } from './tools/TaskListTool/TaskListTool.js'
import { TaskStopTool } from './tools/TaskStopTool/TaskStopTool.js'
import { TaskUpdateTool } from './tools/TaskUpdateTool/TaskUpdateTool.js'
import { TestingPermissionTool } from './tools/testing/TestingPermissionTool.js'
import { TestTool } from './tools/TestTool/TestTool.js'
import { ToolSearchTool } from './tools/ToolSearchTool/ToolSearchTool.js'
import { TransactionTool } from './tools/TransactionTool/TransactionTool.js'
import { WebFetchTool } from './tools/WebFetchTool/WebFetchTool.js'
import { WebSearchTool } from './tools/WebSearchTool/WebSearchTool.js'
import { ProviderSearchTool } from './tools/WebSearchTool/ProviderSearchTool.js'
import { beginLoginFiles } from './utils/shell/shellRecord.js'
import { isPowerShellToolEnabled } from './utils/shell/shellToolUtils.js'

import { tellTheToolTable } from './tools/toolTable.js'
import { passedOver } from './utils/passedOver.js'
import { logError } from './utils/log.js'


export { ALL_AGENT_DISALLOWED_TOOLS, CUSTOM_AGENT_DISALLOWED_TOOLS }


function cycleTolerant<T>(get: () => T): T | undefined {
  try {
    return get()
  } catch (error) {
    if (!(error instanceof ReferenceError)) logError(error)
    passedOver(error)
    return undefined
  }
}


const SCHEDULING_ENABLED_AT_LOAD = !isEnvTruthy(flagEnv('MERCURY_SATURN_DISABLE'))

function checkpointRewindEnabled(): boolean {
  return flagEnabled('MERCURY_CHECKPOINT_REWIND')
}

const SLEEP_TOOL = cycleTolerant(() => SleepTool)
const MONITOR_TOOL = cycleTolerant(() => MonitorTool)
const RECORD_CONVENTION_TOOL = cycleTolerant(() => RecordConventionTool)

export function getAllBaseTools(agentId?: string): Tools {
  const search = searchToolsAvailability()
  const searchReady = search.available && search.mode !== 'embedded'
  const candidates: Array<Tool | false | null | undefined> = [
    AgentTool,
    BashTool,
    ...(searchReady ? [GlobTool, GrepTool] : []),
    FileReadTool,
    FileEditTool,
    FileWriteTool,
    NotebookEditTool,
    WebFetchTool,
    WebSearchTool,
    ProviderSearchTool,
    TaskStopTool,
    AskUserQuestionTool,
    SkillTool,
    ApolloReviewTool,
    ...(isTaskToolsEnabled() ? [TaskCreateTool, TaskGetTool, TaskUpdateTool, TaskListTool] : []),
    ...(isLspToolCatalogEnabled() ? LSP_TOOLS : []),
    mercuryRefsEnabled() && InspectTool,
    servicesEnabled() && ServiceTool,
    isDapToolCatalogEnabled() && DebugTool,
    pythonTestsEnabled() && TestTool,
    evalEnabled() && EvalTool,
    launchProfilesEnabled() && LaunchTool,
    ideLoopEnabled() && changeTransactionEnabled() && txAutoCaptureEnabled() && TransactionTool,
    structureEnabled() && StructureTool,
    ...(structurePolyglotEnabled() ? [AstSearchTool, AstEditTool] : []),
    changeSetEnabled() && ChangeSetTool,
    gitGraphEnabled() && GitTool,
    journeysEnabled() && JourneyTool,
    browserToolEnabled() && BrowserTool,
    computerToolEnabled() && ComputerTool,
    videoToolEnabled() && VideoTool,
    vulcanToolCatalogEnabled() && GodotTool,
    unityBridgeToolCatalogEnabled() && UnityTool,
    blenderBridgeToolCatalogEnabled() && BlenderTool,
    asepriteToolCatalogEnabled() && AsepriteTool,
    jevEvalEnabled() && JevEvalTool,
    advisorEnabled() && AskAdvisorTool,
    ...(isWorktreeModeEnabled() ? [EnterWorktreeTool, ExitWorktreeTool] : []),
    ...(checkpointRewindEnabled() ? [CheckpointTool, RewindTool] : []),
    cycleTolerant(() => SendMessageTool),
    ...swarmTools(agentId),
    cycleTolerant(() => ResumeAgentTool),
    SLEEP_TOOL,
    ...(SCHEDULING_ENABLED_AT_LOAD ? [CronCreateTool, CronDeleteTool, CronListTool, ScheduleWakeupTool] : []),
    MONITOR_TOOL,
    ContextLeftTool,
    RECORD_CONVENTION_TOOL,
    ...(memoryVerbsEnabled() ? [RetainTool, RecallTool, ReflectTool, CorrectTool] : []),
    journalEnabled() && JournalTool,
    isPowerShellToolEnabled() && cycleTolerant(() => PowerShellTool),
    process.env.NODE_ENV === 'test' && TestingPermissionTool,
    ListMcpResourcesTool,
    ReadMcpResourceTool,
    isToolSearchEnabledOptimistic() && ToolSearchTool,
    DocumentTool,
  ]
  return candidates.filter((tool): tool is Tool => Boolean(tool))
}

export function filterToolsByDenyRules<T extends Pick<Tool, 'name' | 'mcpInfo'>>(
  tools: readonly T[],
  permissionContext: ToolPermissionContext,
): T[] {
  return tools.filter(tool => wholeToolDenyRuleFor(tool, permissionContext) === null)
}

function wholeToolDenyRuleFor(tool: Pick<Tool, 'name' | 'mcpInfo'>, permissionContext: ToolPermissionContext): PermissionRule | null {
  const rule = getDenyRuleForTool(permissionContext, tool)
  if (!rule) return null
  return rule.ruleValue.ruleContent !== undefined && rule.ruleValue.ruleContent !== null ? null : rule
}

export function toolsWithheldByDeny(
  tools: readonly Pick<Tool, 'name' | 'mcpInfo'>[],
  permissionContext: ToolPermissionContext,
): Array<{ tool: string; rule: PermissionRule }> {
  const out: Array<{ tool: string; rule: PermissionRule }> = []
  for (const tool of tools) {
    const rule = wholeToolDenyRuleFor(tool, permissionContext)
    if (rule !== null) out.push({ tool: tool.name, rule })
  }
  return out
}

const SPECIAL_TOOL_NAMES = new Set([
  'ListMcpResources',
  'ReadMcpResource',
  SyntheticOutputTool.name,
])

export function getTools(permissionContext: ToolPermissionContext, agentId?: string): Tools {
  const settled = settledTools(permissionContext, agentId)
  if (getIsNonInteractiveSession() && settled.some(tool => tool.name === BashTool.name)) beginLoginFiles()
  return settled
}

function settledTools(permissionContext: ToolPermissionContext, agentId?: string): Tools {
  const selected = permissionContext.baseTools
  if (selected === undefined && isEnvTruthy(flagEnv('MERCURY_BARE'))) {
    return filterToolsByDenyRules([BashTool, FileReadTool, FileEditTool, FileWriteTool] as Tool[], permissionContext)
  }
  const base = getAllBaseTools(agentId).filter(tool => !SPECIAL_TOOL_NAMES.has(tool.name) && (selected === undefined || selected.includes(tool.name)))
  const filtered = filterToolsByDenyRules(base, permissionContext)
  const enabled = filtered.map(tool => {
    try {
      return tool.isEnabled()
    } catch (error) {
      logError(error)
      passedOver(error)
      return false
    }
  })
  return filtered.filter((_, index) => enabled[index])
}

export function assembleToolPool(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
  agentId?: string,
): Tools {
  const builtIns = [...getTools(permissionContext, agentId)].sort((a, b) => a.name.localeCompare(b.name))
  const mcp = mcpToolPartition(mcpTools, permissionContext)
  const seen = new Set<string>()
  const pool: Tool[] = []
  for (const tool of [...builtIns, ...mcp]) {
    if (seen.has(tool.name)) continue
    seen.add(tool.name)
    pool.push(tool)
  }
  return pool
}

export function mcpToolPartition(mcpTools: Tools, permissionContext: ToolPermissionContext): Tool[] {
  const allowed = filterToolsByDenyRules(mcpTools, permissionContext).filter(
    tool => tool.mcpInfo?.effectiveMaxPermission !== 'blocked',
  )
  return allowed
    .map(tool => withBundledAppInstallConsent(tool))
    .sort((a, b) => a.name.localeCompare(b.name))
}

tellTheToolTable({ getAllBaseTools, assembleToolPool })
