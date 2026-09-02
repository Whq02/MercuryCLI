// ============================================================================
//  scripts/tool-economy/fixtureMcpEstate.ts — the two fixture MCP servers
//  (twelve tools each, realistic schemas) every tool-economy instrument
//  drives: "the standard builtin set plus two MCP servers" the acceptance
//  criteria name. Built the way the MCP client builds a discovered tool (the
//  MCPTool base, isMcp, mcpInfo, an explicit inputJSONSchema), so the schema
//  cache, the deferral policy and the wire codecs see a genuine MCP tool.
//  Not a prover — the suite runner globs measure-*.ts and prove-*.ts only.
// ============================================================================
import { z } from 'zod/v4'

type Param = { name: string; type: 'string' | 'number' | 'boolean' | 'array'; doc: string; required?: boolean }
const P = (name: string, type: Param['type'], doc: string, required = true): Param => ({ name, type, doc, required })

export interface FixtureMcpRow {
  tool: string
  doc: string
  params: Param[]
  readOnly?: boolean
}

export const FILESYS_ROWS: FixtureMcpRow[] = [
  { tool: 'read_file', doc: 'Read the complete contents of a file from the file system. Handles various text encodings and provides detailed error messages if the file cannot be read.', params: [P('path', 'string', 'Absolute path to the file to read')], readOnly: true },
  { tool: 'read_multiple_files', doc: 'Read the contents of multiple files simultaneously. Failed reads for individual files do not stop the entire operation.', params: [P('paths', 'array', 'Absolute paths of the files to read')], readOnly: true },
  { tool: 'write_file', doc: 'Create a new file or completely overwrite an existing file with new content. Use with caution as it will overwrite existing files without warning.', params: [P('path', 'string', 'Absolute path of the file to write'), P('content', 'string', 'The full new content of the file')] },
  { tool: 'edit_file', doc: 'Make line-based edits to a text file. Each edit replaces exact line sequences with new content. Returns a git-style diff showing the changes made.', params: [P('path', 'string', 'Absolute path of the file to edit'), P('edits', 'array', 'A list of {oldText, newText} replacement pairs applied in order'), P('dryRun', 'boolean', 'Preview changes using git-style diff format without writing', false)] },
  { tool: 'create_directory', doc: 'Create a new directory or ensure a directory exists. Can create multiple nested directories in one operation.', params: [P('path', 'string', 'Absolute path of the directory to create')] },
  { tool: 'list_directory', doc: 'Get a detailed listing of all files and directories in a specified path. Results distinguish files from directories with [FILE] and [DIR] prefixes.', params: [P('path', 'string', 'Absolute path of the directory to list')], readOnly: true },
  { tool: 'directory_tree', doc: 'Get a recursive tree view of files and directories as a JSON structure. Each entry includes name, type and children for directories.', params: [P('path', 'string', 'Absolute path of the root directory'), P('maxDepth', 'number', 'Maximum recursion depth (default 5)', false)], readOnly: true },
  { tool: 'move_file', doc: 'Move or rename files and directories. Can move files between directories and rename them in a single operation. Fails if the destination exists.', params: [P('source', 'string', 'Absolute path of the file or directory to move'), P('destination', 'string', 'Absolute destination path')] },
  { tool: 'search_files', doc: 'Recursively search for files and directories matching a pattern. Searches through all subdirectories from the starting path, case-insensitive.', params: [P('path', 'string', 'Absolute path of the directory to search from'), P('pattern', 'string', 'The glob or substring pattern to match'), P('excludePatterns', 'array', 'Glob patterns to exclude from the search', false)], readOnly: true },
  { tool: 'get_file_info', doc: 'Retrieve detailed metadata about a file or directory: size, creation time, last modified time, permissions and type.', params: [P('path', 'string', 'Absolute path of the file or directory')], readOnly: true },
  { tool: 'list_allowed_directories', doc: 'Returns the list of directories that this server is allowed to access. Use this to understand which directories are available before trying to access files.', params: [], readOnly: true },
  { tool: 'delete_file', doc: 'Delete a file permanently. This operation cannot be undone; confirm the path before calling.', params: [P('path', 'string', 'Absolute path of the file to delete')] },
]

