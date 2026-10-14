# Terminal runtime

How the built product boots, where deployed and release copies live, how
`mercury update` and the background daemon work, and how the shell engine runs.

## One bundle, several routes

`dist/mercury.mjs` runs on Node 24 LTS (`>=24.20.0 <25`). Every launcher
selects Node in one order: `MERCURY_NODE` (an explicit binary), the vendored
runtime beside the bundle (`vendor/node/bin/node`; `vendor\node\node.exe` on
Windows, included in every release archive and fetched in source checkouts by
`bun run setup`), then a `node` on `PATH`. Missing or unsupported binaries
refuse with the three rungs named (exit 127 when none answers). Child processes
spawn on the same resolved Node binary.

The same bundle serves `--version`, the language-service sidecars and TCP
bridge, `daemon` (background session host and scheduler), `runner` (a hosted
session over JSON-RPC 2.0 on stdio), `acp` (Agent Client Protocol editor host,
spawning a runner child per session), and the CLI commands (`run`, `update`,
`install`, `health`, and interactive boot). Interactive boots arm crash
handlers before async work begins.

## The deployed runtime

A source checkout is installed by deploying its build so a mid-build `dist/`
never hot-swaps a running session:

- `bash scripts/ops/deploy-runtime.sh` publishes a clean-tree build whose
  bundle matches its manifest into `<config-home>/runtime/builds/<tree>-<bundle>`
  and switches `runtime/current` (and the legacy link `runtime/dist`) by atomic
  rename, alongside the launcher and enter screen. Folders with a live daemon
  or session are left in place until a later deploy finds them idle. A running
  daemon keeps serving its existing sessions until the last one exits, while
  new sessions start on the new build's daemon. Manual rollback:
  `cd <config-home>/runtime && ln -sfn builds/<older> current && ln -sfn builds/<older> dist`.
- `bash scripts/ops/deploy-launcher.sh` installs `<config-home>/bin/mercury`;
  add that directory to `PATH`.

The launcher resolves the config home (`MERCURY_CONFIG_DIR`, `MERCURY_HOME`, or
`~/.mercury`) without creating it and boots `<config-home>/runtime/current/mercury.mjs`
(or `runtime/dist/mercury.mjs`, or `MERCURY_DIST` when set). If the deployed
runtime is missing, it refuses with exit 66 and names the deploy command; if
older than repository `HEAD`, it prints a one-line drift note and continues.
Config homes belonging to other tools (`~/.codex`, `~/.gemini`, `~/.copilot`,
`~/.cursor`, `~/.kiro`, `~/.cline`, `~/.continue`, `~/.qwen`, `~/.pi`, `~/.omp`,
`~/.config/opencode`, `~/.config/amp`, `~/.config/goose`) are never used for
Mercury sign-in or billing.

On interactive boots without arguments, the launcher runs the enter screen
(`splash.mjs` + `splash-core.mjs`, also run by bare `node dist/mercury.mjs`);
`run`, help and version runs, non-TTY invocations, and `MERCURY_SPLASH=off`
skip it. Splash exit code `0` hands over inside the held alternate screen, `20`
hands over with the screen restored, `130` cancels boot, and any other exit
code heals the terminal state and boots plain. Handover sets one-shot
`MERCURY_SPLASH_HANDOFF` and reads `splash-action.json`, deleting both before
spawning children.

## The release install (the versioned layout)

Release archives use a user-local versioned layout:

```
<config-home>/versions/<version>/    # complete release payload
<config-home>/versions/current.txt   # active version (one line)
<config-home>/versions/previous.txt  # previous version (one line)
<config-home>/versions/.update.lock/ # single-update mutex
```

A stable `mercury` shim in `~/.local/bin` (or `%LOCALAPPDATA%\Mercury\bin` on
Windows) reads `current.txt` on each run. Updates and rollbacks switch
`current.txt` atomically without touching settings or sessions. Each payload
includes its own `vendor/node` runtime recorded in `manifest.json`; install and
update verify the runtime with a `--version` check before activation, and
`mercury health --deep` (or `verify-artifact.mjs --deep`) verifies binary
digests.

Running `mercury install` from an extracted archive adopts that payload into
the versioned layout and adds the bin directory to `PATH` once (no
administrator rights needed). `--dry-run` previews the install, `--uninstall`
removes managed binaries while keeping config and sessions, `--force` backs up
a non-managed binary at the target path to `.bak`, and `--json` outputs JSON.

## `mercury update` and the background daemon

`mercury update` (alias `upgrade`) reads GitHub Releases anonymously over
HTTPS, consulting a signed-in `gh` CLI only when anonymous access is refused
(such as a private channel or exhausted anonymous rate limit, whose reset time
is reported in minutes). Flags: `--check`, `--status`, `--rollback` and
`--json` (exit `0` when updated or already current, `1` on failure, `2` on
usage error).

