# Contributing to Mercury

Thank you for reading Mercury closely enough to want to change it. This page
says how issues and pull requests work here, how to build and check a change,
and the few conventions the tree keeps.

## Issues

Issues are welcome, through the templates the tracker offers:

- **Bug report**: something behaves wrongly.
- **Provider or model report**: a sign-in door, a model row, a refusal or a
  warning that reads wrong.
- **Feature request**: something Mercury should do and does not.

Every template asks for the `--version` line, the OS and terminal, and the
exact steps; the bug and provider templates ask for the output of
`doctor --json` as well. A security problem goes through the repository's
Security tab, never an issue: see [SECURITY.md](SECURITY.md).

## Pull requests

Pull requests can be opened by the repository's collaborators only. That is a
setting on the repository, not a judgement of anyone's work: if you are not a
collaborator and have a change in mind, open an issue that describes it, with
the diff pasted in if you have one, and it will be read.

## Building and checking a change

Build and run first:

```sh
bun run setup                      # once; bun install + the five vendored packs
bun run build.ts                   # writes dist/mercury.mjs + dist/manifest.json
node dist/mercury.mjs --version
node dist/mercury.mjs              # the cockpit needs a real TTY, 100+ columns
node dist/mercury.mjs doctor --json
```

Then the checks:

```sh
bun run typecheck                  # strict; zero baseline
bash scripts/<suite>/run-all.sh    # the suite nearest your change
bun run verify                     # every suite, pooled; exit 0 is green
```

Run the suite nearest to what you changed while iterating; `bun run verify`
is the closing check, and its exit status is the verdict. Hosted, the gate is
two verdicts split by each suite's `# gate-class:` header: `gate.yml` plans the
deterministic suites (pure, cpu, exclusive) and is the verdict a release
carries; `drives.yml` plans the real-terminal suites (pty), which report on
their own with the flake retry and never block a release. A suite whose
provers boot the built bundle in a pseudo-terminal is a pty suite whatever
its header says — the gate suite's census reds the mismatch — and a mixed
suite keeps its deterministic provers and moves the drives into a
`<suite>-drives` member suite. [AGENTS.md](AGENTS.md) is the one-screen build
guide, and [BUILD-NOTES.md](BUILD-NOTES.md) covers the build itself.

## Conventions

- TypeScript strict with zero diagnostics: the build does not type-check, so
  `bun run typecheck` is the floor.
- One concern per commit, with a message that says why.
- The check nearest the change runs first; `bun run verify` closes.
- Generated files (the third-party notices, the captured baselines) are
  regenerated from their sources, never edited by hand.
- Documentation describes what Mercury does, in the present tense.

## Licence

The licence is [LICENSE.md](LICENSE.md).