export const GITHUB_ROWS: FixtureMcpRow[] = [
  { tool: 'create_issue', doc: 'Create a new issue in a GitHub repository with a title, body, labels and assignees.', params: [P('owner', 'string', 'Repository owner (user or organization)'), P('repo', 'string', 'Repository name'), P('title', 'string', 'Issue title'), P('body', 'string', 'Issue body in Markdown', false), P('labels', 'array', 'Label names to apply', false), P('assignees', 'array', 'Usernames to assign', false)] },
  { tool: 'list_issues', doc: 'List issues in a GitHub repository with filtering by state, labels, sort order and pagination.', params: [P('owner', 'string', 'Repository owner'), P('repo', 'string', 'Repository name'), P('state', 'string', 'open, closed or all', false), P('labels', 'array', 'Filter by label names', false), P('page', 'number', 'Page number for pagination', false), P('per_page', 'number', 'Results per page (max 100)', false)], readOnly: true },
  { tool: 'get_issue', doc: 'Get the details of a specific issue in a GitHub repository, including its body, labels, state and timeline counts.', params: [P('owner', 'string', 'Repository owner'), P('repo', 'string', 'Repository name'), P('issue_number', 'number', 'The issue number')], readOnly: true },
  { tool: 'add_issue_comment', doc: 'Add a comment to an existing issue or pull request.', params: [P('owner', 'string', 'Repository owner'), P('repo', 'string', 'Repository name'), P('issue_number', 'number', 'The issue or pull request number'), P('body', 'string', 'Comment text in Markdown')] },
  { tool: 'create_pull_request', doc: 'Create a new pull request in a GitHub repository from a head branch into a base branch.', params: [P('owner', 'string', 'Repository owner'), P('repo', 'string', 'Repository name'), P('title', 'string', 'Pull request title'), P('head', 'string', 'The branch containing the changes'), P('base', 'string', 'The branch to merge into'), P('body', 'string', 'Pull request description', false), P('draft', 'boolean', 'Create as a draft pull request', false)] },
  { tool: 'list_pull_requests', doc: 'List pull requests in a GitHub repository with filtering by state, head, base and sort order.', params: [P('owner', 'string', 'Repository owner'), P('repo', 'string', 'Repository name'), P('state', 'string', 'open, closed or all', false), P('base', 'string', 'Filter by base branch name', false), P('sort', 'string', 'created, updated, popularity or long-running', false)], readOnly: true },
  { tool: 'get_pull_request', doc: 'Get the details of a specific pull request: title, body, head and base refs, mergeability and review state.', params: [P('owner', 'string', 'Repository owner'), P('repo', 'string', 'Repository name'), P('pull_number', 'number', 'The pull request number')], readOnly: true },
  { tool: 'search_code', doc: 'Search for code across GitHub repositories using the GitHub code search syntax.', params: [P('q', 'string', 'The search query using GitHub code search syntax'), P('sort', 'string', 'Sort field (indexed only)', false), P('order', 'string', 'asc or desc', false), P('per_page', 'number', 'Results per page (max 100)', false)], readOnly: true },
  { tool: 'create_branch', doc: 'Create a new branch in a GitHub repository from an existing branch or the default branch.', params: [P('owner', 'string', 'Repository owner'), P('repo', 'string', 'Repository name'), P('branch', 'string', 'Name for the new branch'), P('from_branch', 'string', 'Source branch (defaults to the repository default branch)', false)] },
  { tool: 'push_files', doc: 'Push multiple files to a GitHub repository in a single commit on the named branch.', params: [P('owner', 'string', 'Repository owner'), P('repo', 'string', 'Repository name'), P('branch', 'string', 'Branch to push to'), P('files', 'array', 'A list of {path, content} entries to write'), P('message', 'string', 'Commit message')] },
  { tool: 'get_file_contents', doc: 'Get the contents of a file or directory from a GitHub repository at an optional ref.', params: [P('owner', 'string', 'Repository owner'), P('repo', 'string', 'Repository name'), P('path', 'string', 'Path to the file or directory'), P('ref', 'string', 'Branch, tag or commit SHA', false)], readOnly: true },
  { tool: 'fork_repository', doc: 'Fork a GitHub repository to your account or the specified organization.', params: [P('owner', 'string', 'Repository owner'), P('repo', 'string', 'Repository name'), P('organization', 'string', 'Organization to fork into', false)] },
]

export function schemaOf(params: Param[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  for (const p of params) {
    properties[p.name] =
      p.type === 'array'
        ? { type: 'array', items: { type: 'string' }, description: p.doc }
        : { type: p.type, description: p.doc }
  }
  const required = params.filter(p => p.required !== false).map(p => p.name)
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false }
}

/** Build the 24 fixture MCP tools over the MCPTool base the client clones. */
export function buildFixtureMcpTools<T>(mcpToolBase: unknown): T[] {
  const one = (serverName: string, row: FixtureMcpRow): T => {
    const name = `mcp__${serverName}__${row.tool}`
    const description = `${serverName} - ${row.tool} (MCP)\n\n${row.doc}`
    return {
      ...(mcpToolBase as Record<string, unknown>),
      name,
      mcpInfo: { serverName, toolName: row.tool },
      isMcp: true,
      description: async () => description,
      prompt: async () => description,
      isConcurrencySafe: () => row.readOnly === true,
      isReadOnly: () => row.readOnly === true,
      inputJSONSchema: schemaOf(row.params),
      inputSchema: z.looseObject({}),
      isEnabled: () => true,
      call: async () => ({ data: 'fixture' }),
    } as unknown as T
  }
  return [...FILESYS_ROWS.map(row => one('filesys', row)), ...GITHUB_ROWS.map(row => one('github', row))]
}

/** name + input_schema bytes across the estate (the receipt's fixture line). */
export function fixtureMcpSchemaBytes(tools: ReadonlyArray<{ name: string; inputJSONSchema?: unknown }>): number {
  return Buffer.byteLength(JSON.stringify(tools.map(t => ({ name: t.name, input_schema: t.inputJSONSchema }))), 'utf8')
}
