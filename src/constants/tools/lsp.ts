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
  LspRead: `Asks the language servers about code and returns their answer: where a symbol is defined, every reference to it, its type and documentation, its callers and callees, the symbols in a file or across the workspace, the current errors and warnings in files, and each server's state, restarts, last error and what it can answer. It only reads.`,
  LspRename: `Renames a symbol everywhere the language server sees it — the declaration, imports, re-exports and every reference in every file, never a comment or a string. Without apply it returns the edits (file, line:character range, old → new text, up to 40 per file with the rest counted) and a plan token and writes nothing; with apply: true and that plan it writes exactly those edits and returns the error and warning count the server reports for the first file written.`,
  LspMoveSymbol: `Moves a top-level declaration — function, class, interface, type, enum or variable — into another file, with every import of it rewritten by the language server; TypeScript and JavaScript only. Without apply it returns the edits (file, line:character range, old → new text, up to 40 per file with the rest counted) and a plan token and writes nothing; with apply: true and that plan it writes exactly those edits.`,
  LspMoveFile: `Moves or renames a file or a directory and updates every import of it that a language server knows about; a file type no server covers moves without import updates, and the preview says so. Without apply it returns the import edits and, when there are any, a plan token, and moves nothing; with apply: true and that plan it writes the edits and moves the path.`,
  LspCodeAction: `Lists what the language server offers at a position or range — quick fixes for the errors there, refactors such as extract and convert, and whole-file source actions — each with a stable id; with an action chosen it returns that action's edits and a plan token and writes nothing; with apply: true and that plan it writes exactly those edits. Only edits are applied, never a server command.`,
  LspFormat: `Formats a file, or only a range of its lines, with the language server that owns formatting for its type — ruff for Python when it is installed — or sorts and prunes its imports. Without apply it returns the edits (file, line:character range, old → new text, up to 40 per file with the rest counted) and a plan token and writes nothing; with apply: true and that plan it writes exactly those edits.`,
  LspRequest: `Sends one raw request to the language server for a file — any method, with params as JSON text — and returns its raw answer; nothing it returns is applied.`,
}
