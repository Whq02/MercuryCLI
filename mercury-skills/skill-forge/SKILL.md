---
name: skill-forge
description: Use when writing or fixing a Mercury SKILL.md and its discovery rules. Not for /skillify session capture or extension packaging.
argument-hint: "<skill name or path> [purpose]"
---
# Skill forge

Start with observed tasks and the outcome the skill must improve. Collect realistic trigger, non-trigger and confusable sibling requests, not just prompts repeating the skill's name. Keep a safe no-skill baseline and the current skill before making a variant. Write only the guidance those tasks need; link optional depth directly and read only the relevant reference.

Place SKILL.md in `.mercury/skills/<name>/` for a project or `skills/<name>/` under the configured home. The directory names the invocation; built-in/bundled names win collisions. Prefer lowercase, hyphenated names.

Frontmatter's description starts with the specific trigger. A leading `<` in `argument-hint` makes a bare slash show usage; an optional hint permits a bare turn. `disable-model-invocation: true` reserves invocation for the user; `user-invocable: false` hides/refuses slash invocation but allows the model. Neither authorises effects.

Disk bodies prepend their base directory and substitute declared `$name`, `$ARGUMENTS[n]`, `$n`, `$ARGUMENTS`, `${MERCURY_SKILL_DIR}` and `${MERCURY_SESSION_ID}`. Generated bundled bodies append arguments instead and supply a base when references exist; do not assume disk substitution there. Reference paths are relative to that base. CODE inspected 2026-11-04: `src/skills/loadSkillsDir.ts` (createSkillCommand), `src/skills/argumentHint.ts` (requiresArgument), `scripts/skills/gen-bundled.ts` and `src/skills/bundledSkills.ts` own these behaviors.

Check name, visibility, arguments, expanded body and extracted references through Mercury's real loader. That proves mechanics, not that a model chooses the right skill or completes the task. On the operator's intended engines/effort, repeat baseline/current/variant cases and record actual invocations, references read and task outcomes, including wrong loads and omissions. Compare tokens and latency only at comparable success and settings. Keep improvements supported by those results; prune unused or redundant guidance from observed use, not size alone. Report cases not run as unverified.

When a claim depends on a version or external API, refresh its relevant source and record the date beside it; do not copy moving catalogues. Method: **LIVE page read 2026-11-04**, [skill authoring: evaluation and iteration](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices). Its evaluation method informs this workflow; Mercury's loader, not another product's frontmatter rules, defines the contract.
