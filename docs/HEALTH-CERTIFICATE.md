# The health certificate

`/health` (alias `/doctor`) certifies the install: runtime, settings, and
channel checked live, rolled into one verdict. The same certificate runs
headless as `mercury health` / `mercury doctor`. Configured MCP servers are
validated without being started.

The certificate holds three properties:

1. **Evidence-backed** — every check carries a mandatory `evidence` string
   naming the artifact, probe, or value consulted. No evidence means the check
   reads `unknown`, never a silent pass.
2. **Freshness-honest** — evidence that predates what it certifies (a gate
   verdict from an older HEAD, a certificate from before a resume) reads
   `stale`.
3. **A verdict** — `certified`, `caution`, or `fault`, with fixes ranked
   worst-first.

The report is strictly read-only against the harness: it consults gate helpers,
snapshots, small local artifacts, and OS metrics. It never runs a session,
never mutates state, and never echoes a credential; its only write is the
last-certificate summary described below.

## Checks and the verdict

A check's status is one of `ok`, `warn`, `fail`, `stale`, `unknown`, `off`, or
`info`; its probe kind is `functional` or `configuration`, and its depth `fast`
or `deep` (`--deep` runs the deep inventory). The roll-up rule: any `fail`
makes the verdict `fault`; otherwise any `warn`, `stale`, or `unknown` makes it
`caution`; otherwise `certified`. `off` and `info` are neutral by doctrine and
never raise the verdict.

A fast run certifies these sections (section id · title):

| id | title |
| --- | --- |
| `identity` | IDENTITY |
| `proofs` | PROOFS |
| `git` | GIT |
| `crew` | CREW & DAEMONS |
| `memory` | MEMORY & CONTEXT |
| `settings` | SETTINGS & FLAGS |
| `auth` | AUTH |
| `interface` | INTERFACE |
| `runtime` | RUNTIME |
| `durability` | DURABILITY |
| `native-ownership` | TERMINAL RUNTIME |
| `profile` | PROFILE |
| `coding-loop-fast` | CODING LOOP |
| `flux` | TERMINAL FLUIDITY |
| `tool-capability-fast` | TOOL CAPABILITY |
| `router-fast` | ROUTER |
| `architecture-fast` | ARCHITECTURE PRIMITIVES |

