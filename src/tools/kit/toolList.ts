import type { Tool, ToolPermissionContext, Tools } from './tool.js'
import { getIsNonInteractiveSession } from '../../boot/process-state/processState.js'
import { swarmTools } from '../../crew/board/seam.js'
import { withBundledAppInstallConsent } from '../../integrations/extensions/installConsent.js'
import { isEnvTruthy } from '../../platform/environment/envUtils.js'
import { flagEnabled, flagEnv } from '../../platform/substrate/flagRegistry.js'
import { getDenyRuleForTool } from '../../permissions/rules/permissionDoor.js'
import type { PermissionRule } from '../../permissions/rules/permissions.js'
import { searchToolsAvailability } from '../../platform/shell/ripgrep.js'
import { isTaskToolsEnabled } from '../../engine/task-framework/tasks.js'
import { isWorktreeModeEnabled } from '../../boot/main/worktreeModeEnabled.js'
import { vulcanToolCatalogEnabled } from '../../integrations/vulcan/vulcanGates.js'
import { unityBridgeToolCatalogEnabled } from '../../integrations/unity-protocol/bridgeGates.js'
import { blenderBridgeToolCatalogEnabled } from '../../integrations/blender-protocol/bridgeGates.js'
import { asepriteToolCatalogEnabled } from '../../integrations/aseprite/gates.js'
import { BrowserTool, browserToolEnabled } from '../browser/BrowserTool.js'
import { ComputerTool, computerToolEnabled } from '../computer/ComputerTool.js'
import { VideoTool } from '../video/VideoTool.js'
import { videoToolEnabled } from '../../integrations/media-video/registry.js'
import { changeSetEnabled } from '../engines/change-transaction/changeSetContracts.js'
import { changeTransactionEnabled } from '../engines/change-transaction/contracts.js'
import { txAutoCaptureEnabled } from '../../integrations/ide/txAutoCapture.js'
import { isDapToolCatalogEnabled } from '../../integrations/debugger/dapClient.js'
import { gitGraphEnabled } from '../../platform/git-graph/contracts.js'
import { ideLoopEnabled } from '../../integrations/ide/ideTransaction.js'
import { launchProfilesEnabled } from '../../integrations/ide/launchProfiles.js'
import { pythonTestsEnabled } from '../../integrations/ide/pythonTests.js'
import { journeysEnabled } from '../engines/journeys/contracts.js'
import { isLspToolCatalogEnabled } from '../../integrations/lsp/mercuryLsp.js'
import { servicesEnabled } from '../engines/project-services/contracts.js'
import { mercuryRefsEnabled } from '../../integrations/resources/contracts.js'
import { structureEnabled, structurePolyglotEnabled } from '../engines/structure/contracts.js'
import { isToolSearchEnabledOptimistic } from '../../engine/messages/toolSearch.js'

