export const FILE_WRITE_TOOL_NAME = 'Write'

export const DESCRIPTION = 'Put content on disk at a path, replacing what was there.'

export function getWriteToolDescription(): string {
  return 'Writes the whole content to a file, creating it or replacing what was there. Replacing an existing file needs current read coverage of it. A new syntax error in a supported source file is named in the result.'
}
