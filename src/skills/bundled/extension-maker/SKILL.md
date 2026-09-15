---
name: extension-maker
description: Use when creating, packaging or debugging a Mercury extension or source catalogue. Not for installing or approving an extension on the operator's behalf.
---
# Make a Mercury extension

- Put `mercury-extension.json` at the extension root.
- Read `references/CONTRACT.md` for fields; apply the complete approval rule below.
- Use lowercase letters, digits and hyphens for `name`, 1–40 characters, starting with a letter or digit.
- Declare contributions explicitly; keep manifest paths inside the root.
- Put skills in child directories containing `SKILL.md`; put commands and agents in Markdown files.
- Use only command hooks and registered hook events; leave reserved `module` unset.
- Substitute `${MERCURY_EXTENSION_ROOT}`, `${MERCURY_EXTENSION_DATA}` and `${option.KEY}` only where supported.
- Declare secrets as sensitive options; read their environment values in scripts, not model-facing prose.
- Bind approval to `contributes`, `needs` and delivered file bytes. A version-only manifest change preserves approval; changed delivered content re-asks.

## Build and validate
- Scaffold with `mercury extensions init <name>`.
- Develop in `.mercury/extensions/<name>/`; let the operator approve and reload through `/extensions`.
- Run `mercury extensions validate <path>`; fix unknown keys, escaping paths and unmet needs.
- Package a single-extension repository or a `mercury-extensions.json` catalogue.
- Match catalogue name/version to the manifest; use either `path` or `git` with optional `ref`.
- Use `references/README-template.md` for source setup, requirements and updates.
- Never add a source on the operator's behalf; never approve an extension for them.
- Hand over the validated folder and the operator's next command or `/extensions` action; do not publish without authorisation.

## Source
Checked: 2026-09-15. [Mercury extension implementation](https://github.com/Whq02/MercuryCLI/tree/fc81e29e4129a56b1bfb3beca9819ebfb29875f9/src/extensions).
