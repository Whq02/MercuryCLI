# Terminal runtime

How the built product boots, where deployed copies live, how updates land,
and how a broken boot recovers. The build that produces the artifact is
`BUILD-NOTES.md`; this page is the running side.

## One bundle, several routes

`dist/mercury.mjs` runs on Node (one owned supported range; the entry gate
refuses anything else on every route). Every launcher picks that Node in one
order, first hit wins: `MERCURY_NODE` (an explicit binary), the vendored
runtime beside the bundle (`vendor/node/bin/node`; `vendor\node\node.exe` on
Windows — every release archive carries one, and a source build carries one
once `bun run setup` fetched the pack), then a PATH `node`. No rung is
silent: a `MERCURY_NODE` naming a missing file refuses, an unsupported Node
is refused by name and range, and no rung at all prints all three. The
runtime spawns its own children through the Node it runs on, so the rung
the launcher picks is the runtime the whole session runs on. The same bundle serves every route:
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
`<config-home>/runtime/dist/mercury.mjs` on the Node it resolves the same
way the release launchers do (`MERCURY_NODE`, the vendored `vendor/node`
beside the deployed bundle, then a PATH node — no rung answering is a loud
card naming all three, exit 127); `MERCURY_DIST` points a development boot
at another bundle. A missing deployed runtime is a loud refusal card naming
the deploy command, exit 66 — never a silent fallback onto stale bits. When
the deployed runtime is older than the repository HEAD, the launcher prints
a calm one-line drift note and continues.

On an interactive boot the launcher paints the enter screen before the main
bundle loads (release archives carry it as `splash.mjs` + `splash-core.mjs`);
print, help and version runs and non-TTY invocations skip it, and
`MERCURY_SPLASH=off` skips it always. A direct `node dist/mercury.mjs` start
paints it too: the runtime runs the same asset itself — found beside the
bundle first (the ordinary build copies the pair there), then in the config
home, then in the source tree — and hands over by the launcher's own
exit-code contract, so the boot that follows is the same on both roads. A
start with any argument boots straight, and a launcher-started boot is never
splashed twice.

The handover is the splash's exit code, and nothing else: `0` hands over
inside a held alternate screen (the runtime takes the buffer over without
re-entering it), `20` hands over with the screen restored, `130` is a cancel
(the boot stands down), and any other code is an abnormal death — the
launcher heals the terminal in one bounded write (synchronized output closed,
alternate scroll off, the alternate screen left, the cursor shown, the
background handed back) and boots plain. A handover arms the one-shot marker
`MERCURY_SPLASH_HANDOFF`; the runtime then reads the enter-screen choice
(`splash-action.json` under the config home, matched to the launch's own id)
and deletes both, so no child ever inherits them. The launchers parse nothing
the splash writes.

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

Every payload carries its own Node runtime under `vendor/node`, and the
manifest records it (version, platform, the archive digest, the shipped
binary's digest): install and update refuse a payload whose declared runtime
is missing, every `--version` smoke runs on the payload's own runtime — so
the runtime a release ships is proven to run on this machine before it is
activated — and deep verification (`mercury doctor --deep`, the shipped
`verify-artifact.mjs --deep`) recomputes the binary's digest. `mercury
update --status` and `mercury doctor` name the runtime in use: the vendored
one, an explicit `MERCURY_NODE`, or a system node.

`mercury install`, run from an extracted archive's own launcher,
self-adopts that payload into the layout: idempotent, no administrator
access. `--dry-run` previews (and names the runtime the payload carries),
`--uninstall` removes managed binaries only
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
