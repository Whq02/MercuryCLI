# Contributing to Mercury

Thank you for reading Mercury closely enough to want to change it. This page
says how issues and pull requests work here, how to build and check a change,
and the few conventions the tree keeps.

## Issues

Issues are welcome through the tracker's templates; README.md's "Reporting a
problem" says what to paste. A security problem goes through the repository's
Security tab, never an issue: see [SECURITY.md](SECURITY.md).

## Pull requests

During the beta this repository takes issues, not pull requests. GitHub lets
anyone open a pull request against a public repository; one from outside the
collaborator set is closed with thanks and a pointer to an issue, and nothing
merges into main without the maintainer (the branch is protected). That is a
policy, not a judgement of anyone's work: if you have a change in mind, open an
issue that describes it, with the diff pasted in if you have one, and it will
be read.

## Building and checking a change

Build, run and check as [AGENTS.md](AGENTS.md) says: `bun run setup` once
(bun install plus the vendored packs), `bun run build.ts`, then the check
nearest the change while iterating; `bun run verify` closes and its exit
status is the verdict. [BUILD-NOTES.md](BUILD-NOTES.md) covers the build itself.

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
