---
name: extension-maker
description: Make or publish a Mercury extension — a folder with one mercury-extension.json manifest contributing skills, commands, agents, hooks, MCP servers, language servers, channels or keybindings — or a source (a git repo, folder or archive carrying mercury-extensions.json) others can add. Use when asked to create an extension, package skills/hooks/servers into one, publish a source or catalogue, write a mercury-extension.json, or debug why one reads partial or broken.
---

# Making a Mercury extension

An extension is a folder with ONE manifest, `mercury-extension.json`, at its root. Mercury
reads nothing the manifest does not declare. The full field-by-field contract is in
`references/CONTRACT.md` (generated from the runtime schemas — trust it over memory);
the source README template is `references/README-template.md`.

## The shape

```
<name>/
├── mercury-extension.json     required — the only file Mercury reads unprompted
├── README.md                  recommended
├── skills/<skill>/SKILL.md    one folder per skill
├── commands/<cmd>.md          one prompt file per command
├── agents/<agent>.md          one definition per agent
└── …                          anything the extension's own servers need
```

Rules that bite:

- `name`: lowercase kebab, 1–40 chars; it namespaces everything (`/<name>:<skill>`,
  agent `<name>:<agent>`, server `ext:<name>:<server>`).
- Every path in the manifest is relative and must stay inside the folder.
- Unknown top-level keys warn at load and FAIL `mercury extensions validate`; typos
  inside `contributes`/`servers`/`needs` fail at load.
- Only `type: "command"` hooks; events come from Mercury's hook vocabulary.
- `module` is reserved — this build loads declarative extensions.
- `${MERCURY_EXTENSION_ROOT}`, `${MERCURY_EXTENSION_DATA}` and `${option.KEY}`
  substitute in command lines, args, env values and prompt bodies; nothing else does.
  Hooks and servers also receive those two folders plus one
  `MERCURY_EXTENSION_OPTION_<KEY>` per option in their environment.
- A `sensitive` option never appears in prose the model reads — it renders as a
  placeholder; declare it under `needs.options` and read it from env in scripts.
- Approval is per contributions hash (`contributes` + `needs`): changing a command
  line, hook, server or need re-asks the operator; a version bump alone does not.

## The loop

1. Scaffold: `mercury extensions init <name>` (or write the folder by hand).
2. Develop in place: put the folder at `.mercury/extensions/<name>/` in the project;
   the operator approves it once from `/extensions`; after edits, `r` reloads —
   a contributions change re-asks.
3. Lint: `mercury extensions validate <path>` — it names ignored side files, dead
   paths, unknown keys, unmet needs.
4. Publish: push the folder as its own repository (a single-extension source), or add
   an entry to a source's `mercury-extensions.json` catalogue (`path` inside the repo,
   or `git` + `ref` for an entry hosted elsewhere). The catalogue's `name`/`version`
   must equal the manifest's — a mismatch refuses the install as a lying catalogue.
5. Ship a README from `references/README-template.md`.

## Two rules this skill never breaks

- **Never add a source on the operator's behalf.** Adding a source
  (`mercury extensions add …`) is the operator's act.
- **Never approve an extension on the operator's behalf.** Approval (the card, or
  `--yes`) is the operator's act.

Build the folder, validate it, and end by telling the operator exactly which verb to
run next — typically `mercury extensions add <url>` for a new source, or `/extensions`
→ `i` on the `◇ found` row for a project folder.
