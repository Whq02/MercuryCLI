import type { Tool } from '../../Tool.js'
import { AgentTool } from '../AgentTool/AgentTool.js'
import { BashTool } from '../BashTool/BashTool.js'
import { FileEditTool } from '../FileEditTool/FileEditTool.js'
import { FileReadTool } from '../FileReadTool/FileReadTool.js'
import { FileWriteTool } from '../FileWriteTool/FileWriteTool.js'
import { GlobTool } from '../GlobTool/GlobTool.js'
import { GrepTool } from '../GrepTool/GrepTool.js'
import { NotebookEditTool } from '../NotebookEditTool/NotebookEditTool.js'

let cached: readonly Tool[] | undefined

export function getReplPrimitiveTools(): readonly Tool[] {
  if (cached === undefined) {
    cached = [
      FileReadTool,
      FileWriteTool,
      FileEditTool,
      GlobTool,
      GrepTool,
      BashTool,
      NotebookEditTool,
      AgentTool,
    ] as readonly Tool[]
  }
  return cached
}
