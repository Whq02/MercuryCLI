# Bundled skills

The skills in this directory ship inside the Mercury build. Each is one
directory holding a `SKILL.md`: frontmatter (`description` with the trigger
first, `argument-hint`) plus the instructions the skill loads on invocation.
Two skills also carry `references/` files, read on demand: `extension-maker`
(the generated manifest contract and the source README template) and
`provider-apis` (one reference per API dialect, the live documentation
sources and the model-catalogue guidance). No skill ships a helper script;
each works through Mercury's own tools (`Read`, `Eval`, `Browser`, `Service`,
`mercury mcp add`, `mercury extensions …`) and whatever libraries and
renderers the project has installed, checked before use.

| Skill | What it does |
|---|---|
| `app-proof` | proves a web journey with Mercury's `Browser` and `Service` tools: readiness, actions, an observable result, a failure case, a recorded verdict per journey |
| `extension-maker` | makes or repairs a Mercury extension or source catalogue — one manifest contributing skills, commands, agents, hooks, servers, or keybindings — validated with `mercury extensions validate` |
| `mcp-smithy` | builds an MCP server for a Mercury session around a small tool contract, proves it with the SDK client, and registers it with `mercury mcp add` only when asked |
| `pdf-documents` | inspects, transforms, fills, redacts, and generates PDFs with the installed PDF libraries, reopening the output to verify it |
| `provider-apis` | the reference for every provider API Mercury speaks — Anthropic Messages, OpenAI Responses, and the OpenAI-compatible chat-completions families — with request shapes, streaming, tool calls, caching, and live model sources |
| `skill-forge` | writes and fixes a Mercury `SKILL.md` and its discovery rules, then checks discovery and expansion through the real loader |
| `slide-decks` | creates and revises PowerPoint slides, layouts, and speaker notes from a template's layouts, rendering every slide to check it |
| `spreadsheets` | edits Excel workbooks and turns tabular data into one without losing formulas, recalculating and cross-checking totals |
| `word-documents` | creates and revises Word files while preserving styles, sections, tables, comments, and tracked revisions |

## Editing and regenerating

Edit here, then regenerate the compiled modules under `src/skills/bundled/`:

```bash
bun run scripts/skills/gen-bundled.ts            # every skill; prunes retired output
bun run scripts/skills/gen-bundled.ts app-proof  # one skill; touches nothing else
bun run scripts/skills/gen-bundled.ts --check    # report drift without writing
bash scripts/skills/run-all.sh                   # the bundled-skills suite
```

This directory is the source of truth. A full run regenerates every skill
and removes the output of a retired one — its generated `<name>.ts` and
`<name>Content.ts` (recognised by their first line, `export const
GENERATED_BY = 'scripts/skills/gen-bundled.ts'` — a line of code, so a
comment-stripped checkout keeps it — never a hand-written module) and the
mirror directory beside them; a targeted run regenerates
only the names given, pruning a named skill whose source is gone and
nothing else. `--check` renders in memory and names every stale, missing or
stray file. Any other option is refused, as is a full run that finds no
skill here. Skill names are lowercase letters, digits, `-` and `_`. A new
skill also needs its import and register call
added by hand to `src/skills/bundled/index.ts`; the generator prints both
lines.

At runtime a skill with reference files extracts them to a per-process
temporary directory on first invocation and opens its prompt with that base
directory; it never writes into a user's config home. A skill without
reference files loads its body alone.
