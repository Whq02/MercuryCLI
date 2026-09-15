Checked: 2026-09-15
# Model selection

Use `/model` for the offered catalogue and `/submodels` for signed-in families.
Respect `availableModels` filtering; verify account access before choosing an ID.

| Anthropic ID | Mercury label |
|---|---|
| `claude-fable-5-1` | (Fable 5.1, the frontier row) |
| `claude-opus-5` | Opus 5 |
| `claude-sonnet-5` | Sonnet 5 |

Source: [current Anthropic models](https://platform.claude.com/docs/en/about-claude/models/overview).

Read `live-sources.md` for other families; do not copy a historical model inventory.
Use `openrouter/vendor/model`, `huggingface/org/model`, `compat/id` or `local/id` for carrier routes; retain the provider's inner slug.
Check served context, effort levels and prices separately; an ID alone establishes none of them.
Use each provider's documented discovery endpoint rather than assuming every family implements the same `/models` response.
