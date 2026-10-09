import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'


export const FILE_WRITE_TOOL_NAME = 'Write'

export const DESCRIPTION = 'Put content on disk at a path, replacing what was there.'

export function getWriteToolDescription(): string {
  return `Puts the given content on disk at the path you name.

Usage:
- An existing file at the path is overwritten in place.
- Overwriting? ${FILE_READ_TOOL_NAME} has to have read the file first — an unread overwrite fails.
- ${FILE_EDIT_TOOL_NAME} sends only the diff; this tool sends the entire file, so it is for new files and complete rewrites.
- Documentation files (*.md, READMEs) appear only on an explicit request — never proactively.`
}
