
export const LSP_TOOL_NAME = 'LSP'

export const DESCRIPTION = `Interact with language servers for code intelligence: find definitions, references, hover information, and symbols.

Operations:
- goToDefinition: Jump to the place a symbol is declared
- findReferences: List every location that references a symbol
- hover: Show a symbol's type and its attached documentation
- documentSymbol: List all symbols in a file (functions, classes, variables)
- workspaceSymbol: hunt a symbol by name across the whole workspace
- goToImplementation: Jump from an interface or abstract member to the concrete code that implements it
- prepareCallHierarchy: Identify the callable item at a position
- incomingCalls: Find all callers of a function
- outgoingCalls: Find all functions a function calls

Operations require a file path and a 1-based line and character position, exactly as shown in editors and in Read tool output.

A language server must be configured for the file's type; if none is available an error is returned.`

const BRIDGE_SECTION = `

Mercury's editor-hands operations — the IDE acts, not just reports:
- diagnostics: Pull current errors and warnings for one file. Run it on files you just edited instead of guessing whether they compile.
- workspaceDiagnostics: Pull diagnostics for an explicit set of files and/or directories (directories expand to the files a server claims, capped at 50, deterministic order).
- rename: Rename a symbol everywhere the compiler sees it — the declaration, imports, re-exports, JSX tags and attributes, JavaScript files in the same project — never a comment or a string. Reach for it instead of a text edit whenever a name is used in more than one place. A rename that would collide with or capture another symbol, or that the service refuses, is refused with the reason.
- moveSymbol: Move a top-level declaration (function, class, interface, type, enum or variable) to another file — created when absent, appended to when present — with every import rewritten by the compiler. Point at the declaration's name. TypeScript and JavaScript.
- pathRename: Move/rename a FILE or directory and update every import of it. Previews the move and every import edit; applies them as one transaction. Prefer it over a shell move for source files.
- codeActions: List what the service offers at a position or range with stable ids — quickfixes for a diagnostic, refactors (extract, convert), and with kind the whole-file source actions (source.organizeImports, source.addMissingImports, source.removeUnusedImports, source.removeUnused). kind filters the list; actionId without apply previews that action's edits; apply with actionId (or with a kind that leaves exactly one action) writes. An index is a legacy selector that refuses rather than applying the wrong action when the list changed. Command-only actions are refused: only literal edits are supported.
- fixDiagnostic: A composite — pull the diagnostics at a position, offer the matching fixes, apply the selected one (a sole candidate is auto-selected), and report the before/after error counts.
- typeDefinition: Jump to the TYPE of the value under the cursor rather than the value itself.
- serverStatus: Show each server's state, generation, restart count, capability summary, and last error.
- switchSourceHeader: For C/C++ files — jump between a source file and its header (a clangd extension; other servers refuse honestly).
- formatDocument / formatRange / organizeImports: Formatting routes to the server that owns the formatting capability for the file; a file with no formatting owner refuses precisely. Python files deliberately have two providers with a semantics/lint split.
- capabilities: Dump the claiming server's full capability advertisement (what it can actually answer) as JSON.
- rawRequest: The escape hatch — send any LSP request method with JSON-text params and get the raw response. Write-permissioned; edit-class methods (rename, executeCommand, codeAction, formatting) are refused by name toward their typed operations, so protocol experiments can never bypass the apply transaction.

Evidence discipline: positions are 1-based exactly as the Read tool shows them. Every write operation is two calls: the dry run (apply omitted) returns every edit as data — file, range, before, after — and a plan token; apply: true writes. With plan it writes exactly the previewed set and refuses if any touched file changed since; without plan it writes only files this session has read as they stand now. Applies re-verify against disk, abort on drift, refresh the read state of every written file, and take the same write permissions and file-history snapshots as the Edit tool. Ground non-trivial edits in IDE evidence — definitions/references before changing a shared symbol, diagnostics after edits. The compiler knows every reference; a text search does not.`

export function getLspToolDescription(bridgeEnabled: boolean): string {
  const mercuryOpsEnabled = bridgeEnabled
  return mercuryOpsEnabled ? `${DESCRIPTION}${BRIDGE_SECTION}` : DESCRIPTION
}
