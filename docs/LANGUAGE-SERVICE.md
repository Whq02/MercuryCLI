# The language service — questions and refactors

Mercury speaks to the workspace's language servers: the built-in TypeScript
and JavaScript sidecar (`mercury-ts`, using the project's own `typescript`
package), the Python, C/C++, GDScript and C# lanes, and any server an extension
or `MERCURY_LSP_SERVERS` adds.

`LspRead` asks those servers about definitions, references, types,
documentation, callers, callees, symbols, diagnostics and server status. It
only reads. On cloud models its definition loads in full when a server is
configured, even if that server is unhealthy; `serverStatus` can explain the
failure. Local routes discover it through ToolSearch.

Six other tools are loaded through ToolSearch when needed:

| Tool | What it does |
| --- | --- |
| `LspRename` | Rename a symbol and every reference to it |
| `LspMoveSymbol` | Move a top-level declaration and rewrite its imports |
| `LspMoveFile` | Move a file or directory and update its imports |
| `LspCodeAction` | List, preview and apply fixes, refactors and source actions |
| `LspFormat` | Format a file or whole-line range, or organize imports |
| `LspRequest` | Send a raw protocol request; its answer is never applied |

For example, ToolSearch with `{"query":"select:LspRename"}` loads the rename
tool's description and schema. The writing tools have no `operation` field;
their required arguments are part of their own schemas.

Discovery reads local configurations, installed binaries and bundled servers;
server processes start lazily. `MERCURY_LSP=0` and `--lean` leave all seven tools
out. A configured server that fails remains visible through `LspRead`.

## Questions and diagnostics

Positions use the 1-based `line` and `character` that Read shows.

- `goToDefinition`, `findReferences`, `hover`, `goToImplementation`,
  `typeDefinition`, `incomingCalls` and `outgoingCalls` take `filePath`, `line`
  and `character`.
- `documentSymbol` takes `filePath`.
- `workspaceSymbol` takes `query`, optionally `limit` (default 50, at most 200)
  and `filePath` to choose a language server.
- `diagnostics` takes `filePath` for one file, or `paths` for up to 50 files or
  directories. Directories expand to files covered by configured servers.
- `serverStatus` lists each server's state, restarts, last error and capabilities;
  optional `filePath` marks the server that covers it.

An advertised argument an operation does not read is ignored. Every named
read path takes the ordinary read-permission check.

A diagnostics result says whether a server checked the files. A failed start,
an unanswered request or an uncovered file is not a clean report: the answer
names the cause and what helps. No symbols found is an answer, not a failure.

After three consecutive server faults for the same call in the same situation,
Mercury pauses that call. A changed named file or server state sends it again
at once; otherwise the answer gives the retry time. The pause starts at 60
seconds after the third failure and grows to at most five minutes. Argument,
path and apply refusals do not count, nor does an interruption. A successful,
unchanged or indeterminate answer clears the call's fault count.

A failed server start has its own 15-second to five-minute backoff. Calls during
that backoff do not count as new starts or extend it. An explicit restart or
`/extensions reload` allows a fresh start.

## Preview, then apply

`LspRename`, `LspMoveSymbol`, `LspMoveFile`, `LspCodeAction` and `LspFormat`
preview until `apply: true` is passed.

- The preview writes nothing. It lists each edit's file, 1-based range and
  before/after text, with up to 40 edits per file and any omitted edits counted.
  The output also carries the edit rows and a `plan: lsp-…` token for the exact
  edit set.
- With `apply: true` and `plan`, the tool writes exactly the previewed edits.
  A touched file changed since the preview refuses the whole apply.
- Without `plan`, apply requires current read knowledge covering every touched
  line of every edited file. A missing or stale read refuses the whole apply
  and names the files and lines to read.
- The same permissions, journaled commit walk, drift checks, file-history
  snapshots and change receipts as Edit protect the writes. After writing,
  read state is refreshed, servers are synchronized and diagnostics reported.

A refused apply writes nothing. A file move whose server offers no import
updates previews that fact; it may then move the path without an edit token.

## LspRename — a symbol across the workspace

Pass `filePath`, `line`, `character` and `newName`, pointing at any occurrence
of the name. The server includes declarations, imports, re-exports, JSX tags
and attributes, and JavaScript references in the same project. A comment or
string containing the name is not a reference.

The TypeScript sidecar checks the proposed name and refuses a reserved word,
a collision, a captured binding or a rename the language service itself
rejects. The answer carries the reason and position.

Example: `LspRename {"filePath":"/repo/src/core/greeting.ts","line":8,
"character":17,"newName":"craftGreeting"}` previews. Repeat those arguments
with `"apply":true` and the returned `plan` to write them.

## LspMoveSymbol — a declaration to another file

Pass `filePath`, `line` and `character` at the declaration's name, plus
`targetPath`. A top-level function, class, interface, type, enum or variable
moves to the target, creating it when absent or appending when present.
Imports are rewritten with it.

A position inside a body, a non-declaration, the source itself as target, a
directory target or a different-language target is refused. This operation
is supported by the TypeScript and JavaScript sidecar.

## LspMoveFile — a file or directory with its imports

Pass `filePath` and `newPath`. The destination must not exist. The tool asks
claiming servers for import updates, previews them and applies the edits and
move together. Directory moves find claimants from the files they contain.
A move touching imports in more than 100 files is refused; split it into
smaller steps.

## LspCodeAction — fixes, refactors and source actions

Pass `filePath`, `line` and `character`, optionally `endLine` and
`endCharacter`. The list names each action with a stable `actionId`.

- `kind` filters quick fixes, refactors or source actions such as
  `source.organizeImports`, `source.addMissingImports`,
  `source.removeUnusedImports` and `source.removeUnused`.
- `actionId` without apply previews the action's edits and plan.
- `apply: true` with an action selector applies it; a kind that leaves exactly
  one action can select that action itself. `actionIndex` is positional;
  `actionId` is the safer selector.
- Command-only actions are refused. A refactor requiring declaration movement
  belongs to `LspMoveSymbol`.

## LspFormat and LspRequest

`LspFormat` takes `filePath`. Give both `line` and `endLine` to format an
inclusive range of whole lines, or neither for the whole file.
`organizeImports: true` works on the whole file and cannot be combined with a
range. Python formatting uses ruff when installed. Already formatted files
come back unchanged.

`LspRequest` takes `filePath`, `method` and optional JSON-text `params`. Params
are sent as given; document and position fields are not filled in. The tool
always takes write permission because an arbitrary method may have effects.
Known edit-class methods are refused in favor of the typed tools, and nothing
returned by a raw request is applied.

## Saved tool-family settings

`LSP` is a setting-family selector for all seven language-service tools. A
tool-wide allow, ask or deny rule, an allowed/blocked CLI tool list, an agent's
tool list, or a capability kill using that selector covers the whole family.
Name individual tools to narrow it. Content-qualified rules do not acquire
family semantics.

A hook's `match`, including a pipe-separated list, uses the same family
selector. A regular-expression match keeps its regex meaning; a startup note
identifies one that matched the family name but matches none of its tools.
Hook payloads carry the actual tool name and input; only `LspRead` takes an
input `operation`. Result objects retain the engine operation,
edits, plan and change-view fields.

## JavaScript projects

The sidecar finds the nearest `tsconfig.json` or `jsconfig.json`. A
`jsconfig.json` project is analyzed whole, so a rename reaches references in
other JavaScript files. A file under neither belongs to an inferred project
holding the files the session has opened.
