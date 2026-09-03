# Mercury — building and running a local copy

Mercury is a terminal harness for software development. This file covers a copy
of the source — build, run, check, report a problem — not the internals. The
repository is https://github.com/Whq02/PreRelease; README.md is its front door.

## Prerequisites

A release install needs `git` only — the archive carries its own Node runtime.
Building from source needs Node `>=24.20.0 <25` (`.node-version` pins the patch
used for builds and vendored into archives; 24.20.0 carries the fix for
nodejs/node#56645 — below it a headless `-p` run that dispatched any tool aborts
at exit on Windows), bun 1.3.x (the build runtime, never vendored), and `git`.
On Windows, use Windows Terminal or PowerShell 7.

## Build and run

```sh
bun run setup                      # once; bun install + the five vendored packs
bun run build.ts                   # writes dist/mercury.mjs + dist/manifest.json
node dist/mercury.mjs --version
node dist/mercury.mjs              # the cockpit needs a real TTY, 100+ columns
node dist/mercury.mjs doctor --json
```

`setup` fetches the vendored packs (pyright · debugpy · js-debug · extra
grammars · this machine's Node runtime) and, with cargo present, builds the
voice capture addon; a skipped pack is named by the build and the doctor.

The first run walks theme and sign-in; `/logins` and `/accounts` manage
providers afterwards. Every interactive boot with no explicit journey lands on
the Boot face — the ten-row card: New Session, Continue Last Session (once
history exists), Boot Menu, MCPs & Skills, Agents, Doctor / Health Check,
Saturn Scheduler, Logins, Session Concourse, Sessions · Projects. A prompt
argument or `--continue`/`--resume` goes straight to the chat, and shift+←/→
walk only the screens that exist — from the chat, shift+← is the concourse and
then the face. The same artifact is a headless CLI: `node dist/mercury.mjs
--help` lists the verbs (`doctor`, `extensions`, `mcp`, `auth`, `daemon`,
`install`, `update`, and the rest). Windows runs `node dist\mercury.mjs`
directly; the guide is [docs/INSTALL-WINDOWS-FROM-SOURCE.md](docs/INSTALL-WINDOWS-FROM-SOURCE.md).

A fresh boot has no chat until you enter one: New Session creates it on Enter,
and closing every chat returns you to the Boot face. `mercury --chat` is the
plain world — the Boot face and a chat, no Session Concourse; `--concourse-off`
turns the concourse off for this and every later boot (a saved setting, turned
back by `--concourse-on` or `/config`). The lifecycle is [docs/SESSIONS.md](docs/SESSIONS.md).

## The launcher and the config home

- Configuration and sessions live in the config home: `~/.mercury`, or whatever
  `MERCURY_CONFIG_DIR` names. The build never writes there.
- `scripts/ops/deploy-runtime.sh` publishes a clean-tree build to
  `<config-home>/runtime/dist`; `scripts/ops/deploy-launcher.sh` installs the
  `mercury` launcher at `<config-home>/bin/mercury`. Put that directory on
  your `PATH`; `mercury --version` checks it. The launcher runs `MERCURY_NODE`,
  else the vendored `vendor/node` beside the build, else a PATH node. A missing
  runtime is a loud launcher failure, never a silent fallback.
- Release archives use `mercury install`, `mercury update`, and
  `mercury update --rollback` instead; they never touch the config home.

## Checks

```sh
bun run typecheck                  # strict; zero baseline
bash scripts/<suite>/run-all.sh    # one suite; they sit side by side under scripts/
bun run verify                     # every suite, pooled; exit 0 is green
bun run artifact:smoke             # the built bundle, isolated, outside the repo
```

Run the suite nearest your change; `bun run verify` closes — read its exit status. Hosted, the gate is two verdicts: `gate.yml` runs the deterministic suites and is the verdict a release carries; `drives.yml` runs the real-terminal suites and reports on its own.

## Reporting a problem

Open an issue at https://github.com/Whq02/PreRelease/issues through one of its
templates (bug · provider or model report · feature request) with the
`--version` line, the OS and terminal, the exact steps, and the output of
`node dist/mercury.mjs doctor --json` (`mercury doctor --json` for a release
install). A pasted transcript of the failing screen helps. A security problem
goes through the repository's Security tab (see SECURITY.md), never an issue.