import { CrewmateTool } from '../crewmate/CrewmateTool.js'
import { AstEditTool } from '../ast-edit/AstEditTool.js'
import { AstSearchTool } from '../ast-search/AstSearchTool.js'
import { ApolloReviewTool } from '../apollo-review/ApolloReviewTool.js'
import { AskUserQuestionTool } from '../ask-question/AskUserQuestionTool.js'
import { BashTool } from '../shell/BashTool.js'
import { ChangeSetTool } from '../change-set/ChangeSetTool.js'
import { ContextLeftTool } from '../context-left/ContextLeftTool.js'
import { DebugTool } from '../debug/DebugTool.js'
import { EvalTool } from '../eval/EvalTool.js'
import { evalEnabled } from '../engines/eval-kernels/contracts.js'
import { EnterWorktreeTool } from '../enter-worktree/EnterWorktreeTool.js'
import { ExitWorktreeTool } from '../exit-worktree/ExitWorktreeTool.js'
import { EditTool } from '../edit/EditTool.js'
import { ReadTool } from '../read/ReadTool.js'
import { WriteTool } from '../write/WriteTool.js'
import { GitTool } from '../git/GitTool.js'
import { GlobTool } from '../glob/GlobTool.js'
import { GodotTool } from '../godot/GodotTool.js'
import { UnityTool } from '../unity/UnityTool.js'
import { BlenderTool } from '../blender/BlenderTool.js'
import { AsepriteTool } from '../aseprite/AsepriteTool.js'
import { GrepTool } from '../grep/GrepTool.js'
import { InspectTool } from '../inspect/InspectTool.js'
import { JevEvalTool, jevEvalEnabled } from '../jev-eval/JevEvalTool.js'
import { AskAdvisorTool } from '../ask-advisor/AskAdvisorTool.js'
import { advisorEnabled } from '../../models/advisor/advisorSettings.js'
import { JourneyTool } from '../journey/JourneyTool.js'
import { JournalTool } from '../journal/JournalTool.js'
import { journalEnabled } from '../../sessions/mneme/journal.js'
import { LaunchTool } from '../launch/LaunchTool.js'
import { ListMcpResourcesTool } from '../list-mcp-resources/ListMcpResourcesTool.js'
import { LSP_TOOLS } from '../lsp/lspTools.js'
import { MonitorTool } from '../monitor/MonitorTool.js'
import { NotebookEditTool } from '../notebook-edit/NotebookEditTool.js'
import {
  CorrectTool,
  RecallTool,
  ReflectTool,
  RetainTool,
} from '../memory/MemoryTools.js'
import { memoryVerbsEnabled } from '../../sessions/mneme/memoryVerbs.js'
import { PowerShellTool } from '../powershell/PowerShellTool.js'
import { ReadMcpResourceTool } from '../read-mcp-resource/ReadMcpResourceTool.js'
import { RecordConventionTool } from '../record-convention/RecordConventionTool.js'
import { CronCreateTool } from '../cron/CronCreateTool.js'
import { CronDeleteTool } from '../cron/CronDeleteTool.js'
import { CronListTool } from '../cron/CronListTool.js'
import { ScheduleWakeupTool } from '../schedule-wakeup/ScheduleWakeupTool.js'
import { SendMessageTool } from '../send-message/SendMessageTool.js'
import { ResumeCrewmateTool } from '../resume-crewmate/ResumeCrewmateTool.js'
import { ServiceTool } from '../service/ServiceTool.js'
import { SkillTool } from '../skill/SkillTool.js'
import { SleepTool } from '../sleep/SleepTool.js'
import { CheckpointTool } from '../checkpoint/CheckpointTool.js'
import { RewindTool } from '../rewind/RewindTool.js'
import { StructureTool } from '../structure/StructureTool.js'
import { DocumentTool } from '../document/DocumentTool.js'
import { StructuredOutputTool } from '../structured-output/StructuredOutputTool.js'
import { TaskCreateTool } from '../task-create/TaskCreateTool.js'
import { TaskGetTool } from '../task-get/TaskGetTool.js'
import { TaskListTool } from '../task-list/TaskListTool.js'
import { TaskStopTool } from '../task-stop/TaskStopTool.js'
import { TaskUpdateTool } from '../task-update/TaskUpdateTool.js'
import { TestingPermissionTool } from '../testing-permission/TestingPermissionTool.js'
import { TestTool } from '../test/TestTool.js'
import { ToolSearchTool } from '../tool-search/ToolSearchTool.js'
import { TransactionTool } from '../transaction/TransactionTool.js'
import { WebFetchTool } from '../web-fetch/WebFetchTool.js'
import { WebSearchTool } from '../web-search/WebSearchTool.js'
import { ProviderSearchTool } from '../web-search/ProviderSearchTool.js'
import { beginLoginFiles } from '../../platform/shell/shellRecord.js'
import { isPowerShellToolEnabled } from './shellTools.js'

import { tellTheToolTable } from './toolTable.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { logError } from '../../platform/logs/errorLog.js'


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
    CrewmateTool,
    BashTool,
    ...(searchReady ? [GlobTool, GrepTool] : []),
    ReadTool,
    EditTool,
    WriteTool,
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
    cycleTolerant(() => ResumeCrewmateTool),
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
  StructuredOutputTool.name,
])

export function getTools(permissionContext: ToolPermissionContext, agentId?: string): Tools {
  const settled = settledTools(permissionContext, agentId)
  if (getIsNonInteractiveSession() && settled.some(tool => tool.name === BashTool.name)) beginLoginFiles()
  return settled
}

function settledTools(permissionContext: ToolPermissionContext, agentId?: string): Tools {
  const selected = permissionContext.baseTools
  if (selected === undefined && isEnvTruthy(flagEnv('MERCURY_BARE'))) {
    return filterToolsByDenyRules([BashTool, ReadTool, EditTool, WriteTool] as Tool[], permissionContext)
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
