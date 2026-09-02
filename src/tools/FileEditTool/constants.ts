// A leaf module: the name is importable without the tool body (cycle guard).
export const FILE_EDIT_TOOL_NAME = 'Edit'

// Session-scope permission rule covering the project's .claude/ directory.
export const CLAUDE_FOLDER_PERMISSION_PATTERN = '/.claude/**'

// Session-scope permission rule covering the global ~/.claude/ directory.
export const GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN = '~/.claude/**'

export const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  'The file changed on disk after your last read. Read it again before editing it.'
