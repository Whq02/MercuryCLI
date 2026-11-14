# Bundled skills

The eight skills in this directory compile into the Mercury build. Each directory holds a `SKILL.md` (`description` with trigger first and sibling boundary, optional `argument-hint` and `user-invocable`, plus the body loaded on invocation). Three also carry on-demand `references/` (`extension-maker`, `image-generation`, `provider-apis`). None ships helper scripts; each works through Mercury's own tools (`Read`, `Document`, `Eval`, `Browser`, `Service`, `Crewmate`, `CrewBoard`, `mercury mcp add`, `mercury extensions …`) and project dependencies verified before use.

| Skill | What it does |
|---|---|
| `code-review` | reviews local changes, a commit, a branch or a pull request with parallel finders and cross-family verification |
| `deep-research` | runs multi-source research with a team captain on `CrewBoard`, adversarial claim refutation and a final spot-check |
| `extension-maker` | scaffolds, repairs and validates a Mercury extension or source catalogue (`mercury extensions inspect`) |
| `image-generation` | generates and edits images or video via `mercury-media`, reading live tool schemas and installed model rows |
| `mcp-smithy` | builds an MCP server around a focused tool contract, proves it with the SDK client, and registers it with `mercury mcp add` when asked |
| `provider-apis` | maps Mercury's provider roads (Anthropic Messages, OpenAI Responses, chat-completions and native codecs) with replay, caching, usage and proof invariants |
| `research` | researches paper/document corpora with page-level evidence, `Document` OCR/inspection, adaptive search and cited deliverables |
| `skill-forge` | writes or repairs a Mercury `SKILL.md`, checking discovery, hint behavior and expansion through the real loader |

## Editing and regenerating

Edit sources here, then regenerate `src/skills/bundled/`:

```bash
bun run scripts/skills/gen-bundled.ts            # regenerate all; prune retired output
bun run scripts/skills/gen-bundled.ts mcp-smithy  # regenerate one skill
bun run scripts/skills/gen-bundled.ts --check    # check drift without writing
bash scripts/skills/run-all.sh                   # run the bundled-skills suite
```

`mercury-skills/` is the source of truth (`[a-z0-9][a-z0-9_-]*` names). Full runs regenerate every skill and prune retired modules marked with `export const GENERATED_BY = 'scripts/skills/gen-bundled.ts'` (leaving hand-written modules untouched); targeted runs touch only the named skills. Register any newly added skill in `src/skills/bundled/index.ts` using the import and call lines `gen-bundled.ts` prints.

At runtime, skills with `references/` extract them once into a per-process temporary directory (never the user's config home) and prepend that base directory; reference-free skills load their body alone.
