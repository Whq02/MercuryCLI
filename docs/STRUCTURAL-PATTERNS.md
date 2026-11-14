# Structural patterns: AstSearch and AstEdit

Mercury searches and rewrites code by its **syntax shape**: a pattern written
in the target language, with meta-variables standing for the parts that vary,
is matched against the parsed syntax tree of every file in scope (never
against raw text). Two built-in tools carry it: `AstSearch` finds, `AstEdit`
rewrites. Both use the same matcher; an edit also checks the source and
the rewritten file before writing.

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
meta-variable in value position; each is read in its natural container. A
pattern that does not parse refuses with the parser's location and a
corrected example, never returning a silent zero. Matching compares structure: node
types must agree, sequences line up with the `$$$` meta-variables, leaves
compare exact text, and comments are skipped. Every match reports its file,
range, node type, source text and captures.

## Languages

Detection is per file, by its name: a basename first (`Dockerfile`), then
the extension, then a basename prefix (`Dockerfile.dev`). `lang` forces one
grammar on a single file whatever its name; over a directory it keeps the
files whose names route to that grammar. The registry routes 57 languages;
what a build carries is what the tools advertise: the `lang` field counts the
grammars found in the engine dir the runtime resolves
(`dist/vendor/treesitter` beside the bundle, or the workspace package for
source runs), never the registry alone, and the answer to a name the build
does not carry lists them:

- The `@vscode/tree-sitter-wasm` pack (python · go · rust · javascript ·
  typescript · tsx · bash · c-sharp · cpp · css · java · php · ruby ·
  powershell · ini · regex) is a devDependency: `bun install` brings it,
  every build vendors it. A clean clone's local build carries these 16.
