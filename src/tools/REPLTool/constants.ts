import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../GrepTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../NotebookEditTool/constants.js'

/** The REPL tool's name (contract data). */
export const REPL_TOOL_NAME = 'REPL'

/**
 * REPL mode gate: always off.
 * Mercury never runs as a hosted-cloud REPL — no env pair arms the
 * mode — and the mode must never default on:
 * SDK entrypoints script direct tool calls that REPL mode would hide.
 */
export function isReplModeEnabled(): boolean {
  return false
}

/**
 * The tool names hidden from direct model use while REPL mode is on — each
 * referenced through its owning module's constant, never re-spelled. The
 * catalogue removes them only when REPL mode is on AND a REPL tool is
 * actually present in the pool.
 */
export const REPL_ONLY_TOOLS: ReadonlySet<string> = new Set([
  FILE_READ_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  BASH_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  AGENT_TOOL_NAME,
])