- **Managed installs** (shell/PowerShell installer, `mercury install`, or the
  `mercury-tech-cli` npm/mise launcher, which installs into the managed layout
  on first run): `mercury update` downloads, verifies `SHA256SUMS.txt` and the
  Ed25519 release signature ([TRUST.md](TRUST.md)), stages into
  `versions/<v>`, switches `current.txt` atomically, and auto-restores
  `previous.txt` if the post-switch check fails.
- **Homebrew installs** (`Cellar/mercury/`): prompts `This Mercury was
  installed by Homebrew. Run brew upgrade Whq02/mercury/mercury now? [y/N]`
  (`--yes` skips the prompt; `--rollback` declines because Homebrew manages its
  own versions).
- **Source checkouts**: `--check` and `--status` report `a source checkout at
  <dist> · rebuild it with git pull && bun run build.ts`, and bare `update` or
  `--rollback` refuses before downloading.

After switching `current.txt`, `mercury update` and `--rollback` hand over the
background daemon and report the `background daemon:` state (`moved`, `moving`,
`when-idle`, `current`, `absent`, `stop` or `unknown` in `--json`). When live
sessions are running on the older daemon, the new build's daemon takes the
control socket for new sessions while the older daemon finishes its live
sessions and exits; open Mercury windows keep running on their startup build
until reopened. `mercury daemon restart` triggers the same handover manually.
In `mercury daemon status`, pre-booted runners in the warm pool are listed as
`warm runner · pre-booted, unclaimed` (and summarized on the `warm:` line) and
are never counted as live sessions.

Once a day after first paint, interactive sessions check the release list
against the managed install pointer and show `vX.Y.Z available · mercury
update` on the Boot face (once per release) and in the chat notice row. The
check sends nothing about the machine or the operator; `MERCURY_UPDATE_NOTICE=0`
disables the check, cache and both notices.

## Boot recovery

- **Boot beacon**: interactive handoffs record attempts in
  `<config-home>/boot-attempts.json`, cleared when startup completes; three or
  more incomplete attempts surface in `mercury health` and `mercury update`
  with the `mercury update --rollback` remedy.
- **Crash handler**: unhandled rejections or load failures restore the
  terminal, print cause, consequence, next step and reporting instructions, and
  exit 1.
- **Operation journal**: interrupted multi-file change sets reconcile at next
  boot ([CHANGE-TRANSACTIONS.md](CHANGE-TRANSACTIONS.md)); undecodable or
  mismatched journal files are left in place and named at startup without
  blocking other entries.
- **Artifact provenance**: packaged launchers run `verify-artifact.mjs`
  warn-only at interactive boot, and `/health` reports the same check.

## The shell engine

The Bash tool runs commands through either the **system** shell (default on
macOS and Linux, and on Windows when Git for Windows' `bash.exe` is present) or
the vendored **brush** engine (`dist/vendor/brush/<platform>/`, verified
against `vendor/brush.lock.json`, selected automatically on Windows when
`bash.exe` is absent). In both modes, the Bash tool tracks its own shell
working directory across calls: a `cd` inside a Bash command moves where
subsequent shell commands run without changing the session's starting folder.

Select the engine via `/config` (**Shell engine**, `shell.engine`: `system` or
`brush`) or `MERCURY_SHELL_ENGINE=brush`. With `brush` active, one persistent
brush process serves the main conversation and one serves each crewmate (up to
`shell.sessions`, default `8`, overridden by `MERCURY_SHELL_ENGINE_SESSIONS`),
preserving shell variables, functions, aliases and options between calls for
that owner alone; `run_in_background` calls always use a separate system shell.
On Windows, `brush` requires `cmd /c npm …` for `.cmd` shims and an absolute
program path after `cd`. `/health` reports the active shell on the **Bash tool
shell** (`shell`) and **Shell engine** (`iface-shell-engine`) rows.

Non-zero command exits report as errors except when the final pipeline stage is
a lookup or comparison (`grep`, `rg`, `find`, `pgrep`, `diff`, `cmp`, `test`,
`[`, `which`, `command -v`) exiting with code `1`, which returns a normal
result labelled with the exit meaning (`no matches found (exit code 1)`,
`files differ (exit code 1)`, `condition is false (exit code 1)`).

## Diagnostics

`mercury health` prints the diagnostic report (`--json` for machine output,
`--deep` for payload digest verification, `--fix` for guided remedies). See
[HEALTH-CERTIFICATE.md](HEALTH-CERTIFICATE.md).
