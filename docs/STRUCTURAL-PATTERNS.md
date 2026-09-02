# Structural patterns — AstSearch and AstEdit

Mercury searches and rewrites code by its **syntax shape**: a pattern written
in the target language, with meta-variables standing for the parts that vary,
is matched against the parsed syntax tree of every file in scope — never
against text. Two built-in tools carry it: `AstSearch` finds, `AstEdit`
rewrites. Both ride ONE matcher, so an edit's match set is the search's
match set by construction. The `Structure` tool's pattern lane
(`op:"query" pattern:…`) uses the same engine.

## The pattern grammar

- A pattern is ONE complete node of the target language, written as code: a
  call `$FN($$$ARGS)`, a statement `if ($COND) { $$$BODY }`, a declaration
  `function $NAME($$$ARGS) { $$$BODY }`, an import
  `import { $$$NAMES } from '$MODULE'`, or a bare identifier `oldName` (every
  identifier node with that text). Wrap a fragment that is not standalone in
  its container: `class $_ { $$$BODY }`.
- Meta-variables: `$NAME` matches exactly one node and captures it; `$$$NAME`
  matches a sequence of zero or more sibling nodes (arguments, parameters,
  statements) and captures it; `$_` matches one node without capturing; `$$$`
  matches a sequence without capturing. Names are UPPERCASE letters, digits
  and underscores. A name used twice must match identical code (`$A == $A`
  finds `x == x`, never `x == y`). `$$X` and `$$$name` are literal text.
- Formatting never matters (spacing, line breaks, comments); structure does.
  `foo($A)` finds every one-argument call to `foo`; `foo($$$ARGS)` every call
  to `foo`; neither finds the word `foo` in a string or a comment.

A pattern is parsed with the target language's own grammar, and you may
write it the way the code is written: an expression without its `;`, a bare
Go call outside any func, a PHP snippet without `<?php`, an ini setting
without its section, a bare C statement, or a JSON/TOML fragment with a
meta-variable in value position — each is read in its natural container. A
pattern that does not parse refuses with the parser's location and a
corrected example — never a silent zero. Matching compares structure: node
types must agree, sequences line up with the `$$$` meta-variables, leaves
compare exact text, and comments are skipped. Every match reports its file,
range, node type, source text and captures.

## Languages

Detection is per file, by extension (a basename first, then the extension);
`lang` forces one. The registry
ROUTES 23 languages; what a build CARRIES is what the tools advertise —
the descriptions list exactly the grammars found in the engine dir the
runtime resolves (`dist/vendor/treesitter` beside the bundle, or the
workspace package for source runs), never the registry alone:

- The `@vscode/tree-sitter-wasm` pack — python · go · rust · javascript ·
  typescript · tsx · bash · c-sharp · cpp · css · java · php · ruby ·
  powershell · ini · regex — is a devDependency: `bun install` brings it,
  every build vendors it. A clean clone's local build carries these 16.
- The grammar-pack extension — c · html · json · toml · kotlin · swift · vue
  — is the lock-pinned `tree-sitter-wasms` cache (`vendor/grammars.lock.json`,
  per-file sha256, tarball sha512). The swift wasm is pinned straight from
  the grammar's own upstream release rather than the pack (the pack's older
  build crashes the runtime's wasm compiler; swift is auditioned in a
  disposable child on first use either way, and a failing blob is refused by
  name instead of taking the process down). There is no postinstall: you
  prepare it with `bun run scripts/vendor/fetch-grammars.ts` (the one
  network step; `--check` validates the cache offline) and rebuild. Release
  archives carry all 23. A local build without the cache says so at build
  time (`vendored WITHOUT them`), the manifest records
  `degraded: structure-polyglot-extended` and `mercury doctor` names it; the
  artifact's own `dist/vendor/treesitter/vendor.json` lists the grammars it
  carries.

In a build that lacks a grammar the registry routes: a file of that
language is skipped and counted by extension with the remedy named in the
result trailer; a single such file, or a `lang` pin on it, refuses by name
with the remedy. A file whose extension routes to no grammar at all is
skipped and counted, never text-matched; a file that does not parse is
reported per file, never matched over. The engine is pure WASM — no native
dependency, one vendored asset set for every platform artifact; when no
engine resolves at all, neither tool is in the catalog. Friendly spellings
resolve (`ts`, `js`, `py`, `rs`, `cs`, `c++`, `sh`, `rb`, `kt`, `ps1`).

## AstSearch

`{ pattern, path?, glob?, lang?, mode?, limit?, offset? }` — `path` is a file
or a directory (the working directory when omitted); `glob` is relative to
it and a bare `*.ts` applies at any depth; `mode` is `matches` (the default:
`file:line:col [node-type]`, the matched code, every capture) or `count`
(matches per file and a total); `limit` defaults to 50 and clamps at 200;
`offset` pages. Every result names what was and was not searched: files
parsed per language, languages where the pattern itself does not parse
(those files were not searched), files that did not parse, the extensions
without a grammar, files hidden by read-deny rules, and every bound that
cut (the walk, the parse count, the match cap). Zero matches name the
pattern and the census. Permissions: the read ladder over the scope path,
plus the read-deny rules per file. Displayed match lines feed the seen-lines
ledger like Grep's.

## AstEdit

`{ pattern, rewrite, path?, glob?, lang?, apply?, plan? }` — the rewrite is
code in the target language; `$NAME`/`$$$NAME` insert the captured source
verbatim; `""` deletes the matched node (a node that owns its line takes the
line with it). Two calls, always:

1. **The dry run** (no `apply`) plans every match, parse-guards every planned
   file, and returns the unified diff per file plus a plan token `ae-…` —
   content-addressed over the pattern, the rewrite and every changed file's
   before/after digest. Nothing is written. A dry run asks nothing (it
   reads).
2. **The apply** (`apply: true, plan: "ae-…"`) re-plans over the current
   bytes and refuses when the token differs — a file changed, or the
   pattern, rewrite or scope did — offering the current dry run. Then it
   writes through the same door every editing tool uses: the write-permission
   ladder per target file with ONE aggregate ask naming the count and the
   files (a denied path refuses the whole set, zero writes; a whole-tool
   allow rule such as `--allowedTools AstEdit` covers it), the diagnostics
   baseline and the file-history snapshot per file (so `/rewind` restores
   it like an Edit), the shared journaled commit walk (ordered path locks,
   digest revalidation, atomic staging with rollback, re-read verification),
   then the read-state refresh, the editor notification, the awaited
   language-server sync, a fresh anchor per file for patch chaining, and one
   change receipt (`file.astEdit`). Partial application is failure, never
   success.

The layout-keeping lane: when the rewrite parses to the same shape as the
pattern — same node types, same children, the same meta-variables in the
same places — only leaf tokens differ (a callee, a keyword, a string), and
the rewrite lands as token edits inside the matched node. A declaration
rename keeps its body, its indentation and its comments. Every other rewrite
(captures moved, nodes added or removed, a fragment, a deletion) substitutes
the template literally. The lane is taken only when its result equals the
literal substitution modulo whitespace and out-of-capture comments.

Refused by name, nothing written: a match nested inside another match (the
pair is named — narrow the pattern or the scope); a rewrite naming a
meta-variable the pattern does not capture; an anonymous `$$$` or `$_` in
the rewrite; a rewrite that would leave a file unparsable (the line is
named); more than 100 files or 500 matches in one edit. Matches already in
the rewritten form are counted and left alone.

## Gate

`MERCURY_STRUCTURE_POLYGLOT` (default-on; `=0` removes both tools from the
catalog).
