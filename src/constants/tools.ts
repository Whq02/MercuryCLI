// ============================================================================
//  src/constants/tools.ts — agent tool allow/deny sets, composed from the
//  tool-name constants their owners export. Recorded reasons for the
//  blocks: the agent and task-output tools block recursion; exit-plan-mode
//  is a main-thread abstraction; task-stop needs main-thread task state;
//  the virtual-terminal tool's singleton conflicts between agents.
// ============================================================================
import { AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../tools/AskUserQuestionTool/prompt.js'
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import {
  EXIT_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_V2_TOOL_NAME,
} from '../tools/ExitPlanModeTool/constants.js'
import { ENTER_WORKTREE_TOOL_NAME } from '../tools/EnterWorktreeTool/constants.js'
import { EXIT_WORKTREE_TOOL_NAME } from '../tools/ExitWorktreeTool/constants.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../tools/GrepTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../tools/NotebookEditTool/constants.js'
import { POWERSHELL_TOOL_NAME } from '../tools/PowerShellTool/toolName.js'
import {
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  CRON_LIST_TOOL_NAME,
} from '../tools/ScheduleCronTool/prompt.js'
import { SEND_MESSAGE_TOOL_NAME } from '../tools/SendMessageTool/constants.js'
import { SKILL_TOOL_NAME } from '../tools/SkillTool/constants.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../tools/SyntheticOutputTool/constants.js'
import { TASK_CREATE_TOOL_NAME } from '../tools/TaskCreateTool/constants.js'
import { TASK_GET_TOOL_NAME } from '../tools/TaskGetTool/constants.js'
import { TASK_LIST_TOOL_NAME } from '../tools/TaskListTool/constants.js'
import { TASK_OUTPUT_TOOL_NAME } from '../tools/TaskOutputTool/constants.js'
import { TASK_STOP_TOOL_NAME } from '../tools/TaskStopTool/prompt.js'
import { TASK_UPDATE_TOOL_NAME } from '../tools/TaskUpdateTool/constants.js'
import { TODO_WRITE_TOOL_NAME } from '../tools/TodoWriteTool/constants.js'
import { TOOL_SEARCH_TOOL_NAME } from '../tools/ToolSearchTool/constants.js'
import { WEB_FETCH_TOOL_NAME } from '../tools/WebFetchTool/prompt.js'
import { PROVIDER_SEARCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from '../tools/WebSearchTool/prompt.js'
import { WORKFLOW_TOOL_NAME } from '../tools/WorkflowTool/constants.js'

/**
 * Tools no agent may hold: the task-output tool, both plan-mode tools, the
 * agent tool itself (recursion — the internal-build escape is folded in),
 * the ask-user-question tool, the task-stop tool, and the workflow tool
 * (recursive workflow execution inside subagents).
 */
export const ALL_AGENT_DISALLOWED_TOOLS: Set<string> = new Set([
  TASK_OUTPUT_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_V2_TOOL_NAME,
  AGENT_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  WORKFLOW_TOOL_NAME,
])

/** Currently the same set — ONE set, aliased, not a duplicate literal. */
export const CUSTOM_AGENT_DISALLOWED_TOOLS: Set<string> = ALL_AGENT_DISALLOWED_TOOLS

export const ASYNC_AGENT_ALLOWED_TOOLS: Set<string> = new Set([
  FILE_READ_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  PROVIDER_SEARCH_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  GREP_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  GLOB_TOOL_NAME,
  BASH_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  SKILL_TOOL_NAME,
  SYNTHETIC_OUTPUT_TOOL_NAME,
  TOOL_SEARCH_TOOL_NAME,
  ENTER_WORKTREE_TOOL_NAME,
  EXIT_WORKTREE_TOOL_NAME,
])

/**
 * Injected by the in-process runner and admitted by the agent-tool filter
 * via a teammate check. The cron tools' presence is a Mercury fix: the
 * substrate ships on and teammate cron routing was live, but a bare feature
 * gate had folded the tools out of the allow-list so teammates could never
 * schedule.
 */
export const IN_PROCESS_TEAMMATE_ALLOWED_TOOLS: Set<string> = new Set([
  TASK_CREATE_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  CRON_LIST_TOOL_NAME,
])
