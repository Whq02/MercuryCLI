---
name: skill-forge
description: Use when writing or fixing a Mercury SKILL.md and its discovery rules. Not for /skillify session capture or extension packaging.
argument-hint: "<skill name or path> [purpose]"
---
# Skill forge

Start from the supplied task and two examples: a request that should load the skill and one that should not. Write only the procedure Mercury would otherwise miss.

Place `SKILL.md` in `.mercury/skills/<name>/` for the project, or `skills/<name>/` under Mercury's configured home for the user. The directory supplies the invocation name; bundled names win collisions. Keep names lowercase and hyphenated.

Frontmatter needs a specific `description` with the trigger first. `argument-hint: "<required> [optional]"` makes a bare slash send show usage; an optional hint allows a bare invocation. `disable-model-invocation: true` reserves invocation for the user; `user-invocable: false` makes it the model's alone, hidden from slash completion and refused when typed. Neither grants permission for the skill's effects.

Disk bodies substitute `$ARGUMENTS` and `${MERCURY_SKILL_DIR}`. Generated bundled bodies instead receive arguments appended and, when references exist, a supplied base directory. Do not assume disk substitution there. Keep reference paths relative to that base.

Check discovery and expansion through Mercury's real loader: intended name, arguments, body and referenced files. Try both routing examples. Report what actually loaded, not just whether the Markdown looks valid.
