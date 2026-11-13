# Mercury — building and running a local copy

Mercury is a terminal harness for software development. Repository: https://github.com/Whq02/MercuryCLI (`README.md` is the front door; `docs/README.md` indexes guides by task).

## Prerequisites

A release install needs `git` only — the archive bundles Node. Building from source needs Node `>=24.20.0 <25` (`.node-version` pins the vendored patch; below 24.20.0 a headless tool run aborts at exit on Windows), bun 1.4.4 (build runtime, never vendored), and `git`. On Windows, use PowerShell 7 in Windows Terminal or the VS Code terminal.

## Build and run

```sh
bun run setup                      # once; bun install + vendored packs
bun run build.ts                   # writes dist/mercury.mjs + dist/manifest.json
node dist/mercury.mjs --version
node dist/mercury.mjs
node dist/mercury.mjs health --json
```

`setup` fetches the vendored packs (`pdfjs` · `pyright` · `debugpy` · `js-debug` · `grammars` · platform Node and Python · `brush` shell engine), builds the `cargo` addons (voice capture, desktop driver for computer use, `native/embed` + 118 MB model), and with `cmake` + `cargo` builds the on-device transcriber; `health` names any skipped pack.

Interactive sessions need a TTY (full layout from 100×26, compact below; first run walks theme and sign-in) and open on the Boot face: New Session, Continue Last Session (once history exists), Boot Menu, MCPs & Skills, Agents, Health Check, Saturn Scheduler, Logins, Session Concourse, Sessions · Projects. Screen routing and boot flags: [docs/SESSIONS.md](docs/SESSIONS.md); headless verbs: `node dist/mercury.mjs --help`; Windows source builds (`node dist\mercury.mjs`): [docs/INSTALL-WINDOWS-FROM-SOURCE.md](docs/INSTALL-WINDOWS-FROM-SOURCE.md).

## The launcher and the config home

Config and sessions live in `~/.mercury` (or `MERCURY_CONFIG_DIR`); the build never writes there. `scripts/ops/deploy-runtime.sh` publishes a clean build to `<config-home>/runtime/builds/<build>` behind `runtime/current` (`runtime/dist`), and `scripts/ops/deploy-launcher.sh` writes `<config-home>/bin/mercury` (add to `PATH`; check with `mercury --version`). The launcher resolves `MERCURY_NODE`, else vendored `vendor/node`, else `PATH` `node`, failing loudly if none exists. Release installs use `mercury install` and `mercury update` (`README.md`, Install) without touching sessions.

## Checks

```sh
bun run typecheck                  # strict; zero new diagnostics
bash scripts/<suite>/run-all.sh    # one suite under scripts/
bun run verify                     # every non-drive suite, pooled; exit 0 is green
bash scripts/run-drives.sh         # drive suites (*-drives), run once
bun run artifact:smoke             # isolated built-bundle smoke check
```

Iterate with the nearest suite and close with `bun run verify`. Suites use a fresh scratch config home unless `MERCURY_CONFIG_DIR` is set — never `~/.mercury`. `git config core.hooksPath .githooks` turns on the committed pre-push guard; the build never sets it. Build details live in `BUILD-NOTES.md`. Retired spellings (flags, keys, env vars, commands, words, paths) fail as unknown input with no alias, custom refusal, or migration, appearing only in the identity suite's forbidden lists.

## Reporting a problem

Run `/bug <what happened>` inside Mercury to preview and file via signed-in `gh`, or use the issue templates in `README.md` ("Reporting a problem"). Report vulnerabilities via the GitHub Security tab ([SECURITY.md](SECURITY.md)), never a public issue.