- The grammar cache carries the rest, each pinned in
  `vendor/grammars.lock.json` by its own sha256 with the source it comes
  from, the upstream commit and the licence. Of the first 23: c · html ·
  json · toml · kotlin · vue from the `tree-sitter-wasms` pack and swift
  from its own release. The 34 added since: yaml · markdown · dockerfile ·
  lua · make · xml · hcl · scala · elixir · zig · haskell · ocaml · svelte ·
  r · julia · starlark · objc · solidity · verilog · odin · tlaplus · diff
  from the grammar's own release or npm package; sql · cmake · graphql ·
  protobuf · dart · astro · nix · clojure · erlang · fortran · just from a
  third party's builds, named as such in the lock, because those grammars
  publish no build of their own (dart's own misreads a type alias); and
  emacs-lisp from the `tree-sitter-wasms` pack. There is no postinstall:
  you prepare the cache with `bun run scripts/vendor/fetch-grammars.ts`
  (the one network step; `--check` validates the cache offline) and
  rebuild. Release archives carry all 57. A local build without the cache
  says so at build time (`vendored WITHOUT them`), the manifest records
  `degraded: structure-polyglot-extended` and `mercury health` names it; the
  artifact's own `dist/vendor/treesitter/vendor.json` lists the grammars it
  carries, `GRAMMAR-NOTICES.json` beside it records each one's repository,
  commit and copyright line, and the licence text of each cache grammar,
  read at that commit, ships under `grammar-licences/` there.

The languages added since the first 23 are read by AstSearch and AstEdit
only: the parse note an edit gives and the outline Read draws keep to the
first 23. Each of them, like swift, is auditioned in a disposable child the
first time a process uses it, and a grammar file that fails there is refused
by name instead of taking the process down.

Beside code these languages cost a search nothing it did not ask for. A
file of theirs that cannot contain the pattern's longest word is counted and
never parsed, so its grammar is not loaded, and one of more than 6 MB is
counted as skipped by its size and never opened. And a pattern whose
meta-variable would be plain text in one of them (`$X` inside a Markdown
paragraph or a YAML scalar) is refused for that language by name (`$X is
text there, not a node`) where it would have parsed and matched nothing;
those files are listed under `Not searched`.

In these languages line endings and a missing final newline do not matter: a
file with CRLF line endings is searched and rewritten as it stands. Markdown
is read by its blocks (headings, lists, fenced code, tables, paragraphs);
the text inside a paragraph is one node, so `## $TITLE` finds every
second-level heading and a pattern cannot reach a word inside a sentence.

A pattern compares the nodes a grammar names and the fields it labels; a
keyword a grammar keeps as an unnamed token is not compared. In these
languages that shows where one node kind has several spellings: in a
Makefile `include $F` also finds `-include`, and in Protocol Buffers
`import $P;` also finds `import public …;` and an `rpc` pattern also finds
the streaming ones. A `$$$` list is refused where a member is never a bare
word: the body of an HCL block, the fields of a GraphQL type, the body of a
Protocol Buffers message, the attributes of an XML tag; name a member
(`instance_type = $T`, `id: ID!`, `string id = 1;`, `order=$V`) or write the
block out. A Protocol Buffers field number is a number, never a
meta-variable.

Dart has no call node: a call is a statement there, so `print($X)` finds
the statement, with or without its `;`, and a rewrite that leaves the `;`
out keeps the statement's own. A body written `{ $$$BODY }` is refused in
Dart and Zig, as it is in Java and C#: name a statement of the body. In
Haskell and OCaml a meta-variable reads as a lower-case name, so it stands
for a value, a variable or a pattern and never for a module or a
constructor: `open $M` is refused in OCaml, and `import $M` is no import
pattern in Haskell (write the module out). A Scala parameter list is
`name: Type` pairs, so `def $N($$$P)` is refused; `$F($$$ARGS)` finds the
calls.

Svelte and Astro files are read as markup: elements, attributes, blocks (an
`{#if $COND}` block to its end) and text. A script, an Astro front matter
and every `{expression}` is one node of plain text to these grammars, so a
code pattern (`count($X)`) is refused there; `{$E}` finds an expression
whole.
In Nix a binding (`version = $V;`), an `inherit` and a call (`mkShell $A`)
are patterns; an attribute set written with a `$$$` list is refused.

Objective-C is read from `.m` files; a header stays C unless `lang` names
`objc` for that one file. Its grammar does not read Foundation's enum
macros or the nullability wrapper: a file that holds a
`typedef NS_ENUM(…) { … };`, an `NS_OPTIONS`, or is wrapped in
`NS_ASSUME_NONNULL_BEGIN` and `NS_ASSUME_NONNULL_END` is reported as not
parsing and is never matched over. Verilog files (`.v`, `.sv`, `.svh`,
`.vh`) are read by a SystemVerilog grammar. A body written `{ $$$BODY }`,
or a block with a `$$$` body, is refused in Objective-C, Solidity, Fortran
and Verilog too; name a statement (`[$OBJ addObject:$X]`, `emit Ran($X);`,
`call greet($X)`, `$A <= $B;`). A diff is read line by line: a changed line
is one node, so `-int old(void);` finds that line and `+$X` is refused. The
recipe lines of a justfile, like a Makefile's, are text; its aliases,
settings, variables and recipe headers are nodes. Emacs Lisp and Clojure
forms, and calls and definitions in R, Julia, Starlark, Erlang, Odin and
TLA+, are written as they stand.

In a build that lacks a grammar the registry routes: a file of that
language is skipped and counted by extension with the remedy named in the
result trailer; a single such file, or a `lang` pin on it, refuses by name
with the remedy. A file whose extension routes to no grammar at all is
skipped and counted, never text-matched. AstSearch searches a recovered
tree when the parser reports syntax errors. Its trailer names the file,
language and error locations, with omitted counts for longer reports;
matches may include parser recovery. A parser that returns no tree leaves
the file unsearched and names the reason. The engine is pure WASM (no native
dependency, one vendored asset set for every platform artifact); when no
engine resolves at all, neither tool is in the catalog. Friendly spellings
resolve (`ts`, `js`, `py`, `rs`, `cs`, `c++`, `sh`, `rb`, `kt`, `ps1`); for
an added language every extension without its dot is a name too (`yml`,
`md`, `tf`, `proto`, `ex`, `hs`, `ml`, `jl`, `sol`, `sv`), beside the usual
ones (`docker`, `makefile`, `terraform`, `gql`, `objective-c`, `elisp`,
`systemverilog`, `tla+`, `patch`).

## AstSearch

`{ pattern, path?, glob?, lang?, mode?, limit?, offset? }`: `path` is a file
or a directory (the working directory when omitted); `glob` is relative to
it and a bare `*.ts` applies at any depth. `glob` takes `{a,b}` alternatives,
at most 64 after expansion. `mode` is `matches` (the default:
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

`{ pattern, rewrite, path?, glob?, lang?, apply?, plan? }`: the rewrite is
code in the target language; `$NAME`/`$$$NAME` insert the captured source
verbatim; `""` deletes the matched node (a node that owns its line takes the
line with it). Two calls, always:

1. **The dry run** (no `apply`) plans every match, parse-guards every planned
   file, and returns the unified diff per file plus a plan token `ae-…`
   (content-addressed over the pattern, the rewrite and every changed file's
   before/after digest). Nothing is written. A dry run asks nothing (it
   reads).
2. **The apply** (`apply: true, plan: "ae-…"`) re-plans over the current
   bytes and refuses when the token differs (if a file changed, or the
   pattern, rewrite or scope changed), returning the current dry run. Then it
   writes through the same door every editing tool uses: the write-permission
   ladder per target file with one aggregate ask naming the count and the
   files (a denied path refuses the whole set, zero writes; a whole-tool
   allow rule such as `--allowed-tools AstEdit` covers it), the diagnostics
   baseline and the file-history snapshot per file (so `/rewind` restores
   it like an Edit), the shared journaled commit walk (ordered path locks,
   digest revalidation, atomic staging with rollback, re-read verification),
   then the read-state refresh, the editor notification, the awaited
   language-server sync, a fresh anchor per file for patch chaining, and one
   change receipt (`file.astEdit`). Partial application is failure, never
   success.

An error-bearing file can be rewritten when every matched subtree is clean
and the replacement spans stay outside error spans and missing-token
positions. Mercury reparses the result and compares every error's kind,
position through the edits, and source bytes. A new error refuses the plan;
pre-existing errors outside the edited spans may remain. The preview names
those errors with the recovered-tree warning.

The layout-keeping lane: when the rewrite parses to the same shape as the
pattern (same node types, same children, and the same meta-variables in the
same places), only leaf tokens differ (a callee, a keyword, a string), and
the rewrite lands as token edits inside the matched node. A declaration
rename keeps its body, its indentation and its comments. Every other rewrite
(captures moved, nodes added or removed, a fragment, a deletion) substitutes
the template literally. The lane is taken only when its result equals the
literal substitution modulo whitespace and out-of-capture comments.

Refused by name, nothing written: a match nested inside another match (the
pair is named; narrow the pattern or the scope); a rewrite naming a
meta-variable the pattern does not capture; an anonymous `$$$` or `$_` in
the rewrite; a match touching existing syntax damage or a rewrite that
introduces a syntax error (the location is named); more than 100 files or
500 matches in one edit. Matches already in
the rewritten form are counted and left alone.

## Memory: the held grammars

The JavaScript engine Mercury runs on recompiles hot WebAssembly with an
optimising compiler. For a grammar with a very large lexer that
recompilation costs the process resident memory out of all proportion to
the speed it buys, so a grammar whose optimiser costs 400 MB or more is
parsed with the optimiser held off: its own lexer stays baseline code, while
the engine's shared runtime and every other grammar keep full speed. The
threshold sits in a gap of the measured costs: the next grammar below it
costs 291 MB.

| Grammar | Resident memory under sustained parsing, free | Held | Parse speed held |
| --- | --- | --- | --- |
| fortran | 3,052 MB | 104 MB | 97% |
| swift | 3,022 MB | 94 MB | 73% |
| powershell | 2,181 MB | 87 MB | 83% |
| bash | 625 MB | 84 MB | 80% |
| verilog | 608 MB | 149 MB | 88% |
| kotlin | 566 MB | 93 MB | 86% |
| objc | 558 MB | 95 MB | 80% |
| tlaplus | 521 MB | 96 MB | 93% |
| markdown | 505 MB | 84 MB | 91% |

These are readings of one process a grammar on macOS (Apple silicon) under
the runtime Mercury ships: 400 parses of a small file, then a few seconds
idle. The bash grammar also reads every Bash command for the permission
check, so its row is memory a long session used to carry whether or not it
searched by structure.

The heavy grammars under the threshold keep the optimiser and what it
costs: cpp about 290 MB, scala 235 MB, julia 225 MB, elixir 185 MB, c
170 MB, c-sharp 155 MB, sql 135 MB, ocaml 130 MB, css 120 MB.

`MERCURY_GRAMMAR_BASELINE=0` lets every grammar reach the optimiser: full
parse speed for the held ones, at the memory of the "free" column. The hold
is also off when Mercury runs on an engine other than V8, and when node was
started with WebAssembly tiering flags of your own.

## Gate

`MERCURY_STRUCTURE_POLYGLOT` (default-on; `=0` removes both tools from the
catalog).
