import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'

/**
 * The Write tool's name constant and model-facing text.
 */

/** Contract data: the model-visible tool name. */
export const FILE_WRITE_TOOL_NAME = 'Write'

export const DESCRIPTION = 'Put content on disk at a path, replacing what was there.'

export function getWriteToolDescription(): string {
  return `Puts the given content on disk at the path you name.

Usage:
- An existing file at the path is overwritten in place.
- Overwriting? ${FILE_READ_TOOL_NAME} has to have read the file first — an unread overwrite fails.
- ALWAYS prefer editing existing files with the ${FILE_EDIT_TOOL_NAME} tool — it sends only the diff, while this tool sends the entire file. Reserve this tool for new files and complete rewrites.
- Documentation files (*.md, READMEs) appear only on an explicit request — never proactively.
- Keep emoji out of written files unless the user has specifically asked for them.`
}
