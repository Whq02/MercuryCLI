---
name: skill-forge
description: Use when writing or fixing a Mercury SKILL.md and its discovery rules. Not for /skillify session capture or extension packaging.
argument-hint: "<skill name or path> [purpose]"
---
# Skill forge

Start from observed tasks, realistic trigger/non-trigger/sibling prompts, a no-skill baseline and the current skill. Write only what those tasks require; put optional depth in one-level `references/` files with one-line when-to-read pointers, without duplicating text across both.

Place `SKILL.md` in `.mercury/skills/<name>/` (project) or `<config-home>/skills/<name>/` (personal). Prefer lowercase hyphenated directory names; built-in and bundled names win collisions.

Frontmatter:
- `description`: start with the trigger (`Use when …`) and sibling boundary (`Not for …`), fitting whole within `MAX_LISTING_DESC_CHARS` (250 in `src/tools/SkillTool/constants.ts`; `when-to-use`, if set, joins as `description - when-to-use` under that 250-char cap).
- `argument-hint`: leading `<` requires an argument (bare `/name` prints usage); `[optional]` or omitted runs bare.
- `disable-model-invocation: true` reserves invocation for the user; `user-invocable: false` hides/refuses `/name` while allowing the model. Neither grants permissions; omit `allowed-tools` when only `Read`, `Grep` or `Glob` are used.

Disk skills prepend their base directory and expand declared `$name` (`arguments`), `$ARGUMENTS[n]`, `$n`, `$ARGUMENTS`, `${MERCURY_SKILL_DIR}` and `${MERCURY_SESSION_ID}`. Generated bundled skills append arguments after the body and supply a base directory only when `references/` exist (never use disk substitution tokens there). CODE inspected 2026-11-13: `src/skills/loadSkillsDir.ts`, `src/skills/argumentHint.ts`, `src/tools/SkillTool/prompt.ts`, `scripts/skills/gen-bundled.ts`, `src/skills/bundledSkills.ts`.

Check name, visibility, hint behavior, expanded body and reference extraction through Mercury's real loader. On target models/effort, compare baseline, current and variant across trigger/non-trigger cases (invocations, references read, outcomes, tokens and latency at comparable success); prune only redundant or unused guidance from observed runs, never by size alone, and mark unrun cases unverified. Refresh versioned or external API claims from dated primary sources rather than copying moving catalogues. Method: **LIVE page read 2026-11-13**, [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices); Mercury's loader defines frontmatter rules.
