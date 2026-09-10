# Mercury — building and running a local copy

Mercury is a terminal harness for software development. This file covers a copy
of the source — build, run, check, report a problem — not the internals. The
repository is https://github.com/Whq02/MercuryCLI; README.md is its front door
and docs/README.md lists every page by task.

## Prerequisites

A release install needs `git` only — the archive carries its own Node runtime.
Building from source needs Node `>=24.20.0 <25` (`.node-version` pins the patch
the archives vendor; below 24.20.0 a headless run that dispatched a tool aborts
at exit on Windows), bun 1.3.x (the build runtime, never vendored), and `git`.
On Windows, use Windows Terminal or PowerShell 7.

## Build and run

```sh
bun run setup                      # once; bun install + the vendored packs
bun run build.ts                   # writes dist/mercury.mjs + dist/manifest.json
node dist/mercury.mjs --version
node dist/mercury.mjs              # the cockpit needs a real TTY, 100+ columns
node dist/mercury.mjs doctor --json
```

`setup` fetches the vendored packs (pyright · debugpy · js-debug · grammars ·
this machine's Node runtime · brush, the optional shell engine) and, with cargo
present, builds the voice capture addon and, with cmake beside it, the
on-device transcriber; with cargo it also builds the desktop driver addon
that computer use runs through, and a skipped pack is named by the doctor.

The first run walks theme and sign-in. Every interactive boot with no explicit
journey lands on the Boot face — the ten-row card: New Session,
Continue Last Session (once history exists), Boot Menu, MCPs & Skills, Agents,
Doctor / Health Check, Saturn Scheduler, Logins, Session Concourse,
Sessions · Projects. How the screens connect and the flags that shape a boot are
[docs/SESSIONS.md](docs/SESSIONS.md); `node dist/mercury.mjs --help` lists the
headless verbs. Windows runs `node dist\mercury.mjs` directly; the guide is
[docs/INSTALL-WINDOWS-FROM-SOURCE.md](docs/INSTALL-WINDOWS-FROM-SOURCE.md).

## The launcher and the config home

Configuration and sessions live in the config home: `~/.mercury`, or whatever
`MERCURY_CONFIG_DIR` names; the build never writes there. To make a build your
daily `mercury`, `scripts/ops/deploy-runtime.sh` publishes a clean-tree build to
`<config-home>/runtime/dist` and `scripts/ops/deploy-launcher.sh` installs the
launcher at `<config-home>/bin/mercury` — put that directory on your `PATH`;
`mercury --version` checks it. The launcher runs `MERCURY_NODE`, else the
vendored `vendor/node` beside the build, else a PATH node, and fails loudly
when none is there. A release install (README.md, Install) uses `mercury
install` and `mercury update` instead; neither touches sessions.

## Checks

```sh
bun run typecheck                  # strict; zero baseline
bash scripts/<suite>/run-all.sh    # one suite; they sit side by side under scripts/
bun run verify                     # every suite, pooled; exit 0 is green
bun run artifact:smoke             # the built bundle, isolated, outside the repo
```

Run the suite nearest your change while iterating; `bun run verify` closes,
and its exit status is the verdict. BUILD-NOTES.md covers the build itself.

## Reporting a problem

Inside Mercury, `/bug <what happened>` shows the exact report and files it
through your own signed-in `gh`; by hand, README.md ("Reporting a problem")
names the issue templates and what to paste. A security problem goes through
the repository's Security tab ([SECURITY.md](SECURITY.md)), never an issue.
