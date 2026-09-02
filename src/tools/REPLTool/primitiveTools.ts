import type { Tool } from '../../Tool.js'
import { AgentTool } from '../AgentTool/AgentTool.js'
import { BashTool } from '../BashTool/BashTool.js'
import { FileEditTool } from '../FileEditTool/FileEditTool.js'
import { FileReadTool } from '../FileReadTool/FileReadTool.js'
import { FileWriteTool } from '../FileWriteTool/FileWriteTool.js'
import { GlobTool } from '../GlobTool/GlobTool.js'
import { GrepTool } from '../GrepTool/GrepTool.js'
import { NotebookEditTool } from '../NotebookEditTool/NotebookEditTool.js'

/**
 * The primitive tool OBJECTS REPL mode hides but still renders, in the same
 * order as REPL_ONLY_TOOLS. Built on first call and cached: the import chain
 * from the transcript collapser through this module and back into the tool
 * registry is circular, so evaluating the array at module scope hits a
 * temporal-dead-zone error. The tools are referenced directly rather than
 * filtered out of the shared catalogue, because the catalogue omits
 * glob/grep on builds with embedded search binaries. Consumers are
 * display-side (the collapser and renderers classify virtual REPL-emitted
 * messages for tools absent from the filtered execution list).
 */
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
