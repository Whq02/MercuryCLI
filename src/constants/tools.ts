import { AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../tools/AskUserQuestionTool/prompt.js'
import { COMPUTER_TOOL_NAME } from '../services/desktop/toolName.js'
import { JEV_TOOL_NAME } from '../services/jev/jevContract.js'
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import { CONTEXT_LEFT_TOOL_NAME } from '../tools/ContextLeftTool/constants.js'
import { ENTER_WORKTREE_TOOL_NAME } from '../tools/EnterWorktreeTool/constants.js'
import { EXIT_WORKTREE_TOOL_NAME } from '../tools/ExitWorktreeTool/constants.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../tools/GrepTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../tools/NotebookEditTool/constants.js'
import { POWERSHELL_TOOL_NAME } from '../tools/PowerShellTool/toolName.js'
import { SEND_MESSAGE_TOOL_NAME } from '../tools/SendMessageTool/constants.js'
import { RESUME_AGENT_TOOL_NAME } from '../tools/ResumeAgentTool/constants.js'
import { SLEEP_TOOL_NAME } from '../tools/SleepTool/prompt.js'
import { SKILL_TOOL_NAME } from '../tools/SkillTool/constants.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../tools/SyntheticOutputTool/constants.js'
import { TASK_CREATE_TOOL_NAME } from '../tools/TaskCreateTool/constants.js'
import { TASK_GET_TOOL_NAME } from '../tools/TaskGetTool/constants.js'
import { TASK_LIST_TOOL_NAME } from '../tools/TaskListTool/constants.js'
import { TASK_STOP_TOOL_NAME } from '../tools/TaskStopTool/prompt.js'
import { TASK_UPDATE_TOOL_NAME } from '../tools/TaskUpdateTool/constants.js'
import { TOOL_SEARCH_TOOL_NAME } from '../tools/ToolSearchTool/constants.js'
import { WEB_FETCH_TOOL_NAME } from '../tools/WebFetchTool/prompt.js'
import { PROVIDER_SEARCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from '../tools/WebSearchTool/prompt.js'
import { WORKFLOW_TOOL_NAME } from '../tools/WorkflowTool/constants.js'
import { CORRECT_TOOL_NAME, RECALL_TOOL_NAME, REFLECT_TOOL_NAME, RETAIN_TOOL_NAME } from '../tools/MemoryTools/prompt.js'
import { JOURNAL_TOOL_NAME } from '../tools/JournalTool/prompt.js'

type AgentReach = 'barred' | 'background'

const AGENT_REACH: Readonly<Record<string, AgentReach>> = {
  [AGENT_TOOL_NAME]: 'barred',
  [ASK_USER_QUESTION_TOOL_NAME]: 'barred',
  [TASK_STOP_TOOL_NAME]: 'barred',
  [WORKFLOW_TOOL_NAME]: 'barred',
  [COMPUTER_TOOL_NAME]: 'barred',
  [JOURNAL_TOOL_NAME]: 'barred',
  [FILE_READ_TOOL_NAME]: 'background',
  [GREP_TOOL_NAME]: 'background',
  [GLOB_TOOL_NAME]: 'background',
  [WEB_FETCH_TOOL_NAME]: 'background',
  [WEB_SEARCH_TOOL_NAME]: 'background',
  [PROVIDER_SEARCH_TOOL_NAME]: 'background',
  [FILE_EDIT_TOOL_NAME]: 'background',
  [FILE_WRITE_TOOL_NAME]: 'background',
  [NOTEBOOK_EDIT_TOOL_NAME]: 'background',
  [BASH_TOOL_NAME]: 'background',
  [POWERSHELL_TOOL_NAME]: 'background',
  [TASK_CREATE_TOOL_NAME]: 'background',
  [TASK_UPDATE_TOOL_NAME]: 'background',
  [TASK_GET_TOOL_NAME]: 'background',
  [TASK_LIST_TOOL_NAME]: 'background',
  [SKILL_TOOL_NAME]: 'background',
  [SYNTHETIC_OUTPUT_TOOL_NAME]: 'background',
  [TOOL_SEARCH_TOOL_NAME]: 'background',
  [ENTER_WORKTREE_TOOL_NAME]: 'background',
  [EXIT_WORKTREE_TOOL_NAME]: 'background',
  [SEND_MESSAGE_TOOL_NAME]: 'background',
  [RESUME_AGENT_TOOL_NAME]: 'background',
  [SLEEP_TOOL_NAME]: 'background',
  [CONTEXT_LEFT_TOOL_NAME]: 'background',
  [JEV_TOOL_NAME]: 'background',
  [RETAIN_TOOL_NAME]: 'background',
  [RECALL_TOOL_NAME]: 'background',
  [REFLECT_TOOL_NAME]: 'background',
  [CORRECT_TOOL_NAME]: 'background',
}

const toolsReaching = (reach: AgentReach): Set<string> =>
  new Set(Object.keys(AGENT_REACH).filter(name => AGENT_REACH[name] === reach))

export const ALL_AGENT_DISALLOWED_TOOLS: Set<string> = toolsReaching('barred')
export const CUSTOM_AGENT_DISALLOWED_TOOLS: Set<string> = ALL_AGENT_DISALLOWED_TOOLS
export const ASYNC_AGENT_ALLOWED_TOOLS: Set<string> = toolsReaching('background')

export const RULE_INHERITS: Readonly<Partial<Record<string, readonly string[]>>> = {
  [RESUME_AGENT_TOOL_NAME]: [SEND_MESSAGE_TOOL_NAME],
}
