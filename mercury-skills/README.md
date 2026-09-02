# Bundled skills

The skills in this directory ship inside the Mercury build. Each is one
directory: `SKILL.md` (frontmatter plus the instructions the skill loads on
invocation), optional `references/` read on demand, and a `scripts/` helper
that runs without a network and carries a `--self-test`.

| Skill | What it does |
|---|---|
| `aesthetic-direction` | gives a web interface a deliberate visual identity — type, colour, spacing, motion derived from one direction |
| `app-proof` | proves a web app works by driving it: readiness, browser journeys, screenshots, a recorded verdict |
| `drafting-partner` | co-writes long documents with the user: brief, outline, section drafting, steered review passes |
| `extension-maker` | makes or publishes a Mercury extension — one manifest contributing skills, commands, agents, hooks, servers, or keybindings — and the sources that carry them |
| `mcp-smithy` | builds, probes, and registers Model Context Protocol servers |
| `pdf-documents` | extracts, transforms, fills, and generates PDF files |
| `provider-apis` | the reference for every provider API Mercury speaks — Anthropic Messages, OpenAI Responses, and the OpenAI-compatible chat-completions families — with request shapes, streaming, tool calls, caching, and live model sources |
| `skill-forge` | authors and lints Mercury skills |
| `slide-decks` | builds and revises PowerPoint decks from a template's layouts |
| `spreadsheets` | reads, builds, and repairs Excel workbooks with live formulas |
| `word-documents` | creates, edits, and reviews Word documents, including tracked changes |

## Editing and regenerating

Edit here, then regenerate the compiled modules under `src/skills/bundled/`:

```bash
bun run scripts/skills/gen-bundled.ts            # every skill
bun run scripts/skills/gen-bundled.ts app-proof  # one skill
bash scripts/skills/run-all.sh                   # the bundled-skills suite
```

Helpers are checked with `python3 <skill>/scripts/<helper>.py --self-test`
or `node <skill>/scripts/<helper>.mjs --self-test`.

At runtime a bundled skill extracts its files to a per-process temporary
directory on first invocation; it never writes into a user's config home.
