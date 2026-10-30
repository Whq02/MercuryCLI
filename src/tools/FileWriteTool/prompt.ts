import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'


export const FILE_WRITE_TOOL_NAME = 'Write'

export const DESCRIPTION = 'Put content on disk at a path, replacing what was there.'

export function getWriteToolDescription(): string {
  return `Puts the given content on disk at the path you name: the entire file, for new files and complete rewrites (${FILE_EDIT_TOOL_NAME} sends only the diff). An existing file is overwritten in place, and ${FILE_READ_TOOL_NAME} has to have read the file first — an unread overwrite fails. A newly introduced syntax error in a supported source file or JSON/YAML/TOML is reported after writing when no LSP covers it; an unavailable grammar never blocks the write. Documentation files (*.md, READMEs) appear only on an explicit request — never proactively.`
}