RUNTIME's `Device headroom` row is joined by `Box lock`: the coordination
directory of the box lock (`MERCURY_BOX_LOCK_DIR`), the slots held and by
whom, and the tickets waiting — or the plain word that no lock directory is
named. The resource `mercury://health/box` gives an agent the same reading
live. The memory figure on the box row is the last sample the process took,
with the clock it was taken at and its source (`vm_stat`, `meminfo`, the
Windows counter, or the runtime's own free figure before any sample); a
facts answer never takes a sample, and `mercury://health/box` takes a fresh
one.

RUNTIME's `OS Bash sandbox` row reads the one OS-level boundary in the stack.
Off, the shipped default, reads `info`: `off — Bash runs unconfined (no OS
filesystem/network boundary)`. Enabled but unavailable (an unsupported
platform, a platform left out of `sandbox.enabledPlatforms`, a missing
dependency) reads `warn` with the reason. On, the row names what confines
Bash. On macOS it reads `ON — Bash filesystem + network confined
(seatbelt/bubblewrap)`. On Linux and WSL2 it also says what the sandbox does
about unix sockets, read from the apply-seccomp helper the sandbox resolves
beside the bundle (the Linux archive ships it under `vendor/seccomp/<arch>/`):
`ON — Bash filesystem + network confined (bubblewrap; unix sockets blocked)`
with the helper found; `ON — Bash filesystem + network confined (bubblewrap;
unix sockets open — no seccomp helper)` without it; and `ON — Bash filesystem
+ network confined (bubblewrap; unix sockets open —
sandbox.network.allowAllUnixSockets)` when that setting tells the sandbox to
skip the filter. The `/sandbox` dependencies tab shows the same helper as its
`seccomp filter` row.

TOOL CAPABILITY carries the `Tools withheld` check: every built-in tool kept
out of the model's catalog because a machine dependency is absent — a debug
adapter for Debug, a Godot executable for Godot, the desktop driver for
Computer, the search binary for Grep and Glob — with why and the remedy;
the withheld tools also appear in `readiness[]` as `tool:withheld:<name>`
rows. With nothing withheld the row says so and names what it checks. The
row waits for the debug adapter's toolchain probes to answer, so it never
names the Debug tool as withheld for a probe still in flight.

SETTINGS & FLAGS carries the `Env overrides` check: the registered flags
set in the environment, with Mercury's own stamps and the boot's saved
defaults named apart from the operator's overrides. A retired setting
still set (`MERCURY_GODOT_TOOLS_PORT` or `MERCURY_GODOT_TOOLS_TOKEN`,
which nothing reads since every Godot instance carries its own port and
token in its descriptor) turns the row to `warn`, names the setting and
what replaced it or that nothing did, and the fix says to unset it. The
flag registry's retired table is the one list of such settings; a
retired name is never a registered flag.

AUTH carries the `Model lists` row: for every provider family Mercury
carries typed model ids for (Anthropic, OpenAI, Z.AI, Moonshot, DeepSeek,
Gemini, Hugging Face), whether each typed id is still served by the live
model list the product has already read for that family's signed-in source.
The row never fetches: it reads the catalogue the picker, a chat naming the
family or a sub-agent launch already cached, so a family nothing has asked
about reads `no list read in this process`, a family without a credential
reads `no credential`, a family whose provider publishes no list (Z.AI,
Moonshot) reads `no live list — typed table dated <date>`, and Anthropic
reads `no list read` because Mercury reads no Anthropic list. The evidence
line is `served <n> · not served <m> · lists read <k> of <r>`; the detail
names one line per family and, beneath a family whose list lacks a typed id,
the ids it lacks. The row reads `ok` when every typed id a read list can
judge is served, `warn` when a read list lacks one, `info` when no list has
been read in this process or no signed-in family has a live list, and
`unknown` only when a cached list could not be read. A headless
`mercury doctor` is a fresh process, so its row reads what that process has
read, which is nothing, and never rolls the certificate to caution for a list
nobody asked for; the release-day check
(`bun scripts/ops/check-typed-model-ids.ts`) fetches every list live and
uses the same comparison.

CREW & DAEMONS carries the `Store isolation` check, which reads the config
home's harness records by Mercury's own fingerprint: a daemon-plane record carrying no Mercury
fingerprint was written by another tool and is reported with its evidence
line — named when the signature table recognizes the writer (the agent CLIs
and SDKs it knows), reported as unrecognized otherwise. An older Mercury's
records are Mercury's own; version variance is never foreignness. The check's remedy archives the foreign records into a
dated directory inside the home — reversible, nothing deleted.

CREW & DAEMONS also carries `Mercury processes`, the process sweep: it lists
Mercury's own processes on this box and classes each one by Mercury's own
facts — running · stale · cannot end · not ours — never by a parent pid. A
window is read by its own registration (`<config home>/processes/`, a pid, a
birth token and a heartbeat the cockpit writes and clears at exit) and by
whether a live shell still owns its terminal; a daemon by its supervisor
record, its owner, its live sessions, schedules and persistence; a runner by
the daemon's roster and its session's seat. Any live fact keeps a process
running; an explicit or persistent daemon is never stale; a process whose
facts cannot be read cannot be ended and says why. The row's evidence is the
four counts; its trail lists each stale and cannot-end process as
`pid <pid> · <terminal or no terminal> · <age> · <reason>`. The sweep runs
read-only at every daemon boot and window boot (a census under
`<config home>/processes/census.json`); nothing is ever ended on its own. The
row's destructive remedy shows exactly that list and asks `End these <N>
stale processes?`; it ends them through Mercury's own roads first (the daemon
re-checks identity and staleness inside itself before its shutdown or kill),
then a termination signal, a bounded wait (`MERCURY_PROCESS_SWEEP_WAIT_MS`;
the closure allowance before a window, runner or daemon may read stale is
the park drain, `MERCURY_SESSION_PARK_DRAIN_MINUTES`),
then a kill signal, re-reading identity and staleness before each step (a daemon that does not answer the end request for its own plane refuses it: nothing is sent), and
reports `Ended <N> stale processes; <N> could not be ended; <N> left running`;
a survivor of the kill signal reads `cannot end — needs a reboot`. Headless,
`mercury doctor processes` prints the same listing as JSON and `--end-stale`
ends the stale ones it lists; `mercury health --fix --yes` applies this
destructive remedy like any other. A process table that cannot be read whole
is an incomplete census: nothing is listed, nothing is pruned, nothing is
ended. Windows reads the list and ends nothing.

## Fixes

Checks can carry an executable remedy — `{plan, apply, verify}` — and a remedy
is offered only for statuses that assert something is wrong (`fail`, `warn`,
`stale`); `ok`, `info`, `off`, and `unknown` rows never expose apply. The fix engine
applies a remedy and then re-probes with `verify()` — the outcome the operator
sees is the verification, never apply's self-report. Every applied fix writes an
evolution-ledger row, so the improvement history is auditable.

Consent: in the interactive panel a fix goes through a consent card, and
destructive remedies render the warning register. Headless, `mercury health
--fix` applies safe remedies and requires `--yes` for destructive ones.
`--only <id>` limits any headless form — the plain report, `--json`, `--fix`
— to one check.

## The doctor JSON

`mercury doctor --json` prints the certificate as one JSON document
(`certSchema` 2). A piped or redirected run is not this host's interactive
terminal: the terminal-profile row reads as environmental and never raises
the verdict. The document carries:

- `verdict`, `ranAt`, `version`, `durationMs`, `depth`;
- `head` — repo state at issue time: `{sha, branch, dirty}`, null fields when
  not a git repository;
- `nodeRuntime` — the runtime contract: `{observed, label, range, verdict}`
  with verdict `supported`, `too-old`, `unqualified-major`, `prerelease`, or
  `invalid`;
- `sections[]` — each `{id, title, checks[]}`, each check
  `{id, label, probe, depth, durationMs, evidence, evidenceAt, status}`;
- `readiness[]` — the capability-readiness rows: each
  `{id, kind, label, state, detail, source, lastCheckedAt, latencyMs}`, with
  kind one of `tool`, `mcp`, `lane`, `engine`, `extension`, `skill`, and state
  one of `ready`, `configured`, `degraded`, `disabled`, `unavailable`.

## Artifacts

The doctor state root is the project (`<project>/.mercury/`;
`MERCURY_DOCTOR_STATE_DIR` overrides it as the hermetic-isolation seam):

- `doctor/last-cert.json` — an atomic, best-effort summary written after each
  certificate; the certificate chip in the session chrome folds it in (a
  summary older than a day reads stale), and resume honesty reads it too.
  Skipped entirely when the certificate surface is gated off.
- `doctor/last-preflight.json` — the boot preflight's summary. The preflight
  (`MERCURY_BOOT_PREFLIGHT`) runs a cheap subset of `/health` after the UI
  mounts and notifies only on a fault; it is not a certificate and never
  writes `last-cert.json`.
- `gate/verdict.json` — written by the local verification pool (`bun run
  verify`); the PROOFS section reads it as evidence and
  reports it `stale` when it predates the current HEAD.

## Gates

The certificate surface, the fix engine, and the boot preflight are default-on
and individually killable: `MERCURY_DOCTOR_CERT=0` restores a plain
install-diagnostics screen with no certificate and no artifact writes,
`MERCURY_DOCTOR_FIX=0` makes `/health` diagnose-only (no remedy offered
anywhere), and `MERCURY_BOOT_PREFLIGHT=0` skips the boot preflight entirely.
All three rows live in the in-code registry (`src/substrate/flagRegistry.ts`;
rendered on demand to an untracked path).
