
import type { AgentId } from './ids.js'
import type { AssistantMessage, NormalizedUserMessage } from './message.js'


export type BashProgress = {
  type: 'bash_progress'
  output: string
  fullOutput: string
  elapsedTimeSeconds: number
  totalLines: number
  totalBytes?: number
  taskId?: string
  timeoutMs?: number
  budgetMs?: number
}

export type TestProgress = {
  type: 'test_progress'
  line: string
  elapsedTimeSeconds: number
}

export type PowerShellProgress = {
  type: 'powershell_progress'
  output: string
  fullOutput: string
  elapsedTimeSeconds: number
  totalLines: number
  totalBytes: number
  taskId?: string
  timeoutMs?: number
  budgetMs?: number
}

export type ShellProgress = BashProgress | PowerShellProgress


export type AgentToolProgress = {
  type: 'agent_progress'
  message: AssistantMessage | NormalizedUserMessage
  prompt: string
  agentId: AgentId
}

export type SkillToolProgress = {
  type: 'skill_progress'
  message: AssistantMessage | NormalizedUserMessage
  prompt: string
  agentId: AgentId
}


export type MCPProgress = {
  type: 'mcp_progress'
  status: 'started' | 'completed' | 'failed' | 'progress'
  serverName: string
  toolName: string
  elapsedTimeMs?: number
  progress?: number
  total?: number
  progressMessage?: string
}


export type WebSearchProgress =
  | {
      type: 'query_update'
      query: string
    }
  | {
      type: 'search_results_received'
      resultCount: number
      query: string
    }


export type TaskOutputProgress = {
  type: 'waiting_for_task'
  taskDescription: string
  taskType: string
}


export type REPLToolProgress = {
  type: 'repl_tool_call'
  phase: 'start' | 'end'
  toolName: string
  toolInput: unknown
}


export type SdkWorkflowProgress =
  | { type: 'workflow_log'; message: string }
  | {
      type: 'workflow_phase'
      index: number
      title: string
      kind?: 'phase' | 'child'
    }
  | {
      type: 'workflow_agent'
      index: number
      label: string
      state: 'start' | 'progress' | 'done' | 'error' | 'stopped' | 'skipped'
      phaseIndex?: number
      phaseTitle?: string
      tokens?: number
      toolCalls?: number
      durationMs?: number
      error?: string
      cached?: boolean
      [k: string]: unknown
    }


export type EvalToolProgress =
  | {
      type: 'eval_progress'
      kind: 'output'
      stream: 'stdout' | 'stderr'
      tail: string
      language: string
      title?: string
    }
  | {
      type: 'eval_progress'
      kind: 'nested'
      message: AssistantMessage | NormalizedUserMessage
    }

export type ToolProgressData =
  | BashProgress
  | PowerShellProgress
  | TestProgress
  | AgentToolProgress
  | SkillToolProgress
  | MCPProgress
  | WebSearchProgress
  | TaskOutputProgress
  | REPLToolProgress
  | EvalToolProgress
