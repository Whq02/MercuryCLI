---
name: skill-forge
description: Author or revise a Mercury skill (a SKILL.md with optional helper files) — the frontmatter contract, a discovery description that triggers only when it should, a body that loads only on invocation, and where the skill lives so Mercury finds it. Use when asked to create, package, tighten, or debug a skill from a description of what it should do; not for capturing the current session's process (that is /skillify), and not for agent definitions, hooks, or extensions.
when_to_use: The user wants a new skill, asks why a skill does or does not trigger, or wants an existing SKILL.md made smaller, sharper, or portable.
argument-hint: "<skill name or path> [what it should do]"
---

# Skill forge

A skill is one directory: `SKILL.md` plus any files the body points at. Mercury
reads the frontmatter at boot to decide *whether* to offer the skill and reads
the body only when the skill is invoked. Every design choice below follows from
that split.

## Where a skill lives

| Scope | Path | Loads when |
|---|---|---|
| This project | `<project>/.mercury/skills/<name>/SKILL.md` | the project is open |
| Every project | `~/.mercury/skills/<name>/SKILL.md` | always |
| Extension | `skills/<name>/SKILL.md` inside the extension | the extension is approved and on |

The directory name is the skill name. A bundled skill with the same name wins a
collision; otherwise the first loaded copy wins and the rest are skipped.

## The frontmatter contract

```yaml
---
name: release-notes            # matches the directory; lowercase, hyphens
description: One or two sentences — what it does AND when to reach for it.
when_to_use: Optional extra trigger text, shown to the model beside description.
argument-hint: "[version] [--draft]"   # what follows /release-notes
allowed-tools: Read, Grep, Glob        # narrow the tool grant while the skill runs
disable-model-invocation: true         # user-only: never auto-discovered
user-invocable: false                  # model-only: hidden from / completion
context: fork                          # run in a forked context instead of inline
agent: reviewer                        # hand the body to a named agent definition
model: claude-opus-5                   # pin a model for this skill
effort: high
paths: ["src/**", "docs/**"]           # offer only when these paths are in play
---
```

Only `name` and `description` are required. Leave every other key out unless it
changes behaviour: a key that restates the default is noise the reader has to
verify.

## Writing the description

The description is the whole discovery budget. It is read for every turn in
which the model decides what to invoke, so it must be short, and it must be
distinct enough that the wrong skill never fires:

- Say what the skill does, then the trigger ("Use when …"), then one exclusion
  ("not for …") when a neighbouring skill could be confused with it.
- Name the user's words, not yours. The model matches the request it sees.
- No history, no credits, no version notes. Those belong in the body or nowhere.
- Around 250–400 characters is the working range; past 1,000 the description is
  a body in disguise.

## Writing the body

The body is instructions for the one turn that invoked it. It is read in full,
once, so:

- Put the decisive contract first; put depth in `references/*.md` and tell the
  reader when to open each file. Never paste a reference inline.
- Prefer a short checklist over prose. Each line states a constraint the reader
  could violate, not a summary of the obvious.
- Helper scripts go under `scripts/` and are invoked by relative path. Every
  helper must run without a network and carry a `--self-test`, so the skill can
  prove its own tooling on any machine.
- Write in Mercury's voice: direct, specific, no emoji, no motivational filler.
- Keep `$ARGUMENTS` semantics explicit: say what the skill does with and
  without arguments.

## Side-effecting and user-only skills

A skill that deploys, deletes, posts, or pays must set
`disable-model-invocation: true`, so it runs only when a person types it, and
it must say in its first lines what it will touch. A skill that merely reads
may stay discoverable.

## Checking a skill

Run the linter on the skill directory before shipping it:

```bash
python3 scripts/skill_lint.py <path-to-skill-dir>
python3 scripts/skill_lint.py --self-test
```

It verifies the frontmatter parses, the name matches the directory, the
description is within budget and carries a trigger, every relative path the
body mentions exists, and the body stays under the size where it should have
been split into references. Fix every finding; the linter's exit status is the
verdict.

## When revising an existing skill

1. Read the current `SKILL.md` once; list what the description promises and
   what the body actually instructs.
2. Cut before adding: any line that restates a default, narrates history, or
   duplicates a reference file goes.
3. Re-run the linter, then invoke the skill on a real request and confirm it
   produced the behaviour the description promised.
