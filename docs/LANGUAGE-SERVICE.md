# The language service — the LSP tool and its refactors

Mercury's `LSP` tool speaks to the language servers of the workspace: the
built-in TypeScript and JavaScript sidecar (`mercury-ts`, driving the
project's own `typescript` package), the built-in Python, C/C++, GDScript
and C# lanes, and any server an extension or `MERCURY_LSP_SERVERS` adds.
The read operations answer symbol questions from the compiler's knowledge —
definitions, references, hover, symbols, call hierarchy, diagnostics. The
write operations described here refactor with that knowledge instead of
text search: a rename touches every reference the compiler sees and nothing
else; a move rewrites every import; a code action lands the exact edit the
service computed. Every write goes through Mercury's one edit road — the
same permissions, the same journaled commit walk with drift detection, the
same file-history snapshot for `/rewind`, the same change receipt, the same
read-before-edit law as the Edit tool.

## Two calls, always: the dry run, then the apply

Every write operation is a dry run until `apply: true` is passed.

- **The dry run** (apply omitted) returns the edits as data — for each edit
  the file, the 1-based range (`start` and `end` line and character), the
  text before and the text after — both as rows in the result text
  (`file — N edits`, then `:line:col-line:col  before → after`) and as the
  `edits` field of the tool output. It also prints a **plan token**
  (`plan: lsp-…`), a digest of the exact edit set over the exact bytes it
  was computed against. Nothing is written.
- **The apply** (`apply: true`) recomputes the edits against the current
  files and writes them through the edit road:
  - with `plan`, it writes exactly the previewed set and refuses if any
    touched file changed since that dry run (the token no longer matches);
  - without `plan`, it writes only files this session has read as they
    stand now — a full Read whose content matches, a windowed Read covering
    the touched lines, or lines shown by a content search. A touched file
    the session has not read refuses the whole apply, names the files and
    their lines, and points at the dry-run road.
- After an apply the read state of every written file is refreshed, the
  editor is notified, the servers are re-synced, and the result names the
  post-apply diagnostics.

A refused apply writes nothing: the commit walk revalidates every file's
bytes under a lock before the first rename and aborts on drift.

## rename — a symbol across the workspace

`rename` at a position (`filePath`, `line`, `character`, `newName`) asks the
service for every rename location: the declaration, imports and re-exports
(a barrel's `export { x } from`), JSX tags and attributes, JavaScript files in
the same project. A comment or a string that happens to contain the name is
never a reference.

Before the edits are offered, the TypeScript sidecar checks the rename with
the compiler:

- the new name must be an identifier and not a reserved word;
- the renamed text is applied to overlays and the touched files are
  re-checked: any new error refuses the rename with the compiler's message
  and its position (`would collide — src/app.ts:1:25: Import declaration
  conflicts with local declaration of 'makeBanner'`);
- a renamed occurrence that would bind to another symbol of the new name,
  or an existing use of the new name that would rebind to the renamed
  symbol (`would change what 'loudness' at src/core/greeting.ts:14:71
  refers to`), refuses it too.

A rename the service itself refuses (a library symbol, an unresolved
identifier) is refused with the service's reason.

Example: `{ "operation": "rename", "filePath": "/repo/src/core/greeting.ts",
"line": 8, "character": 17, "newName": "craftGreeting" }` returns eleven
rows across six files and `plan: lsp-ccf119fe9962`; the same call with
`"apply": true, "plan": "lsp-ccf119fe9962"` writes them.

## moveSymbol — a declaration to another file

`moveSymbol` (`filePath`, `line`, `character` on the declaration's name,
`targetPath`) moves a top-level function, class, interface, type, enum or
variable declaration to another file — created when it does not exist,
appended to when it does — with every import rewritten by the compiler: the
source file imports what it still uses, every importer of the moved symbol
points at the new module. The dry run shows the removal, the new file's
content (`(new file)` rows start from nothing) and every import edit; the
apply creates the target inside the same transaction as the edits.

Refused by name: a position inside a body (point at the declaration's
name), a statement that is not a declaration, a target that is the source,
a directory, or a file of another language. TypeScript and JavaScript only;
another lane's server answers that it does not offer a symbol move.

## pathRename — a file or directory with its imports

`pathRename` (`filePath`, `newPath`) asks every server that claims the file
for the import-updating edits of the move (`workspace/willRenameFiles`),
previews them with a plan token, and applies the edits and the move as one
transaction. A directory move claims through the extensions of the files it
contains.

## codeActions — quickfixes, refactors and source actions by kind

`codeActions` at a position or range lists what the service offers, each
with a stable id (`ca-…`) derived from what the action is, never from its
position in the list.

- `kind` filters the list: `quickfix`, `refactor` (or a sub-kind such as
  `refactor.extract`), and the whole-file source actions
  `source.organizeImports`, `source.addMissingImports`,
  `source.removeUnusedImports`, `source.removeUnused`. Source actions are
  offered only when asked for by kind.
- `actionId` without `apply` previews that action's edits and plan.
- `apply: true` with `actionId` writes; with a `kind` that leaves exactly
  one action, the action is chosen by the kind.
- A command-only action (one that would run code on the server) is refused;
  a refactor that would create a file is refused in favour of `moveSymbol`.

`organizeImports` and `fixDiagnostic` are the same road with the kind fixed:
organise imports changes only the import block; `fixDiagnostic` pulls the
diagnostics at a position, offers the fixes, applies the sole candidate, and
reports the error count before and after.

## JavaScript projects

The sidecar finds the nearest `tsconfig.json` or `jsconfig.json` above a
file; a `jsconfig.json` project is analysed whole, so a rename in one
JavaScript file reaches the others. A file under neither lands in an
inferred project that holds only the files the session has opened.

## The checks

Mercury's own checks drive the real sidecar through the real ops on a TypeScript
project with a barrel, an aliased re-export, a JSX file and a JavaScript file, and
on a JavaScript project with a `jsconfig.json`: a rename touches every reference
and nothing else, a move rewrites every import, a colliding rename is refused
with the reason, a dry run applies nothing, and a stale plan is refused.
