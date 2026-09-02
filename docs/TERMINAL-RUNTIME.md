# Terminal runtime

How the built product boots, where deployed copies live, how updates land,
and how a broken boot recovers. The build that produces the artifact is
`BUILD-NOTES.md`; this page is the running side.

## One bundle, several routes

`dist/mercury.mjs` runs on Node (one owned supported range; the entry gate
refuses anything else on every route). The same bundle serves every route:
`--version`; the language-service sidecars and the TCP bridge; `daemon`
(background workers); `acp` (the editor-bridge stdio protocol); and the
command estate — interactive boot, `-p`/`--print`, `update`, `install`,
`doctor` (the CLI alias of `/health`), `editor`, and the rest. A lone
`--update`/`--upgrade` splices into `update`. On interactive boots the
crash handlers are armed before any route does async work.

## The deployed runtime

A source copy is installed by deploying its build; the launcher never boots
the repository's `dist/` directly, because a mid-build bundle must not
hot-swap a running product:

- `bash scripts/ops/deploy-runtime.sh` publishes the build to
  `<config-home>/runtime/dist`. It takes only a committed tree's own build:
  the working tree must be clean and the bundle must match its manifest.
  The previous runtime is kept beside it as `runtime/dist.prev` for a
  manual rollback; nothing boots it on its own.
- `bash scripts/ops/deploy-launcher.sh` installs the `mercury` launcher at
  `<config-home>/bin/mercury`; put that directory on your `PATH`.

The launcher resolves the config home without creating one —
`MERCURY_CONFIG_DIR`, then `MERCURY_HOME`, else `~/.mercury` — and boots
`<config-home>/runtime/dist/mercury.mjs`; `MERCURY_DIST` points a
development boot at another bundle. A missing deployed runtime is a loud
refusal card naming the deploy command, exit 66 — never a silent fallback
onto stale bits. When the deployed runtime is older than the repository
HEAD, the launcher prints a calm one-line drift note and continues.

On an interactive boot the launcher paints the enter screen before the main
bundle loads (release archives carry it as `splash.mjs` + `splash-core.mjs`);
print, help and version runs and non-TTY invocations skip it, and
`MERCURY_SPLASH=off` skips it always.

## The release install (the versioned layout)

Release archives use a user-local, versioned layout instead — understandable without
developer tools:

```
<config-home>/versions/<version>/ # a complete release payload each
<config-home>/versions/current.txt # ONE line: the active version
<config-home>/versions/previous.txt # ONE line: the last active version
<config-home>/versions/.update.lock/ # single-update mutex
```

plus one stable `mercury` shim in a conventional user-local bin directory
that resolves `current.txt` at every run. Updates and rollbacks switch the
pointer file by atomic rename, never the shim; manual recovery is editing
`current.txt`. Configuration and sessions live in the config home outside
this root — install, update, rollback, and uninstall never touch them.

`mercury install`, run from an extracted archive's own launcher,
self-adopts that payload into the layout: idempotent, no administrator
access. `--dry-run` previews, `--uninstall` removes managed binaries only
(and says what it preserved), `--force` replaces a pre-existing non-managed
command at the stable path with a `.bak` kept — without it, a foreign
command is refused, not clobbered. `--json` on every verb.

## `mercury update`

`mercury update` speaks only to the private release repository through the
collaborator's own signed-in `gh` — there is no anonymous endpoint and no
other delivery path. Verbs:
`--check`, `--status`, `--rollback`, `--json`; stdout carries the result,
stderr the progress; exit 0 includes "already current", 1 is operational
failure, 2 is usage.

The activation law:

1. single-update lock;
2. download + checksum verify (same-release `SHA256SUMS.txt` only);
3. extract → layout judgement;
4. embedded-version equality (manifest + a staged `--version` smoke);
5. stage into `versions/<v>` — never touching the active version;
6. atomic pointer switch, previous retained;
7. post-switch smoke — failure restores the pointer automatically.

Every refusal leaves the active installation untouched and names its
recovery. Output lines never carry GitHub access material.

A quiet once-a-day update notice performs the same
release-list read, deferred past first paint, silent on every failure, and
renders one expiring line ("vX.Y.Z available — mercury update") in the
existing notice surface. It sends nothing about the machine or the
operator; `MERCURY_UPDATE_NOTICE=0` disables it.

## Boot recovery

- **The boot beacon**. The splash stamps
  every interactive handoff into `<config-home>/boot-attempts.json` before
  the runtime starts, and the runtime clears the file at completed
  interactive startup. Residue — attempts with no completed startup after
  them — at three or more is the bricked-boot signature; `mercury doctor`
  and the `update` verb surface it and name the recovery
  (`mercury update --rollback`). Reads are validated and fail-soft: the
  beacon is a lever, never a boot dependency.
- **Loud crash surface.** A rejection escaping `main()`, or a module-load
  failure reaching the process handlers, restores the terminal, prints a
  card (cause · consequence · next step · how to report), and exits 1.
  A stranded launcher alternate screen is released early on non-takeover
  exits.
- **Journaled operations.** Interrupted durable operations (multi-file
  change sets among them) reconcile deterministically at the next boot
  through the operation journal — see
  [CHANGE-TRANSACTIONS.md](CHANGE-TRANSACTIONS.md).
- **Provenance at boot.** Packaged launchers run the shipped
  `verify-artifact.mjs` on interactive boots — warn-only, never blocking; `/health` reports the same
  verification from in-bundle.

## Diagnostics

`mercury doctor` (the alias of the `/health` surface) renders the report
card; `doctor --json` and `--deep` are the machine and thorough forms, and
`doctor --fix` walks the guided remediations. Presentation resolves at
ingress, so piped invocations never mount the interactive renderer.
