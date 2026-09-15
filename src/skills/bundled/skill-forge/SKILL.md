---
name: skill-forge
description: Use when authoring, packaging or debugging a Mercury skill and its discovery description. Not for session capture via /skillify, agent definitions, hooks or extension packaging.
argument-hint: "<skill name or path> [purpose]"
---
# Skill forge

## Locate
- Put `SKILL.md` in a lowercase, hyphenated skill directory.
- Use `<project>/.mercury/skills/<name>/` for project scope, the config home's `skills/<name>/` for user scope, or a declared extension skill directory.
- Account for bundled-name precedence; otherwise the first loaded name wins.
- Keep supporting material in `references/` and offline helpers in `scripts/`.

## Define
- Set `name` to the directory name and supply `description`.
- Start the description with the task and `Use when`; put the exclusion second.
- Keep routing information within the first 250 characters and the whole description within 1,000.
- Add `when-to-use` only for distinct triggers; use `argument-hint` for invocation syntax.
- Set `disable-model-invocation: true` for user-only invocation; set `user-invocable: false` to hide slash completion.
- Use `allowed-tools`, `model` and `effort` only when their overrides are needed; verify model IDs against the live catalogue.
- For skills that deploy, delete, post or pay, require user invocation and describe the effects before execution.

## Write
- Put the procedure first; keep the body within 250 lines.
- Link references at the decision that needs them; do not duplicate their content.
- State how supplied arguments and omitted arguments affect the procedure.
- For disk skills, use `$ARGUMENTS` for invocation arguments and `${MERCURY_SKILL_DIR}` for local paths.
- For bundled skills, resolve helper paths from the supplied base directory; bundled arguments are appended to the body.
- Preserve required steps when cutting an existing skill; remove repetition and unsupported claims.

## Check
- Resolve `${MERCURY_SKILL_DIR}` from the supplied base directory.
- Lint names, frontmatter, description, paths and body size with `python3 "${MERCURY_SKILL_DIR}/scripts/skill_lint.py" <skill-directory>`; use `--self-test` to test the helper.
- Give each helper an offline `--self-test`; run it.
- Invoke the skill on a representative request and confirm the intended body loads.

## Source
Checked: 2026-09-15. [Mercury skill implementation](https://github.com/Whq02/MercuryCLI/tree/fc81e29e4129a56b1bfb3beca9819ebfb29875f9/src/skills).
