export const LSP_TOOL_NAME = 'LspRead'

export const LSP_TOOL_NAMES = ['LspRead', 'LspRename', 'LspMoveSymbol', 'LspMoveFile', 'LspCodeAction', 'LspFormat', 'LspRequest'] as const

export type LspToolName = typeof LSP_TOOL_NAMES[number]

export const LSP_SEARCH_HINTS: Record<LspToolName, string> = {
  LspRead: 'language server questions: definition, references, hover, symbols, callers, type, diagnostics',
  LspRename: 'rename a symbol in every file through the language server: preview the edits, then apply them',
  LspMoveSymbol: 'move a top-level declaration into another file and rewrite its imports (TypeScript, JavaScript)',
  LspMoveFile: 'move or rename a file or directory and update its imports through the language server',
  LspCodeAction: "list and apply the language server's quick fixes, refactors and source actions at a position",
  LspFormat: 'format a file or a range of its lines, or organize its imports, through the language server',
  LspRequest: 'send one raw language-server protocol request and read the raw answer',
}

export const LSP_DESCRIPTIONS: Record<LspToolName, string> = {
  LspRead: `Use this over Grep and Read for definitions and references: the language server resolves symbols rather than matching text.

Ask the language servers about code: where a symbol is defined, every reference to it, its type and documentation, its callers and callees, the symbols in a file or across the workspace, and the current errors and warnings in files. It only reads.

Operations, and the arguments each one reads:
- goToDefinition, findReferences, hover, goToImplementation, typeDefinition, incomingCalls, outgoingCalls: filePath, line, character — the symbol's position, 1-based, as Read shows it
- documentSymbol: filePath
- workspaceSymbol: query (a name or part of one); limit (default 50, at most 200); filePath, optional, picks the server for that file's language
- diagnostics: paths, up to 50 files or directories (a directory stands for the files under it that a server covers), or filePath for one file. Run it on files you just edited.
- serverStatus: each server's state, restarts, last error and what it can answer; filePath marks the server for that file
An argument the operation does not read is ignored. When no server covers a file type, the answer says what would provide one.

Changes go through tools loaded with ToolSearch: LspRename (rename a symbol), LspMoveSymbol (move a declaration to another file), LspMoveFile (move or rename a file or directory), LspCodeAction (quick fixes, refactors), LspFormat (format, organize imports), LspRequest (one raw protocol request).

A call a server fails three times in a row is not sent again until a file it names changes, the server restarts, or the time in the answer has passed.`,
  LspRename: `Rename a symbol everywhere the language server sees it: the declaration, imports, re-exports and every reference in every file — never a comment or a string. Point filePath, line and character at any occurrence of the name (1-based, as Read shows it).

Two calls. Without apply nothing is written: the answer lists the edits (file, line:character range, old → new text; up to 40 per file, the rest counted) and a plan token. Then send the same arguments with apply: true and plan: "<token>" to write exactly those edits; if any of those files changed since the preview, nothing is written and the answer says so. apply: true without plan writes only if this session has read the touched lines of every file as they stand now.

A name that would collide with or capture another symbol, or that the server refuses, is refused with the reason. After writing, the answer gives the error and warning count the server reports for the first file written.`,
  LspMoveSymbol: `Move a top-level declaration — function, class, interface, type, enum or variable — into another file, with every import of it rewritten by the language server. Point filePath, line and character at the declaration's name (1-based, as Read shows it). TypeScript and JavaScript only; in other languages move the code with Edit and fix the imports with LspRename or LspMoveFile.

targetPath is the file it moves into: created when absent, appended to when present.

Two calls. Without apply nothing is written: the answer lists the edits (file, line:character range, old → new text; up to 40 per file, the rest counted) and a plan token. Then send the same arguments with apply: true and plan: "<token>" to write exactly those edits; if any of those files changed since the preview, nothing is written and the answer says so. apply: true without plan writes only if this session has read the touched lines of every file as they stand now.`,
  LspMoveFile: `Move or rename a file or a directory, and update every import of it that a language server knows about. newPath must not exist yet.

Two calls. Without apply nothing moves: the answer lists the import edits and, when there are any, a plan token. Then send the same arguments with apply: true (and plan: "<token>" when one was printed) to write the edits and move the path; if a touched file changed since the preview, nothing is written or moved. When no language server for that file type updates imports, the path moves without import updates, and the preview says so. A move whose imports touch more than 100 files is refused; move it in smaller steps.`,
  LspCodeAction: `List and apply what the language server offers at a position or range: quick fixes for the errors there, refactors (extract, convert), and, with kind, whole-file source actions — source.organizeImports, source.addMissingImports, source.removeUnusedImports, source.removeUnused.

With neither actionId nor actionIndex: the list, each action with a stable id. With one of them: that action's edits and a plan token, nothing written. Add apply: true and plan: "<token>" to write exactly those edits; if a touched file changed since, nothing is. apply: true with a kind that leaves exactly one action applies that one. actionIndex picks by position in the current list; actionId names the action itself and is the safer choice. An action that only runs a server command is refused: only edits are applied.`,
  LspFormat: `Format a file — or only its lines line through endLine — with the language server that owns formatting for its type; or, with organizeImports: true, sort and prune its imports. Python files are handled by ruff when ruff is installed.

Two calls. Without apply nothing is written: the answer lists the edits (file, line:character range, old → new text; up to 40 per file, the rest counted) and a plan token. Then send the same arguments with apply: true and plan: "<token>" to write exactly those edits; if any of those files changed since the preview, nothing is written and the answer says so. apply: true without plan writes only if this session has read the touched lines of every file as they stand now.

A file that is already formatted comes back unchanged, with nothing to write.`,
  LspRequest: `Send one raw request to the language server for a file — any method, params as JSON text — and get its raw answer. Nothing it returns is applied. Methods that edit are refused by name (textDocument/rename, textDocument/codeAction, codeAction/resolve, textDocument/formatting, textDocument/rangeFormatting, workspace/executeCommand, workspace/willRenameFiles, workspace/applyEdit): use LspRename, LspCodeAction, LspFormat or LspMoveFile. params are sent exactly as given; textDocument and position are not filled in.`,
}
